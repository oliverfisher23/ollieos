import { describe, expect, it, vi } from "vitest";
import { calendarEventsTable, connectorRunsTable, db } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import { mapGoogleEvent, type CalendarRead } from "../src/services/connectors/googleCalendar";
import { DEFAULT_SCHEDULE, insideWindow, nextCheckAt, readByNow, timerTick } from "../src/services/connectors";
import { api, ingest, useServer } from "./harness";

/** What the fake Google Calendar returns next. */
let nextRead: CalendarRead | Error = { account: "ollie@example.com", events: [], found: 0, skipped: 0 };

vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/googleCalendar")>();
  return {
    ...real,
    readGoogleCalendar: async () => {
      if (nextRead instanceof Error) throw nextRead;
      return nextRead;
    },
  };
});

// Gmail and Slack are covered in connectors-messages.test.ts; here they must never reach the real services.
vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  readGmail: async () => {
    throw new (await import("../src/services/connectors/http")).ConnectorError("Not read in tests");
  },
}));
vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => {
    throw new (await import("../src/services/connectors/http")).ConnectorError("Not read in tests");
  },
}));

vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  draftCheckInFromDocs: async () => ({ text: "Hi", refs: [] }),
  writeBriefFromDocs: async () => ({ why: [], questions: [], questionsNote: "" }),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

/** A weekday at the given London wall time. Tuesday 10th November 2026 is a weekday. */
const at = (date: string, h: number, m = 0) => londonWallTimeToInstant(date, h, m);
const TUE = "2026-11-10";
const FRI = "2026-11-13";
const SAT = "2026-11-14";
const MON = "2026-11-16";

describe("reading Google Calendar events", () => {
  const base = {
    id: "ev1",
    summary: "Weekly sync",
    start: { dateTime: "2026-11-10T10:00:00Z" },
    end: { dateTime: "2026-11-10T10:30:00Z" },
  };

  it("keeps a meeting with the other attendees, their responses and the platform", () => {
    const r = mapGoogleEvent({
      ...base,
      hangoutLink: "https://meet.google.com/abc",
      attendees: [
        { email: "ollie@example.com", self: true, responseStatus: "accepted" },
        { email: "Sam@Client.com", displayName: "Sam Lee", responseStatus: "needsAction", organizer: true },
        { email: "room@resource.calendar.google.com", resource: true },
      ],
    });
    expect(r.event).toMatchObject({
      sourceRef: "ev1",
      title: "Weekly sync",
      platform: "Meet",
      personal: false,
      attendees: ["Sam Lee"],
      attendeeDetails: [{ name: "Sam Lee", email: "sam@client.com", response: "none", organiser: true }],
    });
  });

  it("leaves out cancelled, all-day, declined and non-meeting events", () => {
    expect(mapGoogleEvent({ ...base, status: "cancelled" }).skipped).toBe("cancelled");
    expect(mapGoogleEvent({ ...base, start: { date: "2026-11-10" }, end: { date: "2026-11-11" } }).skipped).toBe("all_day");
    expect(mapGoogleEvent({ ...base, eventType: "workingLocation" }).skipped).toBe("not_a_meeting");
    expect(mapGoogleEvent({ ...base, eventType: "outOfOffice" }).skipped).toBe("not_a_meeting");
    expect(mapGoogleEvent({ ...base, attendees: [{ email: "o@x.com", self: true, responseStatus: "declined" }] }).skipped).toBe("declined");
  });

  it("marks private events personal and works out Teams from the location", () => {
    const r = mapGoogleEvent({ ...base, visibility: "private", location: "https://teams.microsoft.com/l/meetup" });
    expect(r.event?.personal).toBe(true);
    expect(r.event?.platform).toBe("Teams");
  });
});

describe("the check schedule", () => {
  it("runs on weekdays inside the working window only", () => {
    expect(insideWindow(at(TUE, 6, 59), DEFAULT_SCHEDULE)).toBe(false);
    expect(insideWindow(at(TUE, 7, 0), DEFAULT_SCHEDULE)).toBe(true);
    expect(insideWindow(at(TUE, 19, 0), DEFAULT_SCHEDULE)).toBe(true);
    expect(insideWindow(at(TUE, 19, 1), DEFAULT_SCHEDULE)).toBe(false);
    expect(insideWindow(at(SAT, 10, 0), DEFAULT_SCHEDULE)).toBe(false);
  });

  it("works out the next check", () => {
    expect(nextCheckAt(at(TUE, 10, 5), DEFAULT_SCHEDULE, at(TUE, 10, 0))?.toISOString()).toBe(at(TUE, 10, 30).toISOString());
    expect(nextCheckAt(at(FRI, 19, 10), DEFAULT_SCHEDULE, at(FRI, 19, 0))?.toISOString()).toBe(at(MON, 7, 0).toISOString());
    expect(nextCheckAt(at(TUE, 10, 0), { ...DEFAULT_SCHEDULE, enabled: false }, null)).toBeNull();
  });

  it("refuses an end time before the start", async () => {
    const r = await api("connectors/schedule", { method: "PATCH", body: { start: "18:00", end: "09:00" } });
    expect(r.status).toBe(400);
    const ok = await api("connectors/schedule", { method: "PATCH", body: { everyMinutes: 60, start: "08:00" } });
    expect(ok.status).toBe(200);
    expect(ok.body.schedule).toMatchObject({ everyMinutes: 60, start: "08:00", end: "19:00", enabled: true });
  });
});

describe("who reads the calendar", () => {
  const today = todayLondon();
  const soon = londonWallTimeToInstant(addDays(today, 1), 10, 0);
  const event = (id: string, title: string) => ({
    sourceRef: id,
    title,
    startsAt: soon,
    endsAt: new Date(soon.getTime() + 30 * 60_000),
    attendees: [],
    attendeeDetails: [],
    platform: null,
    personal: false,
    personIds: [],
    projectId: null,
    location: null,
  });
  const claudeFeed = { events: [{ source_ref: "claude-1", title: "From Claude", starts_at: soon.toISOString(), ends_at: new Date(soon.getTime() + 1800_000).toISOString() }] };

  it("stays with Claude until OllieOS has read it once, then refuses Claude's copy", async () => {
    expect(await readByNow("calendar")).toBe("claude");
    expect((await ingest("calendar", { body: claudeFeed })).body.replaced).toBe(1);

    nextRead = { account: "ollie@example.com", events: [event("g-1", "From Google")], found: 2, skipped: 1 };
    const check = await api("connectors/calendar/check", { method: "POST" });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ ok: true, found: 2, account: "ollie@example.com", needsReconnect: false });
    expect(await readByNow("calendar")).toBe("ollieos");

    const rows = await db.select().from(calendarEventsTable);
    expect(rows.map((r) => r.sourceRef)).toEqual(["g-1"]);

    const refused = await ingest("calendar", { body: claudeFeed });
    expect(refused.body).toMatchObject({ ignored: true, replaced: 0 });
    expect((await db.select().from(calendarEventsTable)).map((r) => r.sourceRef)).toEqual(["g-1"]);

    const view = await api("connectors");
    const cal = view.body.services.find((s: { key: string }) => s.key === "calendar");
    expect(cal).toMatchObject({ readBy: "ollieos", chosen: false, canReadDirect: true, account: "ollie@example.com" });
    expect(cal.runs[0]).toMatchObject({ trigger: "manual", ok: true, found: 2 });
  });

  it("hands it back to Claude when Ollie chooses", async () => {
    await db.insert(connectorRunsTable).values({ connector: "calendar", trigger: "timer", startedAt: new Date(), finishedAt: new Date(), ok: true });
    const r = await api("connectors/calendar", { method: "PATCH", body: { readBy: "claude" } });
    expect(r.status).toBe(200);
    expect(r.body.services.find((s: { key: string }) => s.key === "calendar")).toMatchObject({ readBy: "claude", chosen: true });
    expect((await ingest("calendar", { body: claudeFeed })).body.replaced).toBe(1);
  });

  it("records a failed read and keeps the calendar as it was", async () => {
    await ingest("calendar", { body: claudeFeed });
    nextRead = new (await import("../src/services/connectors/googleCalendar")).ConnectorError("Google Calendar refused access. Reconnect it in Replit.", true);
    const check = await api("connectors/calendar/check", { method: "POST" });
    expect(check.body).toMatchObject({ ok: false, needsReconnect: true, error: "Google Calendar refused access. Reconnect it in Replit." });
    expect(await readByNow("calendar")).toBe("claude");
    expect((await db.select().from(calendarEventsTable)).map((r) => r.sourceRef)).toEqual(["claude-1"]);
  });

  it("will not hand a service OllieOS cannot read yet to OllieOS", async () => {
    const r = await api("connectors/drive", { method: "PATCH", body: { readBy: "ollieos" } });
    expect(r.status).toBe(400);
    expect((await api("connectors/nope", { method: "PATCH", body: { readBy: "claude" } })).status).toBe(400);
  });
});

describe("the timer", () => {
  it("runs once per interval, inside the window, however many times it ticks", async () => {
    await api("connectors/calendar", { method: "PATCH", body: { readBy: "claude" } });
    expect(await timerTick(at(SAT, 10, 0))).toBe(false);
    expect(await timerTick(at(TUE, 10, 0))).toBe(true);
    expect(await timerTick(at(TUE, 10, 1))).toBe(false);
    expect(await timerTick(at(TUE, 10, 29))).toBe(true);
    await api("connectors/schedule", { method: "PATCH", body: { enabled: false } });
    expect(await timerTick(at(TUE, 11, 30))).toBe(false);
  });
});
