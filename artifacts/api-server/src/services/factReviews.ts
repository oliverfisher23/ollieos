/**
 * Stale and conflicting facts (feature 02). A weekly check, run when the first sweep finishes after
 * Sunday 18:00 London time (build plan 32 and 50), lists facts nobody has confirmed within their
 * shelf life and current facts that disagree on the same attribute. Ollie resolves them in the
 * Knowledge Inbox.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { appSettingsTable, db, decisionsTable, factReviewsTable, factsTable, rulesTable, suggestionsTable, type ContradictedItem, type Fact, type FactReview } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon, weekday } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { ACTOR, cleanText, touch } from "./knowledge/common";
import { applySuggestion, clearOldRejected, markRejected, normalise, type FactAttribute } from "./suggestions";
import { NotFoundError, ValidationError } from "./tasks";

/* ---------- Settings ---------- */

export type ShelfLives = Record<FactAttribute | "general", number>;

export const DEFAULT_SHELF_LIVES: ShelfLives = {
  general: 90,
  status: 30,
  next_step: 30,
  decision_date: 30,
  job_title: 365,
  organisation: 365,
  // Part T: commercial facts on client organisations, read again by the sweep.
  renewal_date: 90,
  contract_value: 90,
  account_health: 30,
};

/** At most this many stale facts are added each week, oldest first. */
export const STALE_PER_WEEK = 10;

const SHELF_KEY = "fact_shelf_life_days";
const LAST_CHECK_KEY = "fact_check_last_run";

async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return row ? (row.value as T) : null;
}

async function putSetting(conn: DbOrTx, key: string, value: unknown) {
  await conn
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

export async function getShelfLives(): Promise<ShelfLives> {
  const saved = (await getSetting<Partial<ShelfLives>>(SHELF_KEY)) ?? {};
  return { ...DEFAULT_SHELF_LIVES, ...saved };
}

export async function getKnowledgeSettings() {
  const [shelfLifeDays, lastRun] = await Promise.all([getShelfLives(), getSetting<string>(LAST_CHECK_KEY)]);
  return { shelfLifeDays, lastCheckAt: lastRun ? new Date(lastRun) : null };
}

export async function updateShelfLives(input: Partial<ShelfLives>) {
  const next = { ...(await getShelfLives()), ...input };
  await db.transaction(async (tx) => {
    await putSetting(tx, SHELF_KEY, next);
    await writeAudit(tx, { actor: ACTOR, action: "update", payload: { setting: SHELF_KEY, value: next } });
  });
  return getKnowledgeSettings();
}

/* ---------- The weekly check ---------- */

/** The most recent Sunday 18:00 London time at or before now. */
export function lastSundayEvening(now: Date): Date {
  const today = todayLondon(now);
  let day = addDays(today, -weekday(today));
  let at = londonWallTimeToInstant(day, 18, 0);
  if (at > now) {
    day = addDays(day, -7);
    at = londonWallTimeToInstant(day, 18, 0);
  }
  return at;
}

/** Fact ids already in a pending review, so the check never lists one twice. */
async function factsUnderReview(conn: DbOrTx): Promise<Set<number>> {
  const rows = await conn.select({ ids: factReviewsTable.factIds }).from(factReviewsTable).where(eq(factReviewsTable.status, "pending"));
  return new Set(rows.flatMap((r) => r.ids));
}

/** Finds conflicts and stale facts and adds them to the Knowledge Inbox. */
export async function runFactCheck(now = new Date(), actor = "Weekly check") {
  const shelf = await getShelfLives();
  return db.transaction(async (tx) => {
    const busy = await factsUnderReview(tx);
    const current = await tx.select().from(factsTable).where(isNull(factsTable.supersededBy)).orderBy(asc(factsTable.createdAt), asc(factsTable.id));

    // Conflicts: two or more current facts on the same entity and attribute that say different things.
    const groups = new Map<string, Fact[]>();
    for (const f of current) {
      if (!f.attribute) continue;
      const key = `${f.entityType}:${f.entityId}:${f.attribute}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    const conflicts: number[] = [];
    for (const facts of groups.values()) {
      if (facts.length < 2 || facts.some((f) => busy.has(f.id))) continue;
      if (new Set(facts.map((f) => normalise(f.text))).size < 2) continue;
      const ids = facts.map((f) => f.id);
      const [review] = await tx.insert(factReviewsTable).values({ kind: "conflict", factIds: ids, createdAt: now }).returning();
      await tx.update(factsTable).set({ needsCheck: true }).where(inArray(factsTable.id, ids));
      ids.forEach((i) => busy.add(i));
      conflicts.push(review.id);
    }

    // Stale: unconfirmed for longer than the shelf life for the attribute. Oldest first, ten a week.
    const days = (f: Fact) => shelf[(f.attribute ?? "general") as keyof ShelfLives] ?? shelf.general;
    const stale = current
      .filter((f) => !busy.has(f.id) && !f.needsCheck && now.getTime() - f.lastConfirmedAt.getTime() > days(f) * 86_400_000)
      .sort((a, b) => a.lastConfirmedAt.getTime() - b.lastConfirmedAt.getTime() || a.id - b.id)
      .slice(0, STALE_PER_WEEK);
    const staleReviews: number[] = [];
    for (const f of stale) {
      const [review] = await tx.insert(factReviewsTable).values({ kind: "stale", factIds: [f.id], createdAt: now }).returning();
      await tx.update(factsTable).set({ needsCheck: true }).where(eq(factsTable.id, f.id));
      staleReviews.push(review.id);
    }

    await putSetting(tx, LAST_CHECK_KEY, now.toISOString());
    await writeAudit(tx, { actor, action: "fact_check", entityType: "fact_review", payload: { stale: staleReviews.length, conflicts: conflicts.length } });
    return { stale: staleReviews.length, conflicts: conflicts.length };
  });
}

/**
 * Scheduled work that runs when a sweep finishes: the weekly fact check once Sunday 18:00 has
 * passed, and clearing rejected suggestions older than 30 days.
 */
export async function onSweepFinished(now = new Date()) {
  const cleared = await clearOldRejected(now);
  const last = await getSetting<string>(LAST_CHECK_KEY);
  const due = lastSundayEvening(now);
  const check = !last || new Date(last) < due ? await runFactCheck(now) : null;
  return { cleared, check };
}

/* ---------- Tidying ---------- */

/**
 * Closes reviews that no longer apply because the facts were replaced on their page or the
 * suggestion was decided elsewhere. The fact left standing stops needing a check.
 */
export async function tidyReviews(now = new Date()) {
  const pending = await db.select().from(factReviewsTable).where(eq(factReviewsTable.status, "pending"));
  if (!pending.length) return;
  const ids = [...new Set(pending.flatMap((r) => r.factIds))];
  const facts = ids.length ? await db.select().from(factsTable).where(inArray(factsTable.id, ids)) : [];
  const live = new Set(facts.filter((f) => f.supersededBy === null).map((f) => f.id));
  const sids = pending.map((r) => r.suggestionId).filter((x): x is number => x != null);
  const sugs = sids.length ? await db.select({ id: suggestionsTable.id, status: suggestionsTable.status }).from(suggestionsTable).where(inArray(suggestionsTable.id, sids)) : [];
  const pendingSugs = new Set(sugs.filter((s) => s.status === "pending").map((s) => s.id));
  const standingOthers = await standingItems(pending.flatMap((r) => r.contradicts ?? []));
  for (const r of pending) {
    const standing = r.factIds.filter((i) => live.has(i));
    const sides = standing.length + (r.suggestionId != null && pendingSugs.has(r.suggestionId) ? 1 : 0);
    const over =
      r.kind === "stale"
        ? standing.length === 0
        : r.kind === "contradiction"
          ? r.suggestionId == null || !pendingSugs.has(r.suggestionId) || !(r.contradicts ?? []).some((c) => (c.type === "fact" ? live.has(c.id) : standingOthers.has(`${c.type}:${c.id}`)))
          : sides < 2;
    if (!over) continue;
    await db.transaction(async (tx) => {
      await tx
        .update(factReviewsTable)
        .set({ status: "resolved", resolvedAt: now, resolution: { action: "replaced_elsewhere" } })
        .where(and(eq(factReviewsTable.id, r.id), eq(factReviewsTable.status, "pending")));
      if (standing.length) await tx.update(factsTable).set({ needsCheck: false }).where(inArray(factsTable.id, standing));
    });
  }
}

/** Decisions not replaced and rules still switched on, as refs. */
async function standingItems(items: ContradictedItem[], conn: DbOrTx = db): Promise<Set<string>> {
  const dids = [...new Set(items.filter((i) => i.type === "decision").map((i) => i.id))];
  const rids = [...new Set(items.filter((i) => i.type === "rule").map((i) => i.id))];
  const [ds, rs] = await Promise.all([
    dids.length ? conn.select({ id: decisionsTable.id }).from(decisionsTable).where(and(inArray(decisionsTable.id, dids), isNull(decisionsTable.supersededBy))) : [],
    rids.length ? conn.select({ id: rulesTable.id }).from(rulesTable).where(and(inArray(rulesTable.id, rids), eq(rulesTable.enabled, true))) : [],
  ]);
  return new Set([...ds.map((d) => `decision:${d.id}`), ...rs.map((r) => `rule:${r.id}`)]);
}

/* ---------- Resolving ---------- */

export type ResolveInput =
  | { action: "still_true" }
  | { action: "edit"; text: string }
  | { action: "no_longer_true" }
  | { action: "keep"; ref: string }
  | { action: "write_own"; text: string }
  /** Part O, for a contradiction */
  | { action: "new_right" }
  | { action: "old_stands" }
  | { action: "both_true" };

async function loadReview(tx: DbOrTx, id: number): Promise<FactReview> {
  const [r] = await tx.select().from(factReviewsTable).where(eq(factReviewsTable.id, id));
  if (!r) throw new NotFoundError("That review does not exist");
  if (r.status !== "pending") throw new ValidationError("That one has already been resolved");
  return r;
}

async function liveFacts(tx: DbOrTx, ids: number[]): Promise<Fact[]> {
  if (!ids.length) return [];
  return tx.select().from(factsTable).where(and(inArray(factsTable.id, ids), isNull(factsTable.supersededBy))).orderBy(asc(factsTable.id));
}

/** A new fact written by Ollie that replaces the given ones. */
async function writeOwn(tx: DbOrTx, like: Fact, text: string, replace: number[], now: Date): Promise<number> {
  const [created] = await tx
    .insert(factsTable)
    .values({ entityType: like.entityType, entityId: like.entityId, text, attribute: like.attribute, source: null, createdBy: ACTOR, lastConfirmedAt: now })
    .returning();
  await tx.update(factsTable).set({ supersededBy: created.id }).where(and(inArray(factsTable.id, replace), isNull(factsTable.supersededBy)));
  await touch(tx, like.entityType, like.entityId);
  await writeAudit(tx, { actor: ACTOR, action: "supersede", entityType: "fact", entityId: created.id, payload: { replaced: replace, to: text } });
  return created.id;
}

export async function resolveFactReview(id: number, input: ResolveInput, now = new Date()) {
  return db.transaction(async (tx) => {
    const r = await loadReview(tx, id);
    const facts = await liveFacts(tx, r.factIds);
    let resolution: Record<string, unknown> = { action: input.action };

    if (r.kind === "contradiction") {
      resolution = await resolveContradiction(tx, r, facts, input, now);
    } else if (r.kind === "stale") {
      const f = facts[0];
      if (!f) throw new ValidationError("That fact has already been replaced. Refresh to see the current version.");
      if (input.action === "still_true") {
        await tx.update(factsTable).set({ lastConfirmedAt: now, needsCheck: false }).where(eq(factsTable.id, f.id));
        await writeAudit(tx, { actor: ACTOR, action: "confirm", entityType: "fact", entityId: f.id });
      } else if (input.action === "edit") {
        const text = cleanText(input.text);
        if (!text) throw new ValidationError("A fact needs some text");
        resolution.newFactId = await writeOwn(tx, f, text, [f.id], now);
      } else if (input.action === "no_longer_true") {
        // Points at itself: kept in history with no successor.
        await tx.update(factsTable).set({ supersededBy: f.id, needsCheck: false }).where(and(eq(factsTable.id, f.id), isNull(factsTable.supersededBy)));
        await touch(tx, f.entityType, f.entityId);
        await writeAudit(tx, { actor: ACTOR, action: "retire", entityType: "fact", entityId: f.id, payload: { text: f.text } });
      } else {
        throw new ValidationError("Choose Still true, Edit or No longer true");
      }
    } else {
      const ids = facts.map((f) => f.id);
      const [sug] = r.suggestionId != null ? await tx.select().from(suggestionsTable).where(eq(suggestionsTable.id, r.suggestionId)) : [];
      const pendingSug = sug && sug.status === "pending" ? sug : null;
      if (input.action === "keep") {
        const m = /^(fact|suggestion):(\d+)$/.exec(input.ref);
        if (!m) throw new ValidationError("Choose one of the options");
        const keepId = Number(m[2]);
        if (m[1] === "fact") {
          const kept = facts.find((f) => f.id === keepId);
          if (!kept) throw new ValidationError("That option is no longer current. Refresh to see the latest.");
          const losers = ids.filter((i) => i !== keepId);
          if (losers.length) await tx.update(factsTable).set({ supersededBy: keepId }).where(and(inArray(factsTable.id, losers), isNull(factsTable.supersededBy)));
          await tx.update(factsTable).set({ lastConfirmedAt: now, needsCheck: false }).where(eq(factsTable.id, keepId));
          if (pendingSug) {
            await markRejected(tx, pendingSug.id, now);
            await writeAudit(tx, { actor: ACTOR, action: "reject", entityType: "suggestion", entityId: pendingSug.id, payload: { kind: pendingSug.kind, via: "conflict" } });
          }
          await writeAudit(tx, { actor: ACTOR, action: "supersede", entityType: "fact", entityId: keepId, payload: { replaced: losers, via: "conflict" } });
          resolution = { action: "keep", keptFactId: keepId };
        } else {
          if (!pendingSug || pendingSug.id !== keepId) throw new ValidationError("That option is no longer current. Refresh to see the latest.");
          const result = await applySuggestion(tx, pendingSug, pendingSug.payload as Record<string, unknown>, now, ids);
          await tx.update(suggestionsTable).set({ status: "approved", decidedAt: now, resultType: result.type, resultId: result.id }).where(eq(suggestionsTable.id, pendingSug.id));
          await writeAudit(tx, { actor: ACTOR, action: "approve", entityType: "suggestion", entityId: pendingSug.id, payload: { kind: "fact", result: `fact:${result.id}`, via: "conflict" } });
          resolution = { action: "keep", keptSuggestionId: pendingSug.id, newFactId: result.id };
        }
      } else if (input.action === "write_own") {
        const text = cleanText(input.text);
        if (!text) throw new ValidationError("A fact needs some text");
        const like = facts[0];
        if (!like) throw new ValidationError("That conflict no longer applies. Refresh to see the latest.");
        resolution.newFactId = await writeOwn(tx, like, text, ids, now);
        if (pendingSug) {
          await markRejected(tx, pendingSug.id, now);
          await writeAudit(tx, { actor: ACTOR, action: "reject", entityType: "suggestion", entityId: pendingSug.id, payload: { kind: pendingSug.kind, via: "conflict" } });
        }
      } else {
        throw new ValidationError("Keep one side, or write your own");
      }
    }

    await tx.update(factReviewsTable).set({ status: "resolved", resolvedAt: now, resolution }).where(eq(factReviewsTable.id, id));
    await writeAudit(tx, { actor: ACTOR, action: "resolve", entityType: "fact_review", entityId: id, payload: resolution });
    return { id, status: "resolved" as const, resolution };
  });
}

/**
 * A card that contradicts approved items (Part O).
 * New one is right: the card is approved; facts it contradicts are replaced (kept in history),
 * decisions are marked replaced, rules are switched off.
 * Old one stands: the card is rejected and the approved items count as confirmed today.
 * Both are true: the card is approved and nothing is replaced.
 */
async function resolveContradiction(tx: DbOrTx, r: FactReview, facts: Fact[], input: ResolveInput, now: Date): Promise<Record<string, unknown>> {
  if (input.action !== "new_right" && input.action !== "old_stands" && input.action !== "both_true") {
    throw new ValidationError("Choose New one is right, Old one stands or Both are true");
  }
  const [sug] = r.suggestionId != null ? await tx.select().from(suggestionsTable).where(eq(suggestionsTable.id, r.suggestionId)) : [];
  if (!sug || sug.status !== "pending") throw new ValidationError("That card was already decided. Refresh to see the latest.");
  const items = r.contradicts ?? [];
  const factIds = facts.map((f) => f.id);
  const standing = await standingItems(items, tx);
  const decisionIds = items.filter((i) => i.type === "decision" && standing.has(`decision:${i.id}`)).map((i) => i.id);
  const ruleIds = items.filter((i) => i.type === "rule" && standing.has(`rule:${i.id}`)).map((i) => i.id);
  const resolution: Record<string, unknown> = { action: input.action };

  if (input.action === "old_stands") {
    await markRejected(tx, sug.id, now);
    await writeAudit(tx, { actor: ACTOR, action: "reject", entityType: "suggestion", entityId: sug.id, payload: { kind: sug.kind, via: "contradiction" } });
    if (factIds.length) await tx.update(factsTable).set({ lastConfirmedAt: now, needsCheck: false }).where(inArray(factsTable.id, factIds));
    return resolution;
  }

  const replace = input.action === "new_right";
  const result = await applySuggestion(tx, sug, sug.payload as Record<string, unknown>, now, replace && sug.kind === "fact" ? factIds : []);
  await tx.update(suggestionsTable).set({ status: "approved", decidedAt: now, resultType: result.type, resultId: result.id }).where(eq(suggestionsTable.id, sug.id));
  await writeAudit(tx, { actor: ACTOR, action: "approve", entityType: "suggestion", entityId: sug.id, payload: { kind: sug.kind, result: `${result.type}:${result.id}`, via: "contradiction" } });
  resolution.result = `${result.type}:${result.id}`;

  if (replace) {
    // Facts the new one did not already replace are kept in history with no successor, or with the new fact on the same item.
    const left = await liveFacts(tx, factIds);
    for (const f of left) {
      const by = result.type === "fact" ? result.id : f.id;
      await tx.update(factsTable).set({ supersededBy: by, needsCheck: false }).where(and(eq(factsTable.id, f.id), isNull(factsTable.supersededBy)));
      await touch(tx, f.entityType, f.entityId);
      await writeAudit(tx, { actor: ACTOR, action: "retire", entityType: "fact", entityId: f.id, payload: { text: f.text, via: "contradiction", by: resolution.result } });
    }
    for (const id of decisionIds) {
      await tx.update(decisionsTable).set({ supersededBy: result.type === "decision" ? result.id : id }).where(and(eq(decisionsTable.id, id), isNull(decisionsTable.supersededBy)));
      await writeAudit(tx, { actor: ACTOR, action: "supersede", entityType: "decision", entityId: id, payload: { via: "contradiction", by: resolution.result } });
    }
    if (ruleIds.length) {
      await tx.update(rulesTable).set({ enabled: false }).where(inArray(rulesTable.id, ruleIds));
      for (const id of ruleIds) await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "rule", entityId: id, payload: { enabled: false, via: "contradiction", by: resolution.result } });
    }
    if (factIds.length) await tx.update(factsTable).set({ needsCheck: false }).where(inArray(factsTable.id, factIds));
    resolution.replaced = [...factIds.map((i) => `fact:${i}`), ...decisionIds.map((i) => `decision:${i}`), ...ruleIds.map((i) => `rule:${i}`)];
  } else if (factIds.length) {
    await tx.update(factsTable).set({ lastConfirmedAt: now, needsCheck: false }).where(inArray(factsTable.id, factIds));
  }
  return resolution;
}

/** Count of open fact reviews by kind. */
export async function reviewCounts() {
  const rows = await db
    .select({ kind: factReviewsTable.kind, n: sql<number>`count(*)::int` })
    .from(factReviewsTable)
    .where(eq(factReviewsTable.status, "pending"))
    .groupBy(factReviewsTable.kind);
  const n = (k: string) => rows.find((r) => r.kind === k)?.n ?? 0;
  const [items] = await db
    .select({ n: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${factReviewsTable.contradicts}, '[]'::jsonb))), 0)::int` })
    .from(factReviewsTable)
    .where(and(eq(factReviewsTable.status, "pending"), eq(factReviewsTable.kind, "contradiction")));
  return { stale: n("stale"), conflicts: n("conflict") + n("contradiction"), outOfDate: items?.n ?? 0 };
}
