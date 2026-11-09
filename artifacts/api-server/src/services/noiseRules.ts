import { and, asc, eq, sql } from "drizzle-orm";
import { db, noiseRulesTable, type NoiseRule as NoiseRuleRow, type Task as TaskRow } from "@workspace/db";
import type { TaskSource } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";

export const NOISE_MATCH_TYPES = [
  "from_address_equals",
  "from_domain_equals",
  "slack_channel_equals",
  "title_contains",
] as const;
export type NoiseMatchType = (typeof NOISE_MATCH_TYPES)[number];

/** Free email providers: a domain rule on these would hide real people, so it is never offered. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "icloud.com",
  "me.com",
  "yahoo.com",
  "yahoo.co.uk",
  "btinternet.com",
  "proton.me",
  "protonmail.com",
]);

export function noiseRuleLabel(matchType: NoiseMatchType, matchValue: string): string {
  switch (matchType) {
    case "from_address_equals":
      return `Emails from ${matchValue}`;
    case "from_domain_equals":
      return `Anything from @${matchValue}`;
    case "slack_channel_equals":
      return `Slack messages in #${matchValue.replace(/^#/, "")}`;
    case "title_contains":
      return `Titles containing "${matchValue}"`;
  }
}

export function toNoiseRuleView(r: NoiseRuleRow) {
  return { ...r, label: noiseRuleLabel(r.matchType, r.matchValue) };
}

export function normaliseMatchValue(matchType: NoiseMatchType, value: string): string {
  let v = value.trim().toLowerCase();
  if (matchType === "from_domain_equals") v = v.replace(/^.*@/, "");
  if (matchType === "slack_channel_equals") v = v.replace(/^#/, "");
  return v;
}

/** Rules that could be made from one item. Meeting actions are never auto-noised, so they get none. */
export function noiseRuleOptions(task: TaskRow): { matchType: NoiseMatchType; matchValue: string; label: string }[] {
  if (task.source === "meeting") return [];
  const out: { matchType: NoiseMatchType; matchValue: string }[] = [];
  const address = task.fromAddress?.trim().toLowerCase();
  if (address && address.includes("@")) {
    out.push({ matchType: "from_address_equals", matchValue: address });
    const domain = address.split("@")[1];
    if (domain && !PUBLIC_EMAIL_DOMAINS.has(domain)) out.push({ matchType: "from_domain_equals", matchValue: domain });
  }
  if (task.source === "slack" && task.sourceChannel?.trim()) {
    out.push({ matchType: "slack_channel_equals", matchValue: normaliseMatchValue("slack_channel_equals", task.sourceChannel) });
  }
  const titleBase = (task.sourceSubject ?? task.title).trim().toLowerCase();
  if (titleBase) out.push({ matchType: "title_contains", matchValue: titleBase.slice(0, 120) });
  return out.map((o) => ({ ...o, label: noiseRuleLabel(o.matchType, o.matchValue) }));
}

function ruleSource(matchType: NoiseMatchType, taskSource: TaskSource): TaskSource | null {
  if (matchType === "from_address_equals" || matchType === "from_domain_equals") return "email";
  if (matchType === "slack_channel_equals") return "slack";
  return taskSource === "manual" ? null : taskSource;
}

/**
 * Makes a rule, or re-enables the existing one with the same match.
 * Returns whether a new row was created, so undo can remove it again.
 */
export async function upsertNoiseRule(
  tx: DbOrTx,
  input: { matchType: NoiseMatchType; matchValue: string; fromTask: TaskRow },
  actor: string,
): Promise<{ rule: NoiseRuleRow; created: boolean }> {
  const matchValue = normaliseMatchValue(input.matchType, input.matchValue);
  const [existing] = await tx
    .select()
    .from(noiseRulesTable)
    .where(and(eq(noiseRulesTable.matchType, input.matchType), eq(noiseRulesTable.matchValue, matchValue)));
  if (existing) {
    if (existing.enabled) return { rule: existing, created: false };
    const [rule] = await tx.update(noiseRulesTable).set({ enabled: true }).where(eq(noiseRulesTable.id, existing.id)).returning();
    await writeAudit(tx, { actor, action: "enable", entityType: "noise_rule", entityId: rule.id, payload: { fromTaskId: input.fromTask.id } });
    return { rule, created: false };
  }
  const [rule] = await tx
    .insert(noiseRulesTable)
    .values({
      matchType: input.matchType,
      matchValue,
      source: ruleSource(input.matchType, input.fromTask.source),
      createdFromTaskId: input.fromTask.id,
    })
    .returning();
  await writeAudit(tx, {
    actor,
    action: "create",
    entityType: "noise_rule",
    entityId: rule.id,
    payload: { matchType: rule.matchType, matchValue: rule.matchValue, fromTaskId: input.fromTask.id },
  });
  return { rule, created: true };
}

export async function listNoiseRules() {
  const rows = await db
    .select()
    .from(noiseRulesTable)
    .orderBy(sql`${noiseRulesTable.enabled} desc`, asc(noiseRulesTable.createdAt));
  return rows.map(toNoiseRuleView);
}

export async function setNoiseRuleEnabled(id: number, enabled: boolean, actor: string) {
  const [current] = await db.select().from(noiseRulesTable).where(eq(noiseRulesTable.id, id));
  if (!current) return null;
  if (current.enabled === enabled) return toNoiseRuleView(current);
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.update(noiseRulesTable).set({ enabled }).where(eq(noiseRulesTable.id, id)).returning();
    await writeAudit(tx, { actor, action: enabled ? "enable" : "disable", entityType: "noise_rule", entityId: id });
    return r;
  });
  return toNoiseRuleView(row);
}
