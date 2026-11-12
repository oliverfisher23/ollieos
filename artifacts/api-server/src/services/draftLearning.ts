/**
 * Part L (build plan section 14): rules learned from Ollie's edits, and checking a draft against his
 * rules.
 *
 * OllieOS keeps what it drafted (`reply_drafts.written_body`) and records what Ollie changed: when
 * he saves a changed draft from OllieOS, and when a Gmail check sees the sent email differs from the
 * draft (so edits made in Gmail or Superhuman count too). Once a week Sonnet looks for the same kind
 * of change made three or more times and proposes each as a rule in the Knowledge Inbox. Nothing
 * becomes a rule without approval.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { appSettingsTable, db, draftEditsTable, peopleTable, rulesTable, tasksTable } from "@workspace/db";
import { parseRef, toRef } from "@workspace/shared";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { recordReads, type AiScope } from "../lib/ai-data/scope";
import { logger } from "../lib/logger";
import { askScope } from "./ask/ask";
import { checkDraftAgainstRules, rulesFromEdits } from "./ask/model";
import { propose } from "./suggestions";
import { NotFoundError, ValidationError } from "./tasks";

export const RULES_PROPOSER = "Rules from your edits";
const LEARN_KEY = "rules_from_edits_last";
const WEEK = 7 * 86_400_000;
const PAIRS_WINDOW = 56 * 86_400_000;
const MAX_PAIRS = 40;

const norm = (t: string) => t.replace(/\s+/g, " ").trim();

/** Records an edit, once per task and kind (a later save of the same draft replaces it). */
export async function recordEdit(taskId: number, kind: "edited" | "sent", original: string | null, final: string): Promise<boolean> {
  if (!original || norm(original) === norm(final) || norm(final).length < 10) return false;
  const [cur] = await db.select({ id: draftEditsTable.id }).from(draftEditsTable).where(and(eq(draftEditsTable.taskId, taskId), eq(draftEditsTable.kind, kind)));
  if (cur) await db.update(draftEditsTable).set({ original, final, at: new Date() }).where(eq(draftEditsTable.id, cur.id));
  else await db.insert(draftEditsTable).values({ taskId, kind, original, final });
  return true;
}

/** Once a week, after the scheduled checks: proposes rules for changes made the same way three or more times. */
export async function learnRulesIfDue(now = new Date()): Promise<{ ran: boolean; proposed: number }> {
  const [last] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, LEARN_KEY));
  const at = (last?.value as { at?: string } | undefined)?.at;
  if (at && now.getTime() - Date.parse(at) < WEEK) return { ran: false, proposed: 0 };
  const proposed = await learnRulesFromEdits(now);
  const value = { at: now.toISOString(), proposed };
  await db.insert(appSettingsTable).values({ key: LEARN_KEY, value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  return { ran: true, proposed };
}

export async function learnRulesFromEdits(now = new Date()): Promise<number> {
  const pairs = await db
    .select()
    .from(draftEditsTable)
    .where(gte(draftEditsTable.at, new Date(now.getTime() - PAIRS_WINDOW)))
    .orderBy(desc(draftEditsTable.at))
    .limit(MAX_PAIRS);
  if (pairs.length < 3) return 0;
  const found = await rulesFromEdits(pairs.map((p) => ({ id: p.id, original: p.original, final: p.final })));
  const ids = new Set(pairs.map((p) => p.id));
  let made = 0;
  for (const r of found) {
    const examples = [...new Set(r.examples.filter((id) => ids.has(id)))];
    if (examples.length < 3 || !r.rule.trim() || !r.title.trim()) continue;
    try {
      const res = await propose(
        { proposedBy: RULES_PROPOSER, clientId: null, sourceType: "documents", sourceLabel: `Learned from ${examples.length} drafts you changed the same way` },
        { kind: "rule", payload: { title: r.title.trim(), applies_when: r.applies_when.trim() || "Any email drafted for you", rule: r.rule.trim() } },
        now,
      );
      if (res.status === "suggested") made++;
    } catch (err) {
      logger.warn({ err }, "Could not propose a rule from edits");
    }
  }
  return made;
}

export interface DraftIssue {
  ruleRef: string;
  ruleTitle: string;
  line: string;
  fix: string;
}

/** The lines of a draft that break a rule that applies, with a fix for each. Rules hidden from AI are never sent. */
export async function checkDraft(text: string, contextRefs: string[], scope?: AiScope): Promise<DraftIssue[]> {
  if (!norm(text)) throw new ValidationError("There is no draft to check");
  const s = scope ?? (await askScope());
  const ruleRefs = await applicableRuleRefs(s, contextRefs);
  if (!ruleRefs.length) return [];
  const docs = await loadVisibleDocs(s, ruleRefs);
  if (!docs.length) return [];
  await recordReads(s, docs.map((d) => d.ref), { via: "check_draft" });
  const raw = await checkDraftAgainstRules(text, docs);
  const ids = raw.map((i) => parseRef(i.rule.trim())).filter((r): r is NonNullable<typeof r> => r?.type === "rule").map((r) => r.id);
  const titles = ids.length ? new Map((await db.select({ id: rulesTable.id, title: rulesTable.title }).from(rulesTable)).map((r) => [toRef("rule", r.id), r.title])) : new Map<string, string>();
  return raw
    .filter((i) => titles.has(i.rule.trim()) && i.line.trim() && text.includes(i.line.trim()))
    .map((i) => ({ ruleRef: i.rule.trim(), ruleTitle: titles.get(i.rule.trim())!, line: i.line.trim(), fix: i.fix.trim() }));
}

/** "Fix these": each flagged line replaced by its fix, nothing else touched. */
export function applyFixes(text: string, issues: { line: string; fix: string }[]): string {
  let out = text;
  for (const i of issues) if (i.line && out.includes(i.line)) out = out.replace(i.line, i.fix);
  return out;
}

/** The refs a task's draft is about, for finding the rules that apply. */
export async function taskContextRefs(taskId: number): Promise<string[]> {
  const [t] = await db.select({ projectId: tasksTable.projectId, personId: tasksTable.personId, waitingOn: tasksTable.waitingOnPersonId }).from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!t) throw new NotFoundError("That task does not exist");
  const refs: string[] = [];
  if (t.projectId) refs.push(toRef("project", t.projectId));
  for (const pid of [t.personId, t.waitingOn]) {
    if (!pid) continue;
    refs.push(toRef("person", pid));
    const [p] = await db.select({ org: peopleTable.organisationId }).from(peopleTable).where(eq(peopleTable.id, pid));
    if (p?.org) refs.push(toRef("organisation", p.org));
  }
  return refs;
}
