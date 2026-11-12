/**
 * Closing the loop after a meeting: its Granola note is compared with the agenda Ollie wrote, each
 * item marked covered, partly or not covered. What was not covered is offered on the next agenda
 * for the same meeting (the next in a repeating series, or the next with the same title and someone
 * in common), until Ollie adds it there or drops it.
 *
 * Runs when the Granola note is attached, and again on request. Nothing is sent to AI when the
 * agenda or title names anything hidden from AI.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { calendarEventsTable, db, meetingBriefsTable, type AgendaCheck, type CalendarEvent } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { judgeAgenda } from "./agendaJudge";
import { ConflictError, NotFoundError, UpstreamError } from "./tasks";
import { mentions, namedThings } from "./voice";

const hashOf = (agenda: string) => createHash("sha1").update(agenda.trim()).digest("hex");

export interface AgendaCheckView {
  at: string;
  /** The agenda or the note changed since the check */
  stale: boolean;
  items: { index: number; title: string; status: "covered" | "partly" | "not_covered"; note: string; dropped: boolean }[];
}

export function checkView(event: Pick<CalendarEvent, "agendaCheck" | "notes" | "granolaRef">): AgendaCheckView | null {
  const c = event.agendaCheck;
  if (!c) return null;
  return {
    at: c.at,
    stale: c.agendaHash !== hashOf(event.notes ?? "") || (!!event.granolaRef && c.granolaRef !== event.granolaRef),
    items: c.items.map((it, index) => ({ index, title: it.title, status: it.status, note: it.note, dropped: !!it.dropped })),
  };
}

async function granolaNotesFor(event: CalendarEvent): Promise<{ ref: string; notes: string } | null> {
  if (event.granolaNotes) return { ref: event.granolaRef ?? "", notes: event.granolaNotes };
  // Notes attached before meetings kept their own copy are only on the brief.
  const [brief] = await db.select({ ref: meetingBriefsTable.granolaRef, notes: meetingBriefsTable.granolaNotes }).from(meetingBriefsTable).where(eq(meetingBriefsTable.calendarEventId, event.id));
  return brief?.notes ? { ref: brief.ref ?? "", notes: brief.notes } : null;
}

/**
 * Compares the meeting's Granola note with its agenda and saves the result. Returns null when
 * there is nothing to compare. `quiet` (used when the note arrives) swallows problems; otherwise
 * they are raised for Ollie to see.
 */
export async function checkAgenda(eventId: number, opts: { quiet?: boolean; now?: Date } = {}): Promise<AgendaCheck | null> {
  const [event] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, eventId));
  if (!event || event.personal) {
    if (opts.quiet) return null;
    throw new NotFoundError("That meeting is not on your calendar");
  }
  const agenda = event.notes?.trim();
  const granola = await granolaNotesFor(event);
  if (!agenda || !granola) {
    if (opts.quiet) return null;
    throw new ConflictError(agenda ? "This meeting has no Granola note yet" : "This meeting has no agenda to check against");
  }
  const hidden = (await namedThings()).filter((n) => !n.visible && [agenda, event.title].some((t) => mentions(t, n)));
  if (hidden.length) {
    if (opts.quiet) return null;
    throw new ConflictError(`The agenda names ${[...new Set(hidden.map((n) => n.name))].slice(0, 3).join(", ")}, which is hidden from AI, so OllieOS will not check it.`);
  }
  const verdicts = await judgeAgenda({ title: event.title, agenda, notes: granola.notes });
  if (!verdicts) {
    if (opts.quiet) return null;
    throw new UpstreamError("The agenda could not be checked just now. Try again in a moment.");
  }
  // An item Ollie dropped stays dropped when the check is run again.
  const dropped = new Set((event.agendaCheck?.items ?? []).filter((i) => i.dropped).map((i) => i.title.trim().toLowerCase()));
  const check: AgendaCheck = {
    granolaRef: granola.ref,
    agendaHash: hashOf(agenda),
    at: (opts.now ?? new Date()).toISOString(),
    items: verdicts
      .map((v) => ({ title: String(v.title ?? "").trim().slice(0, 300), status: v.status, note: String(v.note ?? "").trim().slice(0, 500) }))
      .filter((v) => v.title && ["covered", "partly", "not_covered"].includes(v.status))
      .slice(0, 30)
      .map((v) => (dropped.has(v.title.toLowerCase()) ? { ...v, dropped: true } : v)),
  };
  await db.transaction(async (tx) => {
    await tx.update(calendarEventsTable).set({ agendaCheck: check }).where(eq(calendarEventsTable.id, event.id));
    await writeAudit(tx, { actor: "ollieos", action: "update", entityType: "calendar_event", entityId: event.id, payload: { agendaCheck: check.items.length, notCovered: check.items.filter((i) => i.status !== "covered").length } });
  });
  return check;
}

/** When a Granola note is attached: check the agenda, never getting in the way of the attach. */
export async function checkAgendaQuietly(eventId: number): Promise<void> {
  try {
    await checkAgenda(eventId, { quiet: true });
  } catch (err) {
    logger.warn({ err, event: eventId }, "Could not check the agenda against the Granola note");
  }
}

/** Drop (or bring back) an item that was not covered, so it is not offered on the next agenda. */
export async function setLeftoverDropped(eventId: number, index: number, dropped: boolean): Promise<void> {
  const [event] = await db.select({ id: calendarEventsTable.id, check: calendarEventsTable.agendaCheck }).from(calendarEventsTable).where(eq(calendarEventsTable.id, eventId));
  if (!event?.check || !event.check.items[index]) throw new NotFoundError("That agenda item no longer exists");
  const items = event.check.items.map((it, i) => (i === index ? { ...it, dropped } : it));
  await db.transaction(async (tx) => {
    await tx.update(calendarEventsTable).set({ agendaCheck: { ...event.check!, items } }).where(eq(calendarEventsTable.id, event.id));
    await writeAudit(tx, { actor: "ollie", action: "update", entityType: "calendar_event", entityId: event.id, payload: { agendaItem: index, dropped } });
  });
}

export interface Leftovers {
  /** The earlier meeting they are left over from */
  eventId: number;
  title: string;
  startsAt: Date;
  items: { index: number; title: string; status: "partly" | "not_covered"; note: string }[];
}

const norm = (t: string) => t.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * What was not covered last time: from the most recent earlier meeting that has been checked and
 * is the same meeting (same repeating series, or same title with someone in common).
 */
export async function leftoversFor(event: CalendarEvent): Promise<Leftovers | null> {
  const rows = await db
    .select()
    .from(calendarEventsTable)
    .where(
      and(
        eq(calendarEventsTable.personal, false),
        lt(calendarEventsTable.startsAt, event.startsAt),
        sql`${calendarEventsTable.agendaCheck} is not null`,
        event.recurringEventId
          ? or(eq(calendarEventsTable.recurringEventId, event.recurringEventId), sql`lower(${calendarEventsTable.title}) = ${event.title.toLowerCase()}`)
          : sql`lower(${calendarEventsTable.title}) = ${event.title.toLowerCase()}`,
      ),
    )
    .orderBy(desc(calendarEventsTable.startsAt))
    .limit(10);
  const emails = new Set((event.attendeeDetails ?? []).map((a) => a.email?.toLowerCase()).filter((e): e is string => !!e));
  const prev = rows.find((r) => {
    if (event.recurringEventId && r.recurringEventId === event.recurringEventId) return true;
    if (norm(r.title) !== norm(event.title)) return false;
    // Same title alone is not enough ("Catch-up"): someone in common, or nobody else on either.
    const theirs = (r.attendeeDetails ?? []).map((a) => a.email?.toLowerCase()).filter((e): e is string => !!e);
    return theirs.some((e) => emails.has(e)) || (!theirs.length && !emails.size);
  });
  if (!prev?.agendaCheck) return null;
  const items = prev.agendaCheck.items
    .map((it, index) => ({ index, ...it }))
    .filter((it): it is typeof it & { status: "partly" | "not_covered" } => it.status !== "covered" && !it.dropped)
    .map(({ index, title, status, note }) => ({ index, title, status, note }));
  return items.length ? { eventId: prev.id, title: prev.title, startsAt: prev.startsAt, items } : null;
}
