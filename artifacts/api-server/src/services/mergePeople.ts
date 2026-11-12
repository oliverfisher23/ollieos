/**
 * Merging two records for the same person, and spotting likely duplicates (Part N).
 *
 * Everything on the merged record moves to the one kept: facts, notes, activity, suggestions, tasks
 * (for and waiting on), review items, meetings and briefs, Claude sessions, links and relationships,
 * product and playbook owners, playbook steps, and every email address and the Slack account. The
 * kept record's own details win where both have one. The merged record is then removed.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  appSettingsTable,
  db,
  factsTable,
  linksTable,
  notesTable,
  activityTable,
  peopleTable,
  playbooksTable,
  productsTable,
  reviewItemsTable,
  slackToAnswerTable,
  suggestionsTable,
  tasksTable,
  accessRequestsTable,
} from "@workspace/db";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { ACTOR } from "./knowledge/common";
import { emailsOf } from "./personMatch";
import { NotFoundError, ValidationError } from "./tasks";

export interface MergeResult {
  kept: { id: number; name: string; slug: string };
  removed: { id: number; name: string };
  moved: { facts: number; notes: number; tasks: number; meetings: number; links: number };
}

const ARRAY_COLUMNS: { table: string; column: string }[] = [
  { table: "calendar_events", column: "person_ids" },
  { table: "cowork_sessions", column: "person_ids" },
  { table: "meeting_briefs", column: "attendee_ids" },
];

async function loadById(conn: DbOrTx, id: number) {
  const [p] = await conn.select().from(peopleTable).where(eq(peopleTable.id, id));
  if (!p) throw new NotFoundError("That person does not exist");
  return p;
}

/** Moves links from the merged person to the kept one; a link the kept one already has is not doubled. */
async function moveLinks(tx: DbOrTx, keepId: number, goneId: number): Promise<number> {
  const rows = await tx
    .select()
    .from(linksTable)
    .where(or(and(eq(linksTable.fromType, "person"), eq(linksTable.fromId, goneId)), and(eq(linksTable.toType, "person"), eq(linksTable.toId, goneId))));
  let moved = 0;
  for (const r of rows) {
    const out = r.fromType === "person" && r.fromId === goneId;
    const other = out ? { type: r.toType, id: r.toId } : { type: r.fromType, id: r.fromId };
    await tx
      .delete(linksTable)
      .where(and(eq(linksTable.fromType, r.fromType), eq(linksTable.fromId, r.fromId), eq(linksTable.toType, r.toType), eq(linksTable.toId, r.toId)));
    // A link between the two records means nothing once they are one person.
    if (other.type === "person" && (other.id === keepId || other.id === goneId)) continue;
    const pair = or(
      and(eq(linksTable.fromType, "person"), eq(linksTable.fromId, keepId), eq(linksTable.toType, other.type), eq(linksTable.toId, other.id)),
      and(eq(linksTable.fromType, other.type), eq(linksTable.fromId, other.id), eq(linksTable.toType, "person"), eq(linksTable.toId, keepId)),
    );
    const [existing] = await tx.select().from(linksTable).where(pair);
    if (existing) {
      // Keep the kept person's link, unless only the merged one says how they are related.
      if (existing.relationship || !r.relationship) continue;
      await tx.delete(linksTable).where(pair);
    }
    await tx.insert(linksTable).values({
      ...r,
      fromType: out ? "person" : r.fromType,
      fromId: out ? keepId : r.fromId,
      toType: out ? r.toType : "person",
      toId: out ? r.toId : keepId,
    });
    moved++;
  }
  return moved;
}

/**
 * Merges `goneId` into `keepId`. Ollie's own record can be kept but never merged away.
 */
export async function mergePeople(keepId: number, goneId: number, now = new Date()): Promise<MergeResult> {
  if (keepId === goneId) throw new ValidationError("Choose someone else to merge with");
  return db.transaction(async (tx) => {
    const keep = await loadById(tx, keepId);
    const gone = await loadById(tx, goneId);
    if (gone.isSelf) throw new ValidationError("Your own profile cannot be merged away. Merge the other record into it instead.");

    const facts = await tx
      .update(factsTable)
      .set({ entityId: keepId })
      .where(and(eq(factsTable.entityType, "person"), eq(factsTable.entityId, goneId)))
      .returning({ id: factsTable.id });
    const notes = await tx
      .update(notesTable)
      .set({ entityId: keepId })
      .where(and(eq(notesTable.entityType, "person"), eq(notesTable.entityId, goneId)))
      .returning({ id: notesTable.id });
    await tx.update(activityTable).set({ entityId: keepId }).where(and(eq(activityTable.entityType, "person"), eq(activityTable.entityId, goneId)));
    await tx.update(suggestionsTable).set({ entityId: keepId }).where(and(eq(suggestionsTable.entityType, "person"), eq(suggestionsTable.entityId, goneId)));
    await tx.update(suggestionsTable).set({ saidById: keepId }).where(eq(suggestionsTable.saidById, goneId));
    await tx.update(accessRequestsTable).set({ entityId: keepId }).where(and(eq(accessRequestsTable.entityType, "person"), eq(accessRequestsTable.entityId, goneId)));

    const forTasks = await tx.update(tasksTable).set({ personId: keepId }).where(eq(tasksTable.personId, goneId)).returning({ id: tasksTable.id });
    const waitTasks = await tx.update(tasksTable).set({ waitingOnPersonId: keepId }).where(eq(tasksTable.waitingOnPersonId, goneId)).returning({ id: tasksTable.id });
    await tx.update(reviewItemsTable).set({ personId: keepId }).where(eq(reviewItemsTable.personId, goneId));
    await tx.update(slackToAnswerTable).set({ personId: keepId }).where(eq(slackToAnswerTable.personId, goneId));
    await tx.update(productsTable).set({ ownerId: keepId }).where(eq(productsTable.ownerId, goneId));
    await tx.update(playbooksTable).set({ ownerId: keepId }).where(eq(playbooksTable.ownerId, goneId));
    const withSteps = await tx
      .select({ id: playbooksTable.id, steps: playbooksTable.steps })
      .from(playbooksTable)
      .where(sql`${playbooksTable.steps} @> ${JSON.stringify([{ personId: goneId }])}::jsonb`);
    for (const p of withSteps) {
      await tx
        .update(playbooksTable)
        .set({ steps: p.steps.map((s) => (s.personId === goneId ? { ...s, personId: keepId } : s)) })
        .where(eq(playbooksTable.id, p.id));
    }

    let meetings = 0;
    for (const { table, column } of ARRAY_COLUMNS) {
      const t = sql.identifier(table);
      const c = sql.identifier(column);
      const r = await tx.execute(
        sql`update ${t} set ${c} = case when ${keepId} = any(${c}) then array_remove(${c}, ${goneId}) else array_replace(${c}, ${goneId}, ${keepId}) end where ${goneId} = any(${c})`,
      );
      if (table === "calendar_events") meetings = r.rowCount ?? 0;
    }
    const links = await moveLinks(tx, keepId, goneId);

    // Details: the kept record's win; every address and the Slack account carry over.
    const all = [...emailsOf(keep), ...emailsOf(gone)];
    const main = keep.email?.toLowerCase() ?? all[0] ?? null;
    const others = [...new Set(all.filter((e) => e !== main))];
    await tx.update(peopleTable).set({ email: null, otherEmails: [], slackUserId: null }).where(eq(peopleTable.id, goneId));
    await tx
      .update(peopleTable)
      .set({
        email: main,
        otherEmails: others,
        slackUserId: keep.slackUserId ?? gone.slackUserId,
        role: keep.role ?? gone.role,
        organisationId: keep.organisationId ?? gone.organisationId,
        relationshipSummary: keep.relationshipSummary ?? gone.relationshipSummary,
        // Hidden if either was hidden: merging never shows AI something Ollie had kept from it.
        confidential: keep.confidential || gone.confidential,
        aiAccess: keep.aiAccess && gone.aiAccess,
        lastContactAt:
          keep.lastContactAt && gone.lastContactAt
            ? new Date(Math.max(keep.lastContactAt.getTime(), gone.lastContactAt.getTime()))
            : (keep.lastContactAt ?? gone.lastContactAt),
        cadence: keep.cadence !== "none" || keep.isSelf ? keep.cadence : gone.cadence,
        updatedAt: now,
      })
      .where(eq(peopleTable.id, keepId));
    await tx.delete(peopleTable).where(eq(peopleTable.id, goneId));
    await writeAudit(tx, {
      actor: ACTOR,
      action: "merge",
      entityType: "person",
      entityId: keepId,
      payload: { merged: { id: goneId, name: gone.name, emails: emailsOf(gone) }, facts: facts.length, notes: notes.length, tasks: forTasks.length + waitTasks.length, meetings, links },
    });
    return {
      kept: { id: keep.id, name: keep.name, slug: keep.slug },
      removed: { id: gone.id, name: gone.name },
      moved: { facts: facts.length, notes: notes.length, tasks: forTasks.length + waitTasks.length, meetings, links },
    };
  });
}

/* ---------- Possible duplicates ---------- */

const NOT_SAME_KEY = "people_not_duplicates";

export interface DuplicatePair {
  a: { id: number; name: string; slug: string; email: string | null };
  b: { id: number; name: string; slug: string; email: string | null };
  reason: string;
}

const pairKey = (x: number, y: number) => (x < y ? `${x}-${y}` : `${y}-${x}`);

/** Lower case, no accents or punctuation, single spaces. */
export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function notSame(): Promise<string[]> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, NOT_SAME_KEY));
  return Array.isArray(row?.value) ? (row.value as string[]) : [];
}

/**
 * People who look like the same person: the same name, or an email address with the same name
 * part and one of the names starting the same way. Pairs Ollie said are not the same are left out.
 */
export async function possibleDuplicates(limit = 20): Promise<DuplicatePair[]> {
  const [people, dismissed] = await Promise.all([
    db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, email: peopleTable.email, otherEmails: peopleTable.otherEmails }).from(peopleTable),
    notSame(),
  ]);
  const skip = new Set(dismissed);
  const out: DuplicatePair[] = [];
  const seen = new Set<string>();
  const add = (a: (typeof people)[number], b: (typeof people)[number], reason: string) => {
    const k = pairKey(a.id, b.id);
    if (a.id === b.id || skip.has(k) || seen.has(k)) return;
    seen.add(k);
    const [x, y] = a.id < b.id ? [a, b] : [b, a];
    out.push({ a: { id: x.id, name: x.name, slug: x.slug, email: x.email }, b: { id: y.id, name: y.name, slug: y.slug, email: y.email }, reason });
  };
  const byName = new Map<string, typeof people>();
  for (const p of people) {
    const k = nameKey(p.name);
    if (k) byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  for (const group of byName.values()) for (let i = 1; i < group.length; i++) add(group[0], group[i], "Same name");
  const byLocal = new Map<string, typeof people>();
  for (const p of people) {
    for (const e of emailsOf(p)) {
      const local = e.split("@")[0];
      if (local.length < 4 || /^(info|hello|admin|team|contact|office|support)$/.test(local)) continue;
      byLocal.set(local, [...(byLocal.get(local) ?? []).filter((q) => q.id !== p.id), p]);
    }
  }
  for (const group of byLocal.values()) {
    for (let i = 1; i < group.length; i++) {
      const [a, b] = [group[0], group[i]];
      if (nameKey(a.name).split(" ")[0] === nameKey(b.name).split(" ")[0]) add(a, b, "Matching email address");
    }
  }
  return out.slice(0, limit);
}

/** Ollie says two people are different people, so they stop showing as possible duplicates. */
export async function markNotSame(a: number, b: number): Promise<void> {
  if (a === b) throw new ValidationError("Choose two different people");
  const found = await db.select({ id: peopleTable.id }).from(peopleTable).where(inArray(peopleTable.id, [a, b]));
  if (found.length < 2) throw new NotFoundError("That person does not exist");
  const list = [...new Set([...(await notSame()), pairKey(a, b)])].slice(-500);
  await db
    .insert(appSettingsTable)
    .values({ key: NOT_SAME_KEY, value: list })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: list } });
}
