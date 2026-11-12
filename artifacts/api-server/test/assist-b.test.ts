/**
 * Assist, Part B: the Meetings page and the extended prep page.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityTable, calendarEventsTable, db, linksTable, meetingBriefsTable, peopleTable, tasksTable } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import { api, useServer } from "./harness";
import { fact, person, task } from "./helpers";

vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  writeBriefFromDocs: async (_meeting: unknown, docs: AiDoc[]) => {
    const cited = docs.filter((d) => d.ref.startsWith("fact:"));
    return {
      why: cited.map((d) => ({ text: `Because of ${d.ref}.`, refs: [d.ref] })),
      agenda: [
        { text: "Agree next steps", refs: cited.slice(0, 1).map((d) => d.ref) },
        { text: "Invented item", refs: ["fact:9999"] },
      ],
      questions: [{ text: "What matters most?", refs: [] }],
      questionsNote: "",
    };
  },
}));

useServer();

const today = todayLondon();
/** A London wall time on a day relative to today. */
const at = (days: number, time: string) => {
  const [h, m] = time.split(":").map(Number);
  return londonWallTimeToInstant(addDays(today, days), h, m);
};

async function event(ref: string, starts: Date, opts: { title?: string; attendees?: { name: string; email?: string }[]; personal?: boolean } = {}) {
  const [row] = await db
    .insert(calendarEventsTable)
    .values({
      sourceRef: ref,
      title: opts.title ?? "Catch-up " + ref,
      startsAt: starts,
      endsAt: new Date(starts.getTime() + 30 * 60_000),
      attendees: (opts.attendees ?? []).map((a) => a.name),
      attendeeDetails: opts.attendees ?? [],
      personal: opts.personal ?? false,
      platform: "Teams",
    })
    .returning();
  return row;
}

async function sam() {
  const p = await person("Sam Lee", { role: "Head of Talent" });
  await db.update(peopleTable).set({ email: "sam@example.test", cadence: "fortnightly" }).where(eq(peopleTable.id, p.id));
  return p;
}

const SAM = { name: "Sam Lee", email: "sam@example.test" };

describe("Meetings list", () => {
  it("lists every work meeting this week with readiness, and past meetings with Granola notes", async () => {
    const s = await sam();
    await db.insert(tasksTable).values([
      { title: "Send the pilot plan", kind: "promise", status: "now", personId: s.id, createdBy: "test" },
      { title: "Sam to share the shortlist", kind: "task", status: "waiting", waitingOnPersonId: s.id, waitingSince: new Date(), createdBy: "test" },
    ]);
    const todays = await event("t1", at(0, "23:00"), { attendees: [SAM, { name: "Guest Person", email: "guest@elsewhere.test" }] });
    const later = await event("t2", at(4, "10:00"), { attendees: [SAM] });
    const stranger = await event("t3", at(2, "09:00"), { attendees: [{ name: "Nobody Known", email: "x@gmail.com" }] });
    await event("t4", at(1, "12:00"), { personal: true });
    await event("t5", at(8, "12:00"), { attendees: [SAM] });
    const past = await event("p1", at(-3, "15:00"), { attendees: [SAM] });
    await event("p2", at(-20, "15:00"), { attendees: [SAM] });
    await db.insert(meetingBriefsTable).values({ calendarEventId: past.id, generatedAt: new Date(), granolaNotes: "We agreed the January pilot.\nSam owns the shortlist." });

    const r = await api("meetings");
    expect(r.status).toBe(200);
    expect(r.body.today).toBe(today);
    expect(r.body.upcoming.map((m: { id: number }) => m.id)).toEqual([todays.id, stranger.id, later.id]);
    const first = r.body.upcoming[0];
    expect(first).toMatchObject({ day: today, prep: "not_written", promises: 1, waiting: 1, platform: "Teams" });
    expect(first.attendees).toEqual([
      { name: "Sam Lee", slug: s.slug },
      { name: "Guest Person", slug: null },
    ]);
    expect(r.body.upcoming[1]).toMatchObject({ id: stranger.id, prep: "none", promises: 0, waiting: 0 });
    expect(r.body.past).toHaveLength(1);
    expect(r.body.past[0]).toMatchObject({ id: past.id, granolaSnippet: "We agreed the January pilot. Sam owns the shortlist." });

    // Opening a meeting writes its brief, and the list then shows it ready.
    expect((await api(`briefs/${later.id}`)).status).toBe(200);
    const again = await api("meetings");
    expect(again.body.upcoming.find((m: { id: number }) => m.id === later.id).prep).toBe("not_much");
  });

  it("a written brief with a summary shows as ready", async () => {
    const s = await sam();
    await fact("person", s.id, "Sam is hiring two graduates in January");
    const ev = await event("r1", at(1, "10:00"), { attendees: [SAM] });
    await api(`briefs/${ev.id}`);
    const r = await api("meetings");
    expect(r.body.upcoming[0]).toMatchObject({ id: ev.id, prep: "ready" });
  });
});

describe("Prep page", () => {
  it("shows facts and cadence, both directions of open work, earlier Granola notes, threads and an agenda", async () => {
    const s = await sam();
    const f = await fact("person", s.id, "Sam is hiring two graduates in January");
    const own = await task("Book the venue for Sam", { personId: s.id });
    const [waiting] = await db
      .insert(tasksTable)
      .values({ title: "Sam to share the shortlist", kind: "task", status: "waiting", waitingOnPersonId: s.id, waitingSince: new Date(), createdBy: "test" })
      .returning();
    const [promise] = await db.insert(tasksTable).values({ title: "Send the pilot plan", kind: "promise", status: "now", personId: s.id, createdBy: "test" }).returning();

    const before = await event("e0", at(-5, "11:00"), { title: "Pilot kick-off", attendees: [SAM] });
    await db.insert(meetingBriefsTable).values({ calendarEventId: before.id, generatedAt: new Date(), attendeeIds: [s.id], granolaNotes: "Sam wants the pilot in January." });
    const [email] = await db
      .insert(activityTable)
      .values({ entityType: "person", entityId: s.id, kind: "email", summary: "Sam sent the draft timeline", sourceUrl: "https://mail.example.test/1", occurredAt: new Date(), createdBy: "test" })
      .returning();
    const [slack] = await db
      .insert(activityTable)
      .values({ entityType: null, entityId: null, kind: "slack", summary: "Sam asked about budget", occurredAt: new Date(Date.now() - 86_400_000), createdBy: "test" })
      .returning();
    await db.insert(linksTable).values({ fromType: "activity", fromId: slack.id, toType: "person", toId: s.id, createdBy: "test" });
    // A note is not a thread.
    await db.insert(activityTable).values({ entityType: "person", entityId: s.id, kind: "note", summary: "Not a thread", occurredAt: new Date(), createdBy: "test" });

    const ev = await event("e1", at(1, "10:00"), { title: "Pilot review", attendees: [SAM] });
    const r = await api(`briefs/${ev.id}`);
    expect(r.status).toBe(200);
    const v = r.body;
    expect(v.attendees[0].person).toMatchObject({
      facts: [{ id: f.id, text: "Sam is hiring two graduates in January", needsCheck: false }],
      cadence: { label: expect.any(String), status: "overdue" },
    });
    expect(v.promises.map((p: { id: number }) => p.id)).toEqual([promise.id]);
    expect(v.tasks).toEqual([expect.objectContaining({ id: own.id, personName: "Sam Lee" })]);
    expect(v.waitingOn).toEqual([expect.objectContaining({ id: waiting.id, title: "Sam to share the shortlist", personName: "Sam Lee" })]);
    expect(v.earlier).toEqual([expect.objectContaining({ eventId: before.id, title: "Pilot kick-off", notes: "Sam wants the pilot in January.", people: ["Sam Lee"] })]);
    expect(v.threads.map((t: { id: number }) => t.id)).toEqual([email.id, slack.id]);
    expect(v.threads[0]).toMatchObject({ kind: "email", url: "https://mail.example.test/1" });
    // The agenda keeps items with real citations or none; the invented citation is dropped.
    expect(v.agenda.map((l: { text: string }) => l.text)).toEqual(["Agree next steps", "Invented item"]);
    expect(v.agenda[0].sources).toHaveLength(1);
    expect(v.agenda[1].sources).toHaveLength(0);
  });

  it("earlier notes come only from meetings before this one with someone in common", async () => {
    const s = await sam();
    const other = await person("Alex Kay");
    await fact("person", s.id, "Sam runs talent");
    const ev = await event("x1", at(1, "10:00"), { attendees: [SAM] });
    const afterIt = await event("x2", at(2, "10:00"), { attendees: [SAM] });
    const unrelated = await event("x3", at(-2, "10:00"), { attendees: [{ name: "Alex Kay" }] });
    await db.insert(meetingBriefsTable).values([
      { calendarEventId: afterIt.id, generatedAt: new Date(), attendeeIds: [s.id], granolaNotes: "Later notes" },
      { calendarEventId: unrelated.id, generatedAt: new Date(), attendeeIds: [other.id], granolaNotes: "Other notes" },
    ]);
    const v = (await api(`briefs/${ev.id}`)).body;
    expect(v.earlier).toEqual([]);
  });

  it("a brief with not much on file shows no agenda", async () => {
    await sam();
    const ev = await event("n1", at(1, "10:00"), { attendees: [SAM] });
    const v = (await api(`briefs/${ev.id}`)).body;
    expect(v).toMatchObject({ notMuch: true, agenda: null, earlier: [], threads: [], tasks: [], waitingOn: [] });
  });
});

describe("Meeting page without a brief", () => {
  it("opens any work meeting, keeps Ollie's agenda, and moves to a brief once someone is in People", async () => {
    // Ollie's own address makes ourco.test his company, so the colleague below is internal.
    const me = await person("Ollie Self");
    await db.update(peopleTable).set({ isSelf: true, email: "ollie@ourco.test" }).where(eq(peopleTable.id, me.id));
    const ev = await event("np1", at(1, "11:00"), { title: "Weekly huddle", attendees: [{ name: "andy.dillow@ourco.test", email: "andy.dillow@ourco.test" }] });

    const v = (await api(`meetings/${ev.id}`)).body;
    expect(v).toMatchObject({ id: ev.id, title: "Weekly huddle", prep: "none", notes: null });
    expect(v.attendees).toEqual([{ name: "andy.dillow@ourco.test", email: "andy.dillow@ourco.test", person: null }]);

    const saved = await api(`meetings/${ev.id}`, { method: "PATCH", body: { notes: "1. Hiring plan\n2. Budget" } });
    expect(saved.status).toBe(200);
    expect(saved.body.notes).toBe("1. Hiring plan\n2. Budget");
    expect((await api(`meetings/${ev.id}`)).body.notes).toBe("1. Hiring plan\n2. Budget");
    expect((await api("meetings")).body.upcoming.find((r: { id: number }) => r.id === ev.id).prep).toBe("none");

    // Adding the attendee to People gives the meeting a brief, and the agenda goes with it.
    const p = await api("people", { method: "POST", body: { name: "Andy Dillow", email: "andy.dillow@ourco.test" } });
    expect(p.status).toBe(201);
    const after = (await api(`meetings/${ev.id}`)).body;
    expect(after.prep).toBe("not_written");
    expect(after.attendees[0].person).toMatchObject({ id: p.body.id, name: "Andy Dillow" });
    expect((await api(`briefs/${ev.id}`)).body.notes).toBe("1. Hiring plan\n2. Budget");

    // Clearing the notes from the prep page clears them everywhere.
    await api(`briefs/${ev.id}`, { method: "PATCH", body: { notes: "  " } });
    expect((await api(`meetings/${ev.id}`)).body.notes).toBeNull();
  });

  it("notes written on the brief before they moved still show, and move to the meeting when edited", async () => {
    await sam();
    const ev = await event("np2", at(1, "12:00"), { attendees: [SAM] });
    await api(`briefs/${ev.id}`);
    await db.update(meetingBriefsTable).set({ notes: "Older note" }).where(eq(meetingBriefsTable.calendarEventId, ev.id));
    expect((await api(`briefs/${ev.id}`)).body.notes).toBe("Older note");
    expect((await api(`meetings/${ev.id}`)).body.notes).toBe("Older note");

    await api(`briefs/${ev.id}`, { method: "PATCH", body: { notes: "Newer note" } });
    const [b] = await db.select().from(meetingBriefsTable).where(eq(meetingBriefsTable.calendarEventId, ev.id));
    const [e] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, ev.id));
    expect(b.notes).toBeNull();
    expect(e.notes).toBe("Newer note");
    expect((await api(`briefs/${ev.id}`)).body.notes).toBe("Newer note");
  });

  it("personal events and missing meetings answer 404, and Worth a look still has its own route", async () => {
    const personal = await event("np3", at(1, "13:00"), { personal: true });
    expect((await api(`meetings/${personal.id}`)).status).toBe(404);
    expect((await api(`meetings/${personal.id}`, { method: "PATCH", body: { notes: "x" } })).status).toBe(404);
    expect((await api("meetings/999999")).status).toBe(404);
    expect((await api("meetings/worth-a-look")).status).toBe(200);
  });
});
