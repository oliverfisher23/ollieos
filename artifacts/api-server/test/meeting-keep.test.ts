/**
 * What a meeting holds for Ollie survives the calendar: his agenda when a meeting moves out of the
 * window and back, meetings with an agenda or Granola note past the 30 day clear-out, his thread
 * verdicts after the meeting has gone, and what he said about an event being personal.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityTable, calendarEventsTable, db, meetingThreadChecksTable, parkedMeetingNotesTable } from "@workspace/db";
import { clearOldCalendar, replaceCalendar, type CalendarInput } from "../src/services/aiWrites";
import { api, useServer } from "./harness";
import { person } from "./helpers";

useServer();

const W = { actor: "test", clientId: null };
const now = new Date();
const inDays = (d: number, mins = 0) => new Date(now.getTime() + d * 86_400_000 + mins * 60_000);

const ev = (ref: string, days: number, o: Partial<CalendarInput> = {}): CalendarInput => ({
  sourceRef: ref,
  title: "Planning " + ref,
  startsAt: inDays(days),
  endsAt: inDays(days, 30),
  attendees: [],
  attendeeDetails: [],
  platform: null,
  personal: false,
  personIds: [],
  projectId: null,
  location: null,
  recurringEventId: null,
  ...o,
});
const byRef = async (ref: string) => (await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, ref)))[0];

describe("Keeping what a meeting holds", () => {
  it("parks the agenda when a meeting leaves the window before it starts, and gives it back when it returns", async () => {
    await replaceCalendar(W, [ev("a", 2), ev("b", 3)]);
    const a = await byRef("a");
    await api(`meetings/${a.id}`, { method: "PATCH", body: { notes: "1. Budget" } });

    // Moved further out: gone from the feed, so the row goes, but the agenda is parked.
    await replaceCalendar(W, [ev("b", 3)]);
    expect(await byRef("a")).toBeUndefined();
    expect(await db.select().from(parkedMeetingNotesTable)).toMatchObject([{ sourceRef: "a", notes: "1. Budget" }]);

    // Back in the window: a new row with the agenda, and nothing left parked.
    await replaceCalendar(W, [ev("a", 5), ev("b", 3)]);
    expect((await byRef("a")).notes).toBe("1. Budget");
    expect(await db.select().from(parkedMeetingNotesTable)).toHaveLength(0);
    // A meeting with no agenda leaves nothing behind.
    await replaceCalendar(W, [ev("a", 5)]);
    expect(await db.select().from(parkedMeetingNotesTable)).toHaveLength(0);
  });

  it("keeps finished meetings with an agenda or Granola note for a year, and Ollie's thread verdicts for good", async () => {
    const p = await person("Zoe Park");
    const [act] = await db.insert(activityTable).values({ entityType: "person", entityId: p.id, kind: "slack", summary: "A thread", occurredAt: now, createdBy: "test" }).returning();
    const old = (ref: string, daysAgo: number, extra: Partial<typeof calendarEventsTable.$inferInsert> = {}) =>
      db.insert(calendarEventsTable).values({ sourceRef: ref, title: ref, startsAt: inDays(-daysAgo), endsAt: inDays(-daysAgo, 30), ...extra }).returning();
    const [plain] = await old("plain", 40);
    await old("agenda", 40, { notes: "1. Hiring" });
    await old("granola", 40, { granolaRef: "not_1", granolaNotes: "Notes" });
    await old("ancient", 400, { notes: "Very old" });
    await old("recent", 10);
    await db.insert(meetingThreadChecksTable).values([
      { calendarEventId: plain.id, activityId: act.id, related: false, source: "ollie", meetingTitle: "plain", threadSummary: "A thread" },
    ]);
    const [act2] = await db.insert(activityTable).values({ entityType: "person", entityId: p.id, kind: "email", summary: "Another", occurredAt: now, createdBy: "test" }).returning();
    await db.insert(meetingThreadChecksTable).values({ calendarEventId: plain.id, activityId: act2.id, related: false, source: "ai", meetingTitle: "plain", threadSummary: "Another" });

    expect(await clearOldCalendar(now)).toBe(2);
    expect((await db.select({ ref: calendarEventsTable.sourceRef }).from(calendarEventsTable)).map((r) => r.ref).sort()).toEqual(["agenda", "granola", "recent"]);
    // Ollie's verdict stays as an example with no meeting; the matcher's own went with the meeting.
    expect(await db.select().from(meetingThreadChecksTable)).toMatchObject([{ calendarEventId: null, source: "ollie", meetingTitle: "plain" }]);
  });

  it("what Ollie says about personal stands through calendar checks and carries to the series", async () => {
    await replaceCalendar(W, [ev("v1", 1, { title: "Walter at Vets", recurringEventId: "vets" }), ev("w", 2)]);
    const v1 = await byRef("v1");
    expect((await api("meetings")).body.upcoming.map((m: { id: number }) => m.id)).toContain(v1.id);

    expect((await api(`meetings/${v1.id}/personal`, { method: "PUT", body: { personal: true } })).status).toBe(204);
    expect((await api(`meetings/${v1.id}`)).status).toBe(404);
    expect((await api("meetings")).body.upcoming.map((m: { id: number }) => m.id)).not.toContain(v1.id);

    // The calendar still says it is not private, and a new meeting in the series arrives.
    await replaceCalendar(W, [ev("v1", 1, { title: "Walter at Vets", recurringEventId: "vets" }), ev("v2", 6, { title: "Walter at Vets", recurringEventId: "vets" }), ev("w", 2)]);
    expect(await byRef("v1")).toMatchObject({ personal: true, personalSetByOllie: true });
    expect(await byRef("v2")).toMatchObject({ personal: true, personalSetByOllie: true });
    expect(await byRef("w")).toMatchObject({ personal: false, personalSetByOllie: false });

    // Undo brings the whole series back.
    await api(`meetings/${v1.id}/personal`, { method: "PUT", body: { personal: false } });
    expect((await api(`meetings/${v1.id}`)).status).toBe(200);
    expect((await byRef("v2")).personal).toBe(false);
    expect((await api("meetings/999999/personal", { method: "PUT", body: { personal: true } })).status).toBe(404);
  });

  it("the list says whether a meeting has an agenda", async () => {
    await replaceCalendar(W, [ev("h", 1)]);
    const h = await byRef("h");
    expect((await api("meetings")).body.upcoming[0]).toMatchObject({ id: h.id, hasAgenda: false });
    await api(`meetings/${h.id}`, { method: "PATCH", body: { notes: "Plan" } });
    expect((await api("meetings")).body.upcoming[0]).toMatchObject({ id: h.id, hasAgenda: true });
  });
});
