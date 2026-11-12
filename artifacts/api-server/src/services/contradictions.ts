/**
 * Contradictions (Part O). Every new fact, decision or rule card is checked by Haiku against the
 * approved facts, decisions and rules about the same thing. A card that disagrees moves to the
 * Conflicts tab beside what it contradicts, and the approved items show "May be out of date"
 * until Ollie decides. Only items AI may see are sent; a card about something hidden is not sent.
 */
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db, decisionsTable, factReviewsTable, factsTable, linksTable, peopleTable, suggestionsTable, type ContradictedItem, type Suggestion } from "@workspace/db";
import { toRef } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { decisionVisible, factVisible } from "../lib/ai-data/visibility";
import { defaultScope, visibleRefs } from "../lib/ai-data/scope";
import { ruleContextFor, rulesFor } from "../lib/ai-data/direction";
import { resolveEntities } from "./knowledge/common";
import { judgeContradictions, type JudgeItem } from "./contradictionJudge";
import type { DecisionPayload, FactPayload, RulePayload } from "./suggestions";

/** Cards older than this are not checked (they were made before the check existed, or have waited long enough). */
const CHECK_WINDOW_DAYS = 14;
const MAX_FACTS = 60;
const MAX_DECISIONS = 40;
const MAX_RULES = 40;

export const CHECKED_KINDS = ["fact", "decision", "rule"] as const;

/* ---------- Which side looks stronger ---------- */

export interface Claimant {
  name: string;
  personId: number | null;
  isSelf: boolean;
}

export interface Weighing {
  stronger: "new" | "old" | "even";
  reason: string;
}

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const num = (n: number) => (n < WORDS.length ? WORDS[n] : String(n));

/** "three weeks", "ten days", "two months" */
export function span(days: number): string {
  const d = Math.max(1, Math.round(Math.abs(days)));
  if (d < 14) return `${num(d)} ${d === 1 ? "day" : "days"}`;
  if (d < 60) {
    const w = Math.round(d / 7);
    return `${num(w)} weeks`;
  }
  const m = Math.round(d / 30);
  return m >= 24 ? `${num(Math.round(m / 12))} years` : `${num(m)} months`;
}

/**
 * A claim is stronger when its speaker decides on the area (Ollie decides when nobody is named),
 * and when it is at least a week newer. Deciding counts for more than being newer.
 */
export function weigh(input: {
  area: string;
  deciders: ReadonlySet<number>;
  selfId: number | null;
  newBy: Claimant | null;
  newAt: Date;
  oldBy: Claimant | null;
  oldAt: Date;
}): Weighing {
  const decides = (c: Claimant | null) =>
    !!c && ((c.personId != null && input.deciders.has(c.personId)) || (input.deciders.size === 0 && (c.isSelf || (c.personId != null && c.personId === input.selfId))));
  const who = (c: Claimant) => (c.isSelf ? "you decide" : `${c.name} decides`);
  const newD = decides(input.newBy);
  const oldD = decides(input.oldBy);
  const days = (input.newAt.getTime() - input.oldAt.getTime()) / 86_400_000;
  const newer = days >= 7 ? "new" : days <= -7 ? "old" : null;
  const score = (d: boolean, side: "new" | "old") => (d ? 2 : 0) + (newer === side ? 1 : 0);
  const sNew = score(newD, "new");
  const sOld = score(oldD, "old");

  if (sNew === sOld) {
    const deciding = newD && oldD ? `both come from someone who decides on ${input.area}` : `neither comes from whoever decides on ${input.area}`;
    return { stronger: "even", reason: `Neither looks stronger: ${deciding}, and they are within a week of each other.` };
  }
  const side = sNew > sOld ? "new" : "old";
  const winner = side === "new" ? input.newBy : input.oldBy;
  const winnerDecides = side === "new" ? newD : oldD;
  const loserDecides = side === "new" ? oldD : newD;
  const parts: string[] = [];
  if (winnerDecides && !loserDecides && winner) parts.push(who(winner) + ` on ${input.area}`);
  if (newer === side) parts.push(`it is ${span(days)} newer`);
  let reason = parts.join(", and ");
  if (newer && newer !== side) reason += `, though the ${side === "new" ? "approved one" : "new one"} is ${span(days)} newer`;
  const label = side === "new" ? "New one looks stronger" : "Approved one looks stronger";
  return { stronger: side, reason: `${label}: ${reason}.` };
}

/** People linked as deciding on an item (Part N "decides on"). */
export async function decidersFor(type: string, id: number): Promise<number[]> {
  const rows = await db
    .select({ id: linksTable.fromId })
    .from(linksTable)
    .where(and(eq(linksTable.relationship, "decides_on"), eq(linksTable.fromType, "person"), eq(linksTable.toType, type as never), eq(linksTable.toId, id)));
  return [...new Set(rows.map((r) => r.id))];
}

export async function selfPersonId(): Promise<number | null> {
  const [self] = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.isSelf, true));
  return self?.id ?? null;
}

export { inQuestionRefs } from "../lib/ai-data/inQuestion";

/* ---------- The check ---------- */

/** The card's claim as one line for the model and the round-up. */
export function claimText(s: Suggestion): string {
  if (s.kind === "rule") {
    const p = s.payload as RulePayload;
    return `${p.title}. When ${p.applies_when}: ${p.rule}`;
  }
  return (s.payload as FactPayload | DecisionPayload).text;
}

function ruleText(r: { title: string; applies_when: string; rule: string }): string {
  return `${r.title}. When ${r.applies_when}: ${r.rule}`;
}

/**
 * When the card's claim was made: who-said-it time when known, otherwise a decision's own date (a
 * look-back card read before Part N only has the meeting date there). Null when neither is known.
 */
export function whenSaid(s: Pick<Suggestion, "saidAt" | "kind" | "payload">): Date | null {
  if (s.saidAt) return s.saidAt;
  const d = s.kind === "decision" ? (s.payload as DecisionPayload | null)?.decided_at : null;
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : null;
}

async function candidates(s: Suggestion): Promise<JudgeItem[]> {
  const scope = defaultScope();
  const out: JudgeItem[] = [];
  const type = s.entityType;
  const id = s.entityId;
  if (s.kind !== "rule" && type && id != null) {
    const busy = await db.select({ ids: factReviewsTable.factIds }).from(factReviewsTable).where(eq(factReviewsTable.status, "pending"));
    const skip = new Set(busy.flatMap((r) => r.ids));
    const replaces = s.kind === "fact" ? (s.payload as FactPayload).supersedes : null;
    if (replaces != null) skip.add(replaces);
    const facts = await db
      .select({ id: factsTable.id, text: factsTable.text, at: factsTable.createdAt })
      .from(factsTable)
      .where(and(eq(factsTable.entityType, type), eq(factsTable.entityId, id), isNull(factsTable.supersededBy), sql.raw(factVisible("facts"))))
      .orderBy(desc(factsTable.createdAt))
      .limit(MAX_FACTS);
    for (const f of facts) if (!skip.has(f.id)) out.push({ ref: toRef("fact", f.id), text: f.text, at: f.at });

    const linked = sql`exists (select 1 from links l where (l.from_type = 'decision' and l.from_id = ${decisionsTable.id} and l.to_type = ${type} and l.to_id = ${id})
      or (l.to_type = 'decision' and l.to_id = ${decisionsTable.id} and l.from_type = ${type} and l.from_id = ${id}))`;
    const decisions = await db
      .select({ id: decisionsTable.id, text: decisionsTable.text, decidedAt: decisionsTable.decidedAt })
      .from(decisionsTable)
      .where(and(type === "project" ? or(eq(decisionsTable.projectId, id), linked) : linked, isNull(decisionsTable.supersededBy), sql.raw(decisionVisible("decisions"))))
      .orderBy(desc(decisionsTable.decidedAt))
      .limit(MAX_DECISIONS);
    for (const d of decisions) out.push({ ref: toRef("decision", d.id), text: d.text, at: new Date(`${d.decidedAt}T12:00:00Z`) });
  }
  let context: string[] | null = null;
  if (s.kind === "rule") {
    const p = s.payload as RulePayload;
    const refs = [...(p.project_ids ?? []).map((i) => toRef("project", i)), ...(p.organisation_ids ?? []).map((i) => toRef("organisation", i))];
    context = refs.length ? refs : null;
  } else if (type && id != null && (type === "project" || type === "person" || type === "organisation" || type === "product")) {
    context = await ruleContextFor(type, id);
  }
  const rules = (await rulesFor(scope, context)).slice(0, MAX_RULES);
  for (const r of rules) out.push({ ref: r.ref, text: ruleText(r), at: null });
  return out;
}

async function aboutLine(s: Suggestion): Promise<string> {
  if (!s.entityType || s.entityId == null) return s.kind === "rule" ? "a rule" : "something with no project yet";
  const names = await resolveEntities([{ type: s.entityType, id: s.entityId }]);
  return `${s.entityType} ${names.get(`${s.entityType}:${s.entityId}`)?.name ?? ""}`.trim();
}

/** Whether the card may be sent to the model at all. */
export async function sendable(s: Suggestion): Promise<boolean> {
  const p = s.payload as { confidential?: boolean | null };
  if (p.confidential === true) return false;
  const refs: string[] = [];
  if (s.entityType && s.entityId != null) refs.push(toRef(s.entityType as never, s.entityId));
  if (s.kind === "rule") {
    const rp = s.payload as RulePayload;
    refs.push(...(rp.project_ids ?? []).map((i) => toRef("project", i)), ...(rp.organisation_ids ?? []).map((i) => toRef("organisation", i)));
  }
  if (!refs.length) return true;
  const ok = await visibleRefs(defaultScope(), refs);
  return refs.every((r) => ok.has(r));
}

let running = false;

/**
 * Checks new fact, decision and rule cards that have not been checked yet. A card already in a
 * conflict (two facts about the same attribute) is left alone. Returns how many were checked and
 * how many contradicted something.
 */
export async function checkNewCards(now = new Date(), limit = 30): Promise<{ checked: number; contradictions: number }> {
  if (running) return { checked: 0, contradictions: 0 };
  running = true;
  try {
    const since = new Date(now.getTime() - CHECK_WINDOW_DAYS * 86_400_000);
    const rows = await db
      .select()
      .from(suggestionsTable)
      .where(
        and(
          eq(suggestionsTable.status, "pending"),
          inArray(suggestionsTable.kind, [...CHECKED_KINDS]),
          isNull(suggestionsTable.checkedAt),
          gte(suggestionsTable.createdAt, since),
          sql`not exists (select 1 from fact_reviews r where r.suggestion_id = ${suggestionsTable.id} and r.status = 'pending')`,
        ),
      )
      .orderBy(asc(suggestionsTable.createdAt), asc(suggestionsTable.id))
      .limit(limit);
    let checked = 0;
    let found = 0;
    for (const s of rows) {
      const mark = () => db.update(suggestionsTable).set({ checkedAt: now }).where(eq(suggestionsTable.id, s.id));
      if (!(await sendable(s))) {
        await mark();
        continue;
      }
      const items = await candidates(s);
      if (!items.length) {
        await mark();
        continue;
      }
      let verdicts;
      try {
        verdicts = await judgeContradictions({ kind: s.kind, about: await aboutLine(s), text: claimText(s), saidBy: s.saidByName, saidAt: whenSaid(s) ?? s.createdAt }, items, now);
      } catch (err) {
        // Most likely the model is unavailable: stop and try the rest on the next run.
        logger.warn({ err, suggestionId: s.id }, "Contradiction check failed");
        break;
      }
      checked++;
      const contradicts: ContradictedItem[] = verdicts.map((v) => {
        const [type, id] = v.ref.split(":");
        return { type: type as ContradictedItem["type"], id: Number(id), why: v.why };
      });
      await db.transaction(async (tx) => {
        await tx.update(suggestionsTable).set({ checkedAt: now }).where(eq(suggestionsTable.id, s.id));
        if (!contradicts.length) return;
        // The card may have been decided while the model was thinking.
        const [still] = await tx.select({ status: suggestionsTable.status }).from(suggestionsTable).where(eq(suggestionsTable.id, s.id));
        if (still?.status !== "pending") return;
        const factIds = contradicts.filter((c) => c.type === "fact").map((c) => c.id);
        const [review] = await tx
          .insert(factReviewsTable)
          .values({ kind: "contradiction", factIds, suggestionId: s.id, contradicts, createdAt: now })
          .returning({ id: factReviewsTable.id });
        if (factIds.length) await tx.update(factsTable).set({ needsCheck: true }).where(inArray(factsTable.id, factIds));
        await writeAudit(tx, {
          actor: "Contradiction check",
          action: "contradiction",
          entityType: "fact_review",
          entityId: review.id,
          payload: { suggestionId: s.id, contradicts: contradicts.map((c) => toRef(c.type, c.id)) },
        });
        found++;
      });
    }
    return { checked, contradictions: found };
  } finally {
    running = false;
  }
}
