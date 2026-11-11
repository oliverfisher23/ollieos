/**
 * Part R (build plan section 19): meeting history, where time went, whether the week fits, and
 * repeating meetings worth a look.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appSettingsTable, calendarEventsTable, db, goalsTable, meetingHistoryTable, peopleTable, projectsTable, tasksTable } from "@workspace/db";
import { buildDigest } from "../src/services/digest";
import { buildRoundupContent } from "../src/services/roundup";
import { historyFromCalendar, keepSeries, markHistoryNotes, recordHistory, timeReport, weekCheck, worthALook } from "../src/services/timeAndMeetings";
import { api, useServer } from "./harness";
import { person, project } from "./helpers";

let backfillCalls = 0;
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
  readGoogleCalendarRange: async () => {
    backfillCalls++;
    const starts = new Date("2026-10-01T10:00:00Z");
    return {
      account: null,
      found: 1,
      skipped: 0,
      events: [{ sourceRef: "old-1", title: "Old planning", startsAt: starts, endsAt: new Date(starts.getTime() + 3600_000), attendees: [], attendeeDetails: [], platform: null, personal: false, personIds: [], projectId: null, location: null, recurringEventId: null }],
    };
  },
}));
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

// Monday 16th November 2026, 09:00 London (GMT).
const MONDAY = new Date("2026-11-16T09:00:00Z");
const HOUR = 3600_000;

const ev = (o: { ref: string; title?: string; starts: Date; minutes?: number; personal?: boolean; projectId?: number | null; personIds?: number[]; series?: string | null; attendees?: { name: string; email: string; organiser?: boolean }[] }) => ({
  sourceRef: o.ref,
  title: o.title ?? "Meeting",
  startsAt: o.starts,
  endsAt: new Date(o.starts.getTime() + (o.minutes ?? 60) * 60_000),
  attendees: (o.attendees ?? []).map((a) => a.name),
  attendeeDetails: o.attendees ?? [],
  personal: o.personal ?? false,
  personIds: o.personIds ?? [],
  projectId: o.projectId ?? null,
  recurringEventId: o.series ?? null,
});

describe("meeting history", () => {
  it("records meetings that have ended, with goal, function and scope, once, and never personal ones", async () => {
    const [goal] = await db.insert(goalsTable).values({ name: "Growth" }).returning();
    const launch = await project("Spring Launch");
    await db.update(projectsTable).set({ goalId: goal.id, function: "sales" }).where(eq(projectsTable.id, launch.id));
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ email: "sam@client.com" }).where(eq(peopleTable.id, sam.id));
    const events = [
      ev({ ref: "a", title: "Launch review", starts: new Date(MONDAY.getTime() - 3 * HOUR), projectId: launch.id, attendees: [{ name: "Sam Lee", email: "sam@client.com", organiser: true }] }),
      ev({ ref: "b", title: "Dentist", starts: new Date(MONDAY.getTime() - 5 * HOUR), personal: true }),
      ev({ ref: "c", title: "Later", starts: new Date(MONDAY.getTime() + 3 * HOUR) }),
    ];
    expect(await recordHistory(events, MONDAY)).toBe(1);
    expect(await recordHistory(events, MONDAY)).toBe(0);
    const [row] = await db.select().from(meetingHistoryTable);
    expect(row).toMatchObject({ sourceRef: "a", title: "Launch review", minutes: 60, scope: "external", projectId: launch.id, goalId: goal.id, businessFunction: "sales", personIds: [sam.id], organiser: "sam@client.com" });
    await markHistoryNotes("a", 2, 1);
    const [after] = await db.select().from(meetingHistoryTable);
    expect(after).toMatchObject({ hadNotes: true, actions: 2, decisions: 1 });
  });

  it("backfills 12 weeks from Google Calendar once", async () => {
    backfillCalls = 0;
    expect(await historyFromCalendar(MONDAY)).toEqual({ recorded: 0, backfilled: 1 });
    expect(await historyFromCalendar(MONDAY)).toEqual({ recorded: 0, backfilled: 0 });
    expect(backfillCalls).toBe(1);
    const [flag] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "meeting_history_backfill"));
    expect(flag.value).toMatchObject({ weeks: 12, meetings: 1 });
  });
});

describe("where time went", () => {
  it("splits this week's meeting hours by goal and function, and names thin goals", async () => {
    const [growth] = await db.insert(goalsTable).values({ name: "Growth" }).returning();
    await db.insert(goalsTable).values({ name: "Hiring" });
    const at = new Date("2026-11-17T10:00:00Z");
    await db.insert(meetingHistoryTable).values([
      { sourceRef: "1", title: "Sales sync", startsAt: at, minutes: 120, scope: "external", goalId: growth.id, businessFunction: "sales" },
      { sourceRef: "2", title: "Team", startsAt: at, minutes: 60, scope: "internal" },
      { sourceRef: "3", title: "Last week", startsAt: new Date("2026-11-10T10:00:00Z"), minutes: 30, scope: "internal" },
    ]);
    const r = await timeReport(new Date("2026-11-18T12:00:00Z"));
    const cur = r.weeks[0];
    expect(cur).toMatchObject({ weekStart: "2026-11-16", meetingHours: 3, externalHours: 2, internalHours: 1 });
    expect(cur.byGoal).toEqual([{ key: String(growth.id), label: "Growth", hours: 2 }, { key: "none", label: "Not linked", hours: 1 }]);
    expect(cur.byFunction[0]).toEqual({ key: "sales", label: "Sales", hours: 2 });
    expect(r.weeks[1]).toMatchObject({ weekStart: "2026-11-09", meetingHours: 0.5 });
    expect(r.thinGoals).toEqual(["Hiring"]);
    expect((await api("time")).status).toBe(200);
    const content = await buildRoundupContent(new Date("2026-11-11T12:00:00Z"), new Date("2026-11-18T12:00:00Z"));
    expect(content.time![0].text).toBe("3 hours in meetings, 2 towards Growth");
  });
});

describe("is this week realistic", () => {
  it("warns when what is due is over 80% of the free time, and lists only tasks that could move", async () => {
    // 09:00 to 18:00 Monday to Friday is 45 hours; 20 hours of meetings leaves 25 free.
    for (let d = 0; d < 5; d++) {
      const day = new Date(MONDAY.getTime() + d * 24 * HOUR);
      await db.insert(calendarEventsTable).values({ sourceRef: "busy-" + d, title: "Busy", startsAt: day, endsAt: new Date(day.getTime() + 4 * HOUR) });
    }
    const sam = await person("Sam Lee");
    const base = { createdBy: "ollie", status: "backlog" as const, dueDate: "2026-11-18" };
    await db.insert(tasksTable).values([
      ...Array.from({ length: 40 }, (_, i) => ({ ...base, title: "Write section " + i, priority: "medium" as const })),
      { ...base, title: "Promise to Sam", kind: "promise" as const, personId: sam.id },
      { ...base, title: "Urgent", priority: "high" as const },
      { ...base, title: "Next month", dueDate: "2026-12-20" },
    ]);
    const w = await weekCheck(MONDAY);
    expect(w).toMatchObject({ freeHours: 25, dueHours: 21, over: true, overBy: 1, dueCount: 42 });
    expect(w.movable.every((t) => t.title.startsWith("Write section"))).toBe(true);

    const digest = await buildDigest("2026-11-16", MONDAY);
    expect(digest.sections.needs!.items).toContainEqual({ text: "This week is over by about 1 hour: 21 hours due against 25 free", href: "/", refs: [], confidential: false });
  });

  it("does not warn when the week fits", async () => {
    await db.insert(tasksTable).values({ title: "One thing", status: "now", createdBy: "ollie" });
    expect(await weekCheck(MONDAY)).toMatchObject({ over: false, overBy: 0, movable: [] });
  });
});

describe("meetings worth keeping", () => {
  it("lists a repeating meeting whose last notes brought nothing, until kept", async () => {
    const now = new Date("2026-11-18T12:00:00Z");
    const weekly = (i: number, o: Partial<typeof meetingHistoryTable.$inferInsert> = {}) => ({
      sourceRef: "w" + i,
      seriesId: "series-1",
      title: "Weekly status",
      startsAt: new Date(now.getTime() - (i * 7 + 1) * 24 * HOUR),
      minutes: 60,
      scope: "internal",
      organiser: "boss@example.com",
      ...o,
    });
    await db.insert(meetingHistoryTable).values([weekly(0), weekly(1, { hadNotes: true }), weekly(2), weekly(3, { hadNotes: true, actions: 2 }), weekly(4)]);
    const list = await worthALook(now);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ seriesId: "series-1", title: "Weekly status", lastFour: { notes: 2, actions: 2, decisions: 0 }, organiser: "boss@example.com" });
    expect(list[0].note).toContain('"Weekly status"');
    await keepSeries("series-1", now);
    expect(await worthALook(now)).toEqual([]);
  });
});
