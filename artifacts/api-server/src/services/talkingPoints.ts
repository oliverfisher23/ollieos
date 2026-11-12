/**
 * "Next time I see…" points (build plan section 14, Part K). Added on a person page, from a
 * meeting's prep page, or by Claude. Open points go at the top of the next meeting's agenda with
 * that person; Granola notes mark the ones covered as Raised, and the rest carry over.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, peopleTable, talkingPointsTable, type TalkingPoint } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { NotFoundError, ValidationError } from "./tasks";

export const POINT_CHARS = 300;

export interface TalkingPointView {
  id: number;
  personId: number;
  personName: string | null;
  text: string;
  createdBy: string;
  status: "open" | "raised";
  raisedAt: Date | null;
  raisedTitle: string | null;
  raisedHow: string | null;
  createdAt: Date;
}

const view = (p: TalkingPoint, name: string | null = null): TalkingPointView => ({
  id: p.id,
  personId: p.personId,
  personName: name,
  text: p.text,
  createdBy: p.createdBy,
  status: p.status === "raised" ? "raised" : "open",
  raisedAt: p.raisedAt,
  raisedTitle: p.raisedTitle,
  raisedHow: p.raisedHow,
  createdAt: p.createdAt,
});

/** A person's points: open ones oldest first, then the last 20 raised. */
export async function listPoints(personId: number): Promise<{ open: TalkingPointView[]; raised: TalkingPointView[] }> {
  const [open, raised] = await Promise.all([
    db.select().from(talkingPointsTable).where(and(eq(talkingPointsTable.personId, personId), eq(talkingPointsTable.status, "open"))).orderBy(asc(talkingPointsTable.createdAt)),
    db.select().from(talkingPointsTable).where(and(eq(talkingPointsTable.personId, personId), eq(talkingPointsTable.status, "raised"))).orderBy(desc(talkingPointsTable.raisedAt)).limit(20),
  ]);
  return { open: open.map((p) => view(p)), raised: raised.map((p) => view(p)) };
}

export async function addPoint(personId: number, text: string, actor: string, clientId: number | null = null): Promise<TalkingPointView> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new ValidationError("Write the point to raise");
  if (clean.length > POINT_CHARS) throw new ValidationError(`Keep a point under ${POINT_CHARS} characters`);
  const [person] = await db.select({ id: peopleTable.id, name: peopleTable.name, isSelf: peopleTable.isSelf }).from(peopleTable).where(eq(peopleTable.id, personId));
  if (!person) throw new NotFoundError("That person does not exist");
  if (person.isSelf) throw new ValidationError("Points are for other people");
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(talkingPointsTable).values({ personId, text: clean, createdBy: actor }).returning();
    await writeAudit(tx, { actor, clientId, action: "create", entityType: "person", entityId: personId, payload: { talkingPoint: row.id, text: clean } });
    return view(row, person.name);
  });
}

/** Ticks a point as raised by hand, or puts it back as open. */
export async function setPointRaised(id: number, raised: boolean, actor: string): Promise<TalkingPointView> {
  const [cur] = await db.select().from(talkingPointsTable).where(eq(talkingPointsTable.id, id));
  if (!cur) throw new NotFoundError("That point does not exist");
  const [row] = await db
    .update(talkingPointsTable)
    .set(raised ? { status: "raised", raisedAt: new Date(), raisedHow: "ollie", raisedEventId: null, raisedTitle: null } : { status: "open", raisedAt: null, raisedHow: null, raisedEventId: null, raisedTitle: null })
    .where(eq(talkingPointsTable.id, id))
    .returning();
  await writeAudit(db, { actor, action: "update", entityType: "person", entityId: cur.personId, payload: { talkingPoint: id, raised } });
  return view(row);
}

export async function deletePoint(id: number, actor: string): Promise<void> {
  const [cur] = await db.delete(talkingPointsTable).where(eq(talkingPointsTable.id, id)).returning();
  if (!cur) throw new NotFoundError("That point does not exist");
  await writeAudit(db, { actor, action: "delete", entityType: "person", entityId: cur.personId, payload: { talkingPoint: id, text: cur.text } });
}

/** Open points for these people, with names, oldest first. */
export async function openPointsFor(personIds: number[]): Promise<TalkingPointView[]> {
  if (!personIds.length) return [];
  const rows = await db
    .select({ p: talkingPointsTable, name: peopleTable.name })
    .from(talkingPointsTable)
    .innerJoin(peopleTable, eq(peopleTable.id, talkingPointsTable.personId))
    .where(and(inArray(talkingPointsTable.personId, personIds), eq(talkingPointsTable.status, "open")))
    .orderBy(asc(talkingPointsTable.createdAt));
  return rows.map((r) => view(r.p, r.name));
}

/** The points block for the Granola reader. */
export function pointsBlock(points: TalkingPointView[]): string | null {
  if (!points.length) return null;
  return `<talking_points>\n${points.map((p) => `[point:${p.id}] ${p.personName ?? "Someone"}: ${p.text}`).join("\n")}\n</talking_points>`;
}

/** Points the meeting notes show were covered move to Raised, against that meeting. */
export async function markCovered(ids: number[], meeting: { eventId: number | null; title: string; at: Date }): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db
    .update(talkingPointsTable)
    .set({ status: "raised", raisedAt: meeting.at, raisedHow: "notes", raisedEventId: meeting.eventId, raisedTitle: meeting.title })
    .where(and(inArray(talkingPointsTable.id, ids), eq(talkingPointsTable.status, "open")))
    .returning({ id: talkingPointsTable.id, personId: talkingPointsTable.personId });
  for (const r of rows) await writeAudit(db, { actor: "ollieos", action: "update", entityType: "person", entityId: r.personId, payload: { talkingPoint: r.id, raised: true, via: "granola" } });
  return rows.length;
}
