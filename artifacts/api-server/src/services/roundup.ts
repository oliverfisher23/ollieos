/**
 * The weekly round-up (Part O): what changed in the knowledge base over the week. Made when OllieOS
 * has fresh data after the chosen day and time (Fridays at 16:00 unless changed in Settings), or by
 * hand from the page. The page shows everything; the Gmail draft (no recipient, never sent) leaves
 * out anything confidential or hidden from AI.
 */
import { and, desc, eq, gte, inArray, lt, or } from "drizzle-orm";
import {
  appSettingsTable,
  db,
  decisionsTable,
  factReviewsTable,
  factsTable,
  playbooksTable,
  productsTable,
  rulesTable,
  suggestionsTable,
  weeklyRoundupsTable,
  type FactReview,
  type WeeklyRoundup,
} from "@workspace/db";
import { addDays, formatLong, londonDate, londonWallTimeToInstant, todayLondon, toRef, weekday } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { defaultScope, visibleRefs } from "../lib/ai-data/scope";
import { ACTOR, resolveEntities } from "./knowledge/common";
import { textOf } from "./knowledgeInbox";
import { saveGmailDraft } from "./connectors/gmail";
import { NotFoundError } from "./tasks";

/** "When: Any PwC material." with a full stop unless it already ends in one. */
const whenPart = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/* ---------- Settings ---------- */

export interface RoundupSchedule {
  /** 0 Sunday to 6 Saturday */
  day: number;
  hour: number;
}

export const DEFAULT_ROUNDUP: RoundupSchedule = { day: 5, hour: 16 };
const KEY = "weekly_roundup";

export async function getRoundupSchedule(): Promise<RoundupSchedule> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, KEY));
  return { ...DEFAULT_ROUNDUP, ...((row?.value as Partial<RoundupSchedule>) ?? {}) };
}

export async function setRoundupSchedule(input: RoundupSchedule): Promise<RoundupSchedule> {
  await db.transaction(async (tx) => {
    await tx
      .insert(appSettingsTable)
      .values({ key: KEY, value: input })
      .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: input, updatedAt: new Date() } });
    await writeAudit(tx, { actor: ACTOR, action: "update", payload: { setting: KEY, value: input } });
  });
  return input;
}

/** The most recent round-up time at or before now. */
export function lastRoundupTime(now: Date, s: RoundupSchedule): Date {
  const today = todayLondon(now);
  let day = addDays(today, -((weekday(today) - s.day + 7) % 7));
  let at = londonWallTimeToInstant(day, s.hour, 0);
  if (at > now) {
    day = addDays(day, -7);
    at = londonWallTimeToInstant(day, s.hour, 0);
  }
  return at;
}

/* ---------- Content ---------- */

export interface RoundupLine {
  text: string;
  /** What it is and where, or how it was settled */
  detail: string | null;
  /** Confidential or hidden from AI: shown on the page, left out of the Gmail draft */
  private: boolean;
}

export interface RoundupContent {
  approved: RoundupLine[];
  contradictions: RoundupLine[];
  stale: RoundupLine[];
  rules: RoundupLine[];
  playbooks: RoundupLine[];
  products: RoundupLine[];
}

export const SECTIONS: { key: keyof RoundupContent; title: string }[] = [
  { key: "approved", title: "Approved this week" },
  { key: "contradictions", title: "Contradictions and how each was settled" },
  { key: "stale", title: "What went stale" },
  { key: "rules", title: "New rules" },
  { key: "playbooks", title: "New playbooks" },
  { key: "products", title: "New products" },
];

const KIND_LABEL: Record<string, string> = {
  fact: "Fact",
  decision: "Decision",
  person: "New person",
  organisation: "New organisation",
  project: "New project",
  summary_change: "Change",
  document: "Document",
  playbook: "Playbook",
  cadence: "Cadence",
  relationship: "Relationship",
  rule: "Rule",
  product: "Product",
};

const OUTCOME: Record<string, string> = {
  new_right: "Settled: the new one was right",
  old_stands: "Settled: the old one stood",
  both_true: "Settled: both were true",
  keep: "Settled: one side kept",
  write_own: "Settled: you wrote your own",
  replaced_elsewhere: "Settled on the item's page",
  still_true: "Confirmed still true",
  edit: "Updated",
  no_longer_true: "Marked no longer true",
};

const outcomeOf = (r: FactReview, open: string) => (r.status === "pending" ? open : (OUTCOME[String((r.resolution as { action?: string } | null)?.action)] ?? "Settled"));

const where = (name: string | undefined) => (name ? ` on ${name}` : "");

export async function buildRoundupContent(start: Date, end: Date): Promise<RoundupContent> {
  const inWeek = <T>(col: T) => and(gte(col as never, start), lt(col as never, end));
  const [approved, reviews, rules, playbooks, products] = await Promise.all([
    db
      .select()
      .from(suggestionsTable)
      .where(and(inArray(suggestionsTable.status, ["approved", "merged"]), inWeek(suggestionsTable.decidedAt)))
      .orderBy(suggestionsTable.decidedAt),
    db
      .select()
      .from(factReviewsTable)
      .where(or(inWeek(factReviewsTable.createdAt), inWeek(factReviewsTable.resolvedAt)))
      .orderBy(factReviewsTable.createdAt),
    db.select().from(rulesTable).where(inWeek(rulesTable.createdAt)).orderBy(rulesTable.createdAt),
    db.select().from(playbooksTable).where(inWeek(playbooksTable.createdAt)).orderBy(playbooksTable.createdAt),
    db.select().from(productsTable).where(inWeek(productsTable.createdAt)).orderBy(productsTable.createdAt),
  ]);

  // Everything the reviews point at, whatever its state now.
  const cardIds = reviews.map((r) => r.suggestionId).filter((x): x is number => x != null);
  const items = reviews.flatMap((r) => r.contradicts ?? []);
  const ids = (t: string) => [...new Set(items.filter((i) => i.type === t).map((i) => i.id))];
  const factIds = [...new Set([...reviews.flatMap((r) => r.factIds), ...ids("fact")])];
  const [cards, facts, decisions, ruleRows] = await Promise.all([
    cardIds.length ? db.select().from(suggestionsTable).where(inArray(suggestionsTable.id, cardIds)) : ([] as (typeof suggestionsTable.$inferSelect)[]),
    factIds.length ? db.select().from(factsTable).where(inArray(factsTable.id, factIds)) : ([] as (typeof factsTable.$inferSelect)[]),
    ids("decision").length ? db.select().from(decisionsTable).where(inArray(decisionsTable.id, ids("decision"))) : ([] as (typeof decisionsTable.$inferSelect)[]),
    ids("rule").length ? db.select().from(rulesTable).where(inArray(rulesTable.id, ids("rule"))) : ([] as (typeof rulesTable.$inferSelect)[]),
  ]);

  const entityRefs = [
    ...approved.filter((s) => s.entityType && s.entityId != null).map((s) => ({ type: s.entityType!, id: s.entityId! })),
    ...cards.filter((s) => s.entityType && s.entityId != null).map((s) => ({ type: s.entityType!, id: s.entityId! })),
    ...facts.map((f) => ({ type: f.entityType, id: f.entityId })),
  ];
  const names = await resolveEntities(entityRefs);
  const nameOf = (type: string | null, id: number | null) => (type && id != null ? names.get(`${type}:${id}`)?.name : undefined);

  // Which refs AI may see; anything else stays out of the draft.
  const refsOf = {
    approved: (s: (typeof approved)[number]) => [
      s.resultType && s.resultId != null ? `${s.resultType}:${s.resultId}` : null,
      s.entityType && s.entityId != null ? `${s.entityType}:${s.entityId}` : null,
    ],
  };
  const allRefs = new Set<string>();
  for (const s of approved) refsOf.approved(s).forEach((r) => r && allRefs.add(r));
  for (const s of cards) if (s.entityType && s.entityId != null) allRefs.add(`${s.entityType}:${s.entityId}`);
  for (const i of items) allRefs.add(`${i.type}:${i.id}`);
  for (const id of factIds) allRefs.add(`fact:${id}`);
  for (const r of rules) allRefs.add(toRef("rule", r.id));
  for (const p of playbooks) allRefs.add(toRef("playbook", p.id));
  for (const p of products) allRefs.add(toRef("product", p.id));
  const visible = await visibleRefs(defaultScope(), [...allRefs]);
  const hidden = (refs: (string | null)[]) => refs.some((r) => r != null && !visible.has(r));

  const content: RoundupContent = { approved: [], contradictions: [], stale: [], rules: [], playbooks: [], products: [] };

  for (const s of approved) {
    const conf = (s.payload as { confidential?: boolean | null }).confidential === true;
    content.approved.push({
      text: textOf(s),
      detail: `${KIND_LABEL[s.kind] ?? s.kind}${where(nameOf(s.entityType, s.entityId))}${s.status === "merged" ? ", same as one already there" : ""}`,
      private: conf || hidden(refsOf.approved(s)),
    });
  }

  const itemText = (type: string, id: number) => {
    if (type === "fact") return facts.find((f) => f.id === id)?.text;
    if (type === "decision") return decisions.find((d) => d.id === id)?.text;
    const r = ruleRows.find((x) => x.id === id);
    return r ? `${r.title}: ${r.rule}` : undefined;
  };
  for (const r of reviews) {
    if (r.kind === "stale") {
      if (r.createdAt < start || r.createdAt >= end) continue;
      const f = facts.find((x) => x.id === r.factIds[0]);
      if (!f) continue;
      content.stale.push({ text: f.text, detail: `Fact${where(nameOf(f.entityType, f.entityId))}. ${outcomeOf(r, "Still waiting for a check")}`, private: hidden([`fact:${f.id}`]) });
      continue;
    }
    const card = cards.find((s) => s.id === r.suggestionId);
    const sides =
      r.kind === "contradiction"
        ? (r.contradicts ?? []).map((i) => ({ ref: `${i.type}:${i.id}`, text: itemText(i.type, i.id) }))
        : r.factIds.map((id) => ({ ref: `fact:${id}`, text: itemText("fact", id) }));
    const known = sides.filter((x): x is { ref: string; text: string } => !!x.text);
    if (!known.length) continue;
    const about = card ? nameOf(card.entityType, card.entityId) : (() => {
      const f = facts.find((x) => x.id === r.factIds[0]);
      return f ? nameOf(f.entityType, f.entityId) : undefined;
    })();
    content.contradictions.push({
      text: card ? `${textOf(card)} (versus: ${known.map((k) => k.text).join("; ")})` : known.map((k) => k.text).join(" versus "),
      detail: `${r.kind === "contradiction" ? "Contradiction" : "Two facts disagreed"}${where(about)}. ${outcomeOf(r, "Still open")}`,
      private:
        (card ? (card.payload as { confidential?: boolean | null }).confidential === true : false) ||
        hidden([...known.map((k) => k.ref), card?.entityType && card.entityId != null ? `${card.entityType}:${card.entityId}` : null]),
    });
  }

  for (const r of rules) content.rules.push({ text: r.title, detail: `When: ${whenPart(r.appliesWhen)} ${r.rule}${r.enabled ? "" : " (switched off)"}`, private: hidden([toRef("rule", r.id)]) });
  for (const p of playbooks) content.playbooks.push({ text: p.title, detail: `When to use: ${p.whenToUse}`, private: hidden([toRef("playbook", p.id)]) });
  for (const p of products) content.products.push({ text: p.name, detail: p.summary ?? p.description ?? null, private: hidden([toRef("product", p.id)]) });
  return content;
}

/* ---------- Making them ---------- */

export interface RoundupView {
  id: number;
  weekStart: Date;
  weekEnd: Date;
  manual: boolean;
  createdAt: Date;
  draftSaved: boolean;
  content: RoundupContent;
}

const view = (r: WeeklyRoundup): RoundupView => ({
  id: r.id,
  weekStart: r.weekStart,
  weekEnd: r.weekEnd,
  manual: r.manual,
  createdAt: r.createdAt,
  draftSaved: r.draftId != null,
  content: r.content as RoundupContent,
});

async function make(start: Date, end: Date, manual: boolean, now: Date): Promise<WeeklyRoundup> {
  const content = await buildRoundupContent(start, end);
  const [row] = await db
    .insert(weeklyRoundupsTable)
    .values({ weekStart: start, weekEnd: end, manual, content, createdAt: now })
    .onConflictDoUpdate({ target: weeklyRoundupsTable.weekEnd, set: { content, createdAt: now } })
    .returning();
  await writeAudit(db, { actor: manual ? ACTOR : "Weekly round-up", action: "create", payload: { roundup: row.id, manual } });
  return row;
}

/** Scheduled: makes this week's round-up once the chosen day and time have passed. */
export async function buildRoundupIfDue(now = new Date()): Promise<{ id: number } | null> {
  const end = lastRoundupTime(now, await getRoundupSchedule());
  const [done] = await db.select({ id: weeklyRoundupsTable.id }).from(weeklyRoundupsTable).where(eq(weeklyRoundupsTable.weekEnd, end));
  if (done) return null;
  const row = await make(new Date(end.getTime() - 7 * 86_400_000), end, false, now);
  return { id: row.id };
}

/** By hand from the page: the seven days up to now. */
export async function makeRoundupNow(now = new Date()): Promise<RoundupView> {
  return view(await make(new Date(now.getTime() - 7 * 86_400_000), now, true, now));
}

export async function listRoundups(): Promise<{ id: number; weekEnd: Date; manual: boolean }[]> {
  return db
    .select({ id: weeklyRoundupsTable.id, weekEnd: weeklyRoundupsTable.weekEnd, manual: weeklyRoundupsTable.manual })
    .from(weeklyRoundupsTable)
    .orderBy(desc(weeklyRoundupsTable.weekEnd))
    .limit(26);
}

export async function getRoundup(id?: number): Promise<RoundupView | null> {
  const [row] = id
    ? await db.select().from(weeklyRoundupsTable).where(eq(weeklyRoundupsTable.id, id))
    : await db.select().from(weeklyRoundupsTable).orderBy(desc(weeklyRoundupsTable.weekEnd)).limit(1);
  if (!row && id) throw new NotFoundError("That round-up does not exist");
  return row ? view(row) : null;
}

/** Only round-ups from the last six months are kept. */
export async function clearOldRoundups(now = new Date()): Promise<number> {
  const rows = await db
    .delete(weeklyRoundupsTable)
    .where(lt(weeklyRoundupsTable.weekEnd, new Date(now.getTime() - 183 * 86_400_000)))
    .returning({ id: weeklyRoundupsTable.id });
  return rows.length;
}

/* ---------- The Gmail draft ---------- */

/** The forwardable text: only what AI may see. */
export function roundupEmail(r: RoundupView): { subject: string; body: string } {
  const endDay = formatLong(londonDate(r.weekEnd), { withYear: true });
  const out: string[] = [`Knowledge round-up for the week to ${endDay}.`, ""];
  for (const s of SECTIONS) {
    const lines = r.content[s.key].filter((l) => !l.private);
    out.push(s.title);
    if (!lines.length) out.push("- Nothing this week.");
    for (const l of lines) out.push(`- ${l.text}${l.detail ? ` (${l.detail})` : ""}`);
    out.push("");
  }
  return { subject: `Weekly round-up: week to ${endDay}`, body: out.join("\n").trim() + "\n" };
}

/** Saves the round-up as a Gmail draft with no recipient. Never sends. Saving again updates the same draft. */
export async function saveRoundupDraft(id: number): Promise<{ saved: true }> {
  const [row] = await db.select().from(weeklyRoundupsTable).where(eq(weeklyRoundupsTable.id, id));
  if (!row) throw new NotFoundError("That round-up does not exist");
  const { subject, body } = roundupEmail(view(row));
  const draftId = await saveGmailDraft(null, row.draftId, { to: "", cc: "", subject, body, inReplyTo: null, references: null });
  await db.update(weeklyRoundupsTable).set({ draftId }).where(eq(weeklyRoundupsTable.id, id));
  await writeAudit(db, { actor: ACTOR, action: "draft", payload: { roundup: id } });
  return { saved: true };
}
