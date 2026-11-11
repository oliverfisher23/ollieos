/**
 * "Same as existing" in the Knowledge Inbox (Part N). A card that says what an approved fact,
 * decision or rule already says is merged into it instead of approved: the existing item counts
 * as checked today, the card is kept as a second source for it, and nothing new is added.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, decisionsTable, factReviewsTable, factsTable, rulesTable, suggestionsTable, type Suggestion } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { ACTOR } from "./knowledge/common";
import { closeMatch, wordsOf } from "./similar";
import { NotFoundError, ValidationError } from "./tasks";

export const MERGE_ITEM_TYPES = ["fact", "decision", "rule"] as const;
export type MergeItemType = (typeof MERGE_ITEM_TYPES)[number];

export interface MergeOption {
  itemType: MergeItemType;
  id: number;
  text: string;
  /** A second line: when it was decided, or when the rule applies */
  detail: string | null;
  /** Says much the same thing as the card */
  likely: boolean;
}

const MAX_OPTIONS = 40;

async function loadCard(id: number): Promise<Suggestion> {
  const [s] = await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, id));
  if (!s) throw new NotFoundError("That suggestion does not exist");
  if (s.status !== "pending") throw new ValidationError("That card has already been dealt with");
  return s;
}

function cardText(s: Suggestion): string {
  const p = s.payload as { text?: string; rule?: string; title?: string };
  return [p.title, p.text, p.rule].filter(Boolean).join(" ");
}

function itemTypeFor(s: Suggestion): MergeItemType {
  if (s.kind === "fact" || s.kind === "decision" || s.kind === "rule") return s.kind;
  throw new ValidationError("Only a fact, decision or rule can be marked as the same as an existing one");
}

/** Approved items of the same kind the card could be the same as; close matches first. */
export async function mergeOptions(id: number): Promise<MergeOption[]> {
  const s = await loadCard(id);
  const type = itemTypeFor(s);
  const words = wordsOf(cardText(s));
  let options: Omit<MergeOption, "likely">[] = [];
  if (type === "fact") {
    if (!s.entityType || s.entityId == null) return [];
    const rows = await db
      .select()
      .from(factsTable)
      .where(and(eq(factsTable.entityType, s.entityType), eq(factsTable.entityId, s.entityId), isNull(factsTable.supersededBy)))
      .orderBy(desc(factsTable.createdAt));
    options = rows.map((f) => ({ itemType: "fact", id: f.id, text: f.text, detail: f.source }));
  } else if (type === "decision") {
    const rows = await db
      .select()
      .from(decisionsTable)
      .where(s.entityType === "project" && s.entityId != null ? eq(decisionsTable.projectId, s.entityId) : sql`true`)
      .orderBy(desc(decisionsTable.decidedAt))
      .limit(200);
    options = rows.map((d) => ({ itemType: "decision", id: d.id, text: d.text, detail: d.decidedBy ? `Decided by ${d.decidedBy}` : null }));
  } else {
    const rows = await db.select().from(rulesTable).orderBy(desc(rulesTable.updatedAt));
    options = rows.map((r) => ({ itemType: "rule", id: r.id, text: `${r.title}: ${r.rule}`, detail: `Applies when: ${r.appliesWhen}` }));
  }
  const scored = options.map((o) => ({ ...o, likely: closeMatch(words, o.text) }));
  return [...scored.filter((o) => o.likely), ...scored.filter((o) => !o.likely)].slice(0, MAX_OPTIONS);
}

export interface MergeOutcome {
  id: number;
  status: "merged";
  result: { type: MergeItemType; id: number };
}

/** Marks the card as the same as an existing item. A fact counts as checked today. */
export async function mergeSuggestion(id: number, itemType: MergeItemType, itemId: number, now = new Date()): Promise<MergeOutcome> {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(suggestionsTable).where(eq(suggestionsTable.id, id)).for("update");
    if (!s) throw new NotFoundError("That suggestion does not exist");
    if (s.status !== "pending") throw new ValidationError("That card has already been dealt with");
    if (itemTypeFor(s) !== itemType) throw new ValidationError("Choose an existing item of the same kind");
    const [conflict] = await tx
      .select({ id: factReviewsTable.id })
      .from(factReviewsTable)
      .where(and(eq(factReviewsTable.suggestionId, id), eq(factReviewsTable.status, "pending")));
    if (conflict) throw new ValidationError("This one disagrees with a current fact. Choose on the Conflicts tab.");

    if (itemType === "fact") {
      const [f] = await tx.select().from(factsTable).where(eq(factsTable.id, itemId));
      if (!f || f.supersededBy != null) throw new NotFoundError("That fact is no longer current");
      if (s.entityType !== f.entityType || s.entityId !== f.entityId) throw new ValidationError("That fact is about something else");
      await tx.update(factsTable).set({ lastConfirmedAt: now, needsCheck: false }).where(eq(factsTable.id, f.id));
      // A check waiting on this fact alone is answered: it was just confirmed.
      await tx
        .update(factReviewsTable)
        .set({ status: "resolved", resolvedAt: now, resolution: { action: "still_true", via: "merge", suggestionId: id } })
        .where(and(eq(factReviewsTable.kind, "stale"), eq(factReviewsTable.status, "pending"), sql`${factReviewsTable.factIds} = array[${f.id}]::integer[]`));
    } else if (itemType === "decision") {
      const [d] = await tx.select({ id: decisionsTable.id }).from(decisionsTable).where(eq(decisionsTable.id, itemId));
      if (!d) throw new NotFoundError("That decision does not exist");
    } else {
      const [r] = await tx.select({ id: rulesTable.id }).from(rulesTable).where(eq(rulesTable.id, itemId));
      if (!r) throw new NotFoundError("That rule does not exist");
    }

    await tx.update(suggestionsTable).set({ status: "merged", decidedAt: now, resultType: itemType, resultId: itemId }).where(eq(suggestionsTable.id, id));
    await writeAudit(tx, {
      actor: ACTOR,
      action: "merge",
      entityType: "suggestion",
      entityId: id,
      payload: { into: `${itemType}:${itemId}`, source: s.sourceLabel ?? s.proposedBy },
    });
    return { id, status: "merged" as const, result: { type: itemType, id: itemId } };
  });
}

/** Other sources for an item: cards Ollie marked as the same as it. */
export async function alsoFrom(itemType: MergeItemType, itemId: number): Promise<{ source: string; url: string | null; at: Date }[]> {
  const rows = await db
    .select({ label: suggestionsTable.sourceLabel, by: suggestionsTable.proposedBy, url: suggestionsTable.sourceUrl, at: suggestionsTable.decidedAt, created: suggestionsTable.createdAt })
    .from(suggestionsTable)
    .where(and(eq(suggestionsTable.status, "merged"), eq(suggestionsTable.resultType, itemType), eq(suggestionsTable.resultId, itemId)))
    .orderBy(desc(suggestionsTable.decidedAt));
  return rows.map((r) => ({ source: r.label ?? r.by, url: r.url, at: r.at ?? r.created }));
}
