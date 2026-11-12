/**
 * Which recent email and Slack threads with the people on a meeting are about that meeting.
 *
 * The prep page used to list every thread with anyone on the invite. Now each one is judged once per
 * meeting by the thread matcher (Haiku), which learns from Ollie's own "Not about this meeting" and
 * "It is about this meeting" verdicts. Ollie's verdict always wins, and his "not about it" carries to
 * the rest of a repeating series. Threads hidden from AI are never sent and stay shown; if the model
 * cannot be reached, everything is shown as before.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { activityTable, calendarEventsTable, db, meetingThreadChecksTable, type CalendarEvent } from "@workspace/db";
import { toRef } from "@workspace/shared";
import { loadVisibleDocs } from "../lib/ai-data/retrieve";
import { recordReads, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { askScope } from "./ask/ask";
import { judgeThreads } from "./threadJudge";
import { NotFoundError } from "./tasks";

export interface ThreadRow {
  id: number;
  kind: string;
  summary: string;
  occurredAt: Date;
  url: string | null;
}

/** Who and what the meeting is about; names hidden from AI are dropped before the matcher sees them. */
export interface MatchContext {
  attendees: { name: string; personId: number | null }[];
  projects: { id: number; name: string }[];
}

export interface HiddenThread extends ThreadRow {
  by: "ollie" | "ai";
  reason: string | null;
}

/** Ollie's verdicts handed to the matcher as examples */
const MAX_EXAMPLES = 30;

/* ---------- Choosing what the prep page shows ---------- */

function sameMeeting(event: Pick<CalendarEvent, "id" | "recurringEventId">) {
  return event.recurringEventId
    ? or(eq(meetingThreadChecksTable.calendarEventId, event.id), and(eq(meetingThreadChecksTable.seriesId, event.recurringEventId), eq(meetingThreadChecksTable.source, "ollie")))
    : eq(meetingThreadChecksTable.calendarEventId, event.id);
}

/** Activity ids judged not about this meeting (or Ollie's "not about it" in its series). Kept out of the brief writer too. */
export async function unrelatedActivityIds(event: Pick<CalendarEvent, "id" | "recurringEventId">): Promise<Set<number>> {
  const rows = await db
    .select({ activityId: meetingThreadChecksTable.activityId, related: meetingThreadChecksTable.related, eventId: meetingThreadChecksTable.calendarEventId, source: meetingThreadChecksTable.source })
    .from(meetingThreadChecksTable)
    .where(sameMeeting(event));
  return new Set(verdicts(rows, event.id).filter(([, v]) => !v.related).map(([id]) => id));
}

/** One verdict per thread: this meeting's own first (Ollie over AI), then Ollie's in the series. */
function verdicts<T extends { activityId: number; related: boolean; eventId: number; source: string }>(rows: T[], eventId: number): [number, T][] {
  const rank = (r: T) => (r.eventId === eventId ? (r.source === "ollie" ? 0 : 2) : 1);
  const best = new Map<number, T>();
  for (const r of rows) {
    const cur = best.get(r.activityId);
    if (!cur || rank(r) < rank(cur)) best.set(r.activityId, r);
  }
  return [...best.entries()];
}

export async function chooseThreads(
  event: CalendarEvent,
  candidates: ThreadRow[],
  ctx: MatchContext & { max: number },
): Promise<{ shown: ThreadRow[]; hidden: HiddenThread[] }> {
  if (!candidates.length) return { shown: [], hidden: [] };
  const rows = await db
    .select({
      activityId: meetingThreadChecksTable.activityId,
      related: meetingThreadChecksTable.related,
      eventId: meetingThreadChecksTable.calendarEventId,
      source: meetingThreadChecksTable.source,
      reason: meetingThreadChecksTable.reason,
    })
    .from(meetingThreadChecksTable)
    .where(and(sameMeeting(event), inArray(meetingThreadChecksTable.activityId, candidates.map((c) => c.id))));
  const known = new Map(verdicts(rows, event.id));

  // Threads nobody has judged for this meeting: ask the matcher about the ones AI may see.
  const unjudged = candidates.filter((c) => !known.has(c.id));
  if (unjudged.length) {
    try {
      await judgeAndStore(event, unjudged, ctx, known);
    } catch (err) {
      logger.warn({ err, event: event.id }, "Could not judge the meeting's threads");
    }
  }

  const shown: ThreadRow[] = [];
  const hidden: HiddenThread[] = [];
  for (const c of candidates) {
    const v = known.get(c.id);
    if (v && !v.related) hidden.push({ ...c, by: v.source === "ollie" ? "ollie" : "ai", reason: v.reason });
    else if (shown.length < ctx.max) shown.push(c);
  }
  return { shown, hidden };
}

async function judgeAndStore(
  event: CalendarEvent,
  unjudged: ThreadRow[],
  ctx: MatchContext,
  known: Map<number, { activityId: number; related: boolean; eventId: number; source: string; reason: string | null }>,
): Promise<void> {
  const scope = await askScope();
  const docs = await loadVisibleDocs(scope, unjudged.map((t) => toRef("activity", t.id)));
  if (!docs.length) return;

  // Ollie's verdicts as examples, newest first, leaving out threads now hidden from AI.
  const ex = await db
    .select({ activityId: meetingThreadChecksTable.activityId, related: meetingThreadChecksTable.related, meeting: meetingThreadChecksTable.meetingTitle, thread: meetingThreadChecksTable.threadSummary })
    .from(meetingThreadChecksTable)
    .where(eq(meetingThreadChecksTable.source, "ollie"))
    .orderBy(desc(meetingThreadChecksTable.updatedAt))
    .limit(MAX_EXAMPLES * 2);
  const okEx = await visibleRefs(scope, ex.map((e) => toRef("activity", e.activityId)));
  const examples = ex.filter((e) => okEx.has(toRef("activity", e.activityId))).slice(0, MAX_EXAMPLES);

  const okNames = await visibleRefs(scope, [
    ...ctx.attendees.filter((a) => a.personId != null).map((a) => toRef("person", a.personId!)),
    ...ctx.projects.map((p) => toRef("project", p.id)),
  ]);
  const attendees = ctx.attendees.filter((a) => a.personId == null || okNames.has(toRef("person", a.personId))).map((a) => a.name);
  const projects = ctx.projects.filter((p) => okNames.has(toRef("project", p.id))).map((p) => p.name);
  const byRef = new Map(unjudged.map((t) => [toRef("activity", t.id), t]));
  const results = await judgeThreads({
    meeting: { title: event.title, when: event.startsAt.toISOString().slice(0, 10), attendees, projects, agenda: event.notes },
    threads: docs.map((d) => ({ id: d.ref, text: d.text })),
    examples: examples.map((e) => ({ meeting: e.meeting, thread: e.thread, related: e.related })),
  });
  if (!results) return;
  await recordReads(scope, docs.map((d) => d.ref), { via: "thread_matcher", event: event.id });

  const values = results
    .filter((r) => byRef.has(r.id))
    .map((r) => {
      const t = byRef.get(r.id)!;
      return {
        calendarEventId: event.id,
        seriesId: event.recurringEventId,
        activityId: t.id,
        related: !!r.related,
        source: "ai",
        reason: String(r.reason ?? "").trim().slice(0, 200) || null,
        meetingTitle: event.title,
        threadSummary: t.summary,
      };
    });
  if (!values.length) return;
  await db.insert(meetingThreadChecksTable).values(values).onConflictDoNothing();
  for (const v of values) known.set(v.activityId, { activityId: v.activityId, related: v.related, eventId: event.id, source: "ai", reason: v.reason });
}

/** "Not about this meeting" / "It is about this meeting": Ollie's verdict, which the matcher learns from. */
export async function setThreadVerdict(eventId: number, activityId: number, related: boolean): Promise<void> {
  const [[event], [act]] = await Promise.all([
    db
      .select({ id: calendarEventsTable.id, title: calendarEventsTable.title, series: calendarEventsTable.recurringEventId, personal: calendarEventsTable.personal })
      .from(calendarEventsTable)
      .where(eq(calendarEventsTable.id, eventId)),
    db.select({ id: activityTable.id, summary: activityTable.summary }).from(activityTable).where(eq(activityTable.id, activityId)),
  ]);
  if (!event || event.personal) throw new NotFoundError("That meeting is not on your calendar");
  if (!act) throw new NotFoundError("That email or Slack thread no longer exists");
  await db.transaction(async (tx) => {
    await tx
      .insert(meetingThreadChecksTable)
      .values({ calendarEventId: eventId, seriesId: event.series, activityId, related, source: "ollie", reason: null, meetingTitle: event.title, threadSummary: act.summary })
      .onConflictDoUpdate({
        target: [meetingThreadChecksTable.calendarEventId, meetingThreadChecksTable.activityId],
        set: { related, source: "ollie", reason: null, meetingTitle: event.title, threadSummary: act.summary, updatedAt: new Date() },
      });
    await writeAudit(tx, { actor: "ollie", action: "update", entityType: "calendar_event", entityId: eventId, payload: { thread: activityId, related } });
  });
}
