/**
 * The Meetings page (Assist Part B): every work meeting from today to six days ahead, each with
 * who is coming and how ready it is, and the work meetings of the last two weeks with their
 * Granola notes. Ollie's view, so nothing is hidden. Prep pages are the briefs at /briefs/{id}.
 */
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { calendarEventsTable, db, meetingBriefsTable, peopleTable, tasksTable, type AgendaTurn, type CalendarEvent } from "@workspace/db";
import { OPEN_STATUSES, addDays, londonDate, londonRange, todayLondon } from "@workspace/shared";
import { eligible, loadMatchers, matchEvent } from "./briefs";
import type { MeetingScope } from "./meetingScope";
import { writeAudit } from "../lib/audit";
import { readByNow } from "./connectors";
import { NotFoundError } from "./tasks";

export const MEETINGS_AHEAD_DAYS = 7;
export const MEETINGS_PAST_DAYS = 14;
const SNIPPET = 320;

export type PrepState = "ready" | "not_much" | "failed" | "not_written" | "none";

export interface MeetingRow {
  id: number;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** London date, for grouping by day */
  day: string;
  platform: string | null;
  location: string | null;
  attendees: { name: string; slug: string | null }[];
  /** External when anyone on it is from outside Ollie's company */
  scope: MeetingScope;
  /** The outside companies on an external meeting */
  companies: string[];
  /**
   * ready: brief written with a summary. not_much: written, little on file. failed: the model
   * failed last time. not_written: gets a brief, written when opened or after the next sweep.
   * none: nobody or nothing OllieOS knows is on it, so there is no prep page.
   */
  prep: PrepState;
  /** Open promises Ollie made to people on the meeting */
  promises: number;
  /** Tasks Ollie is waiting on from people on the meeting */
  waiting: number;
  /** The start of the Granola notes, when there are any */
  granolaSnippet: string | null;
}

export interface MeetingsList {
  today: string;
  upcoming: MeetingRow[];
  past: MeetingRow[];
}

function prepOf(isEligible: boolean, brief: { why: unknown; failed: boolean } | undefined): PrepState {
  if (!isEligible) return "none";
  if (!brief) return "not_written";
  if (brief.failed) return "failed";
  return brief.why ? "ready" : "not_much";
}

function snippet(notes: string | null): string | null {
  const t = notes?.replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= SNIPPET) return t;
  const cut = t.slice(0, SNIPPET);
  const space = cut.lastIndexOf(" ");
  return (space > SNIPPET * 0.8 ? cut.slice(0, space) : cut) + " …";
}

export async function listMeetings(now = new Date()): Promise<MeetingsList> {
  const today = todayLondon(now);
  const ahead = londonRange(today, MEETINGS_AHEAD_DAYS);
  const from = londonRange(addDays(today, -MEETINGS_PAST_DAYS), 1).start;
  const events = await db
    .select()
    .from(calendarEventsTable)
    .where(and(eq(calendarEventsTable.personal, false), gte(calendarEventsTable.startsAt, from), lt(calendarEventsTable.startsAt, ahead.end)))
    .orderBy(asc(calendarEventsTable.startsAt), asc(calendarEventsTable.id));
  if (!events.length) return { today, upcoming: [], past: [] };

  const m = await loadMatchers();
  const matches = new Map(events.map((e) => [e.id, matchEvent(e, m)]));
  const personIds = [...new Set([...matches.values()].flatMap((x) => x.personIds))];
  const [briefs, people, promiseCounts, waitingCounts] = await Promise.all([
    db
      .select({ eventId: meetingBriefsTable.calendarEventId, why: meetingBriefsTable.why, failed: meetingBriefsTable.failed, granolaNotes: meetingBriefsTable.granolaNotes })
      .from(meetingBriefsTable)
      .where(inArray(meetingBriefsTable.calendarEventId, events.map((e) => e.id))),
    personIds.length ? db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug }).from(peopleTable).where(inArray(peopleTable.id, personIds)) : [],
    personIds.length
      ? db
          .select({ id: tasksTable.personId, n: sql<number>`count(*)::int` })
          .from(tasksTable)
          .where(and(eq(tasksTable.kind, "promise"), inArray(tasksTable.status, [...OPEN_STATUSES]), inArray(tasksTable.personId, personIds)))
          .groupBy(tasksTable.personId)
      : [],
    personIds.length
      ? db
          .select({ id: tasksTable.waitingOnPersonId, n: sql<number>`count(*)::int` })
          .from(tasksTable)
          .where(and(eq(tasksTable.status, "waiting"), inArray(tasksTable.waitingOnPersonId, personIds)))
          .groupBy(tasksTable.waitingOnPersonId)
      : [],
  ]);
  const briefOf = new Map(briefs.map((b) => [b.eventId, b]));
  const personOf = new Map(people.map((p) => [p.id, p]));
  const promisesOf = new Map(promiseCounts.map((r) => [r.id!, Number(r.n)]));
  const waitingOf = new Map(waitingCounts.map((r) => [r.id!, Number(r.n)]));
  const sum = (ids: number[], counts: Map<number, number>) => ids.reduce((n, id) => n + (counts.get(id) ?? 0), 0);

  const rows: MeetingRow[] = events.map((e) => {
    const match = matches.get(e.id)!;
    const brief = briefOf.get(e.id);
    const prep = prepOf(eligible(e, match), brief);
    return {
      id: e.id,
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      day: londonDate(e.startsAt),
      platform: e.platform,
      location: e.location,
      attendees: match.attendees.map((a) => {
        const p = a.personId != null ? personOf.get(a.personId) : undefined;
        return { name: p?.name ?? a.name, slug: p?.slug ?? null };
      }),
      scope: match.scope,
      companies: match.companies,
      prep,
      promises: sum(match.personIds, promisesOf),
      waiting: sum(match.personIds, waitingOf),
      granolaSnippet: snippet(brief?.granolaNotes ?? e.granolaNotes),
    };
  });
  const start = ahead.start.getTime();
  return {
    today,
    upcoming: rows.filter((r) => r.startsAt.getTime() >= start),
    past: rows.filter((r) => r.startsAt.getTime() < start).reverse(),
  };
}

/* ---------- One meeting (any work meeting, with or without a prep page) ---------- */

export interface MeetingView {
  id: number;
  title: string;
  startsAt: Date;
  endsAt: Date;
  platform: string | null;
  location: string | null;
  scope: MeetingScope;
  companies: string[];
  /** Same as on the Meetings list; anything but none means the prep page at /briefs/{id} exists */
  prep: PrepState;
  attendees: { name: string; email: string | null; person: { id: number; name: string; slug: string } | null }[];
  /** Ollie's agenda and notes */
  notes: string | null;
  /** The conversation that shaped the agenda */
  agendaChat: AgendaTurn[];
  /** The Granola note, once one is linked to the meeting */
  granola: { url: string | null; notes: string; attachedAt: Date | null; actions: { id: number; title: string; status: string }[] } | null;
  /** True when OllieOS reads Granola itself, so Check Granola now can fetch the note */
  granolaCheck: boolean;
}

export async function workEvent(eventId: number): Promise<CalendarEvent> {
  const [event] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, eventId));
  if (!event) throw new NotFoundError("That meeting is not on your calendar");
  if (event.personal) throw new NotFoundError("Personal events are not shown in Meetings");
  return event;
}

export async function meetingView(eventId: number): Promise<MeetingView> {
  const event = await workEvent(eventId);
  const m = await loadMatchers();
  const match = matchEvent(event, m);
  const personIds = match.personIds;
  const [[brief], people] = await Promise.all([
    db
      .select({ why: meetingBriefsTable.why, failed: meetingBriefsTable.failed, notes: meetingBriefsTable.notes, granolaNotes: meetingBriefsTable.granolaNotes, actionTaskIds: meetingBriefsTable.actionTaskIds })
      .from(meetingBriefsTable)
      .where(eq(meetingBriefsTable.calendarEventId, event.id)),
    personIds.length ? db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug }).from(peopleTable).where(inArray(peopleTable.id, personIds)) : [],
  ]);
  const personOf = new Map(people.map((p) => [p.id, p]));
  // Notes attached before meetings kept their own copy are only on the brief.
  const granolaNotes = event.granolaNotes ?? brief?.granolaNotes ?? null;
  const taskIds = [...new Set([...event.granolaTaskIds, ...(brief?.actionTaskIds ?? [])])];
  const [actions, granolaCheck] = await Promise.all([
    granolaNotes && taskIds.length
      ? db.select({ id: tasksTable.id, title: tasksTable.title, status: tasksTable.status }).from(tasksTable).where(inArray(tasksTable.id, taskIds)).orderBy(asc(tasksTable.id))
      : [],
    readByNow("granola").then((r) => r === "ollieos"),
  ]);
  return {
    id: event.id,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    platform: event.platform,
    location: event.location,
    scope: match.scope,
    companies: match.companies,
    prep: prepOf(eligible(event, match), brief),
    attendees: match.attendees.map((a) => {
      const p = a.personId != null ? personOf.get(a.personId) : undefined;
      return { name: p?.name ?? a.name, email: a.email ?? null, person: p ? { id: p.id, name: p.name, slug: p.slug } : null };
    }),
    // Older notes may still be on the brief.
    notes: event.notes ?? brief?.notes ?? null,
    agendaChat: event.agendaChat,
    granola: granolaNotes ? { url: event.granolaUrl, notes: granolaNotes, attachedAt: event.granolaAttachedAt, actions } : null,
    granolaCheck,
  };
}

/**
 * Saves Ollie's agenda and notes on the event. Any older copy on the brief is cleared so there is
 * only ever one.
 */
export async function updateMeetingNotes(eventId: number, notes: string | null): Promise<string | null> {
  const event = await workEvent(eventId);
  const text = notes?.trim() ? notes.slice(0, 20000) : null;
  await db.transaction(async (tx) => {
    await tx.update(calendarEventsTable).set({ notes: text }).where(eq(calendarEventsTable.id, event.id));
    await tx.update(meetingBriefsTable).set({ notes: null }).where(and(eq(meetingBriefsTable.calendarEventId, event.id), sql`${meetingBriefsTable.notes} is not null`));
    await writeAudit(tx, { actor: "ollie", action: "update", entityType: "calendar_event", entityId: event.id, payload: { notes: text ? text.length : 0 } });
  });
  return text;
}
