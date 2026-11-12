/**
 * Part K (build plan section 14): "Next time I see…" points, the follow-up draft after an external
 * meeting, and the prep reminder.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, peopleTable, replyDraftsTable, talkingPointsTable, tasksTable } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import { notPreppedIds } from "../src/services/briefs";
import { captureMeetings } from "../src/services/connectors/meetingCapture";
import type { MeetingNote } from "../src/services/connectors/granola";
import { buildDigest } from "../src/services/digest";
import { api, call, connect, mcp, OLLIE, useServer } from "./harness";
import { person } from "./helpers";

let covered: string[] = [];
let meetingPrompts: string[] = [];
let followUps: { title: string; to: string[] }[] = [];
let gmailDrafts: { to: string; subject: string }[] = [];

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    meetingPrompts.push(content);
    return { summary: "Talked renewal", project: "", items: [{ ref: "granola:n1", type: "task", title: "Send Sam the pricing", action: "", priority: "medium", due: "2026-11-20", project: "", person: "Sam Lee", quote: "", confidential: false }], decisions: [{ text: "Renew for two years", project: "", topic: "Renewal", confidential: false }], progress: [], covered };
  },
}));
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  writeBriefFromDocs: async () => ({ why: [], questions: [], questionsNote: "", agenda: [] }),
  digestSummaryFromLines: async () => "Summary.",
  draftFollowUpFromDocs: async (o: { title: string; to: string[] }) => {
    followUps.push(o);
    return { subject: `Following up: ${o.title}`, body: "Hi Sam,\n\nThanks for today.\n\nBest, Ollie" };
  },
}));
vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  saveGmailDraft: async (_thread: string | null, _draft: string | null, d: { to: string; subject: string }) => {
    gmailDrafts.push(d);
    return "draft-1";
  },
  gmailAccount: async () => OLLIE,
}));

useServer();

async function sam() {
  const p = await person("Sam Lee");
  await db.update(peopleTable).set({ email: "sam@client.com" }).where(eq(peopleTable.id, p.id));
  return p;
}

async function meeting(o: { ref: string; title: string; starts: Date; attendees: { name: string; email: string }[]; personIds: number[] }) {
  const [e] = await db
    .insert(calendarEventsTable)
    .values({ sourceRef: o.ref, title: o.title, startsAt: o.starts, endsAt: new Date(o.starts.getTime() + 30 * 60_000), attendees: o.attendees.map((a) => a.name), attendeeDetails: o.attendees, personIds: o.personIds })
    .returning();
  return e;
}

const note = (o: Partial<MeetingNote> = {}): MeetingNote => ({
  noteId: "n1",
  title: "Renewal call",
  url: "https://notes.granola.ai/d/n1",
  at: new Date(Date.now() - 3600_000),
  calendarEventId: "cal-k1",
  ownedByMe: true,
  people: [{ name: "Sam Lee", email: "sam@client.com" }],
  notes: "We talked about the renewal. Sam asked for pricing by the 20th.",
  ...o,
});

describe("Next time I see points", () => {
  it("are added, listed, ticked and put back from the person page, and show on the next meeting's prep page", async () => {
    const p = await sam();
    const slug = p.slug;
    expect((await api(`people/${slug}/points`, { body: { text: "Ask about the renewal" } })).status).toBe(201);
    let list = (await api(`people/${slug}/points`)).body;
    expect(list.open).toHaveLength(1);
    expect(list.open[0]).toMatchObject({ text: "Ask about the renewal", status: "open", createdBy: "ollie" });

    const e = await meeting({ ref: "cal-k0", title: "Catch-up with Sam", starts: new Date(Date.now() + 2 * 3600_000), attendees: [{ name: "Sam Lee", email: "sam@client.com" }], personIds: [p.id] });
    const brief = (await api(`briefs/${e.id}`)).body;
    expect(brief.talkingPoints.map((x: { text: string }) => x.text)).toEqual(["Ask about the renewal"]);
    // Added from the prep page too.
    expect((await api(`briefs/${e.id}/points`, { body: { personId: p.id, text: "Thank them for the intro" } })).status).toBe(201);
    expect((await api(`briefs/${e.id}`)).body.talkingPoints).toHaveLength(2);

    const id = list.open[0].id;
    expect((await api(`points/${id}`, { method: "PATCH", body: { raised: true } })).body).toMatchObject({ status: "raised", raisedHow: "ollie" });
    list = (await api(`people/${slug}/points`)).body;
    expect(list.open).toHaveLength(1);
    expect(list.raised).toHaveLength(1);
    await api(`points/${id}`, { method: "PATCH", body: { raised: false } });
    expect((await api(`people/${slug}/points`)).body.open).toHaveLength(2);
    expect((await api(`points/${id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("can be added by Claude", async () => {
    const p = await sam();
    const { access_token } = await connect("Claude");
    const c = await mcp(access_token);
    const r = await call(c, "add_talking_point", { person: { name: "Sam Lee" }, text: "Mention the conference" });
    expect(r.isError).toBeFalsy();
    expect(r.json).toMatchObject({ point: { person: `person:${p.id}`, text: "Mention the conference", status: "open" } });
    const list = (await api(`people/${p.slug}/points`)).body;
    expect(list.open[0]).toMatchObject({ createdBy: "Claude" });
  });
});

describe("after a meeting", () => {
  it("marks covered points raised from the Granola notes and drafts one follow-up to Gmail for an external meeting", async () => {
    const p = await sam();
    const e = await meeting({ ref: "cal-k1", title: "Renewal call", starts: new Date(Date.now() - 2 * 3600_000), attendees: [{ name: "Sam Lee", email: "sam@client.com" }], personIds: [p.id] });
    const [raise, carry] = await db.insert(talkingPointsTable).values([{ personId: p.id, text: "Ask about the renewal", createdBy: "ollie" }, { personId: p.id, text: "Ask about their hiring", createdBy: "ollie" }]).returning();
    covered = [`point:${raise.id}`, "point:999999"];
    meetingPrompts = [];
    followUps = [];
    gmailDrafts = [];
    const counts = await captureMeetings([note()], { me: "His email address is " + OLLIE, now: new Date(), myEmails: new Set([OLLIE]) });
    expect(meetingPrompts[0]).toContain(`[point:${raise.id}] Sam Lee: Ask about the renewal`);
    expect(counts).toMatchObject({ points_covered: 1, follow_ups: 1 });
    const [r] = await db.select().from(talkingPointsTable).where(eq(talkingPointsTable.id, raise.id));
    expect(r).toMatchObject({ status: "raised", raisedHow: "notes", raisedTitle: "Renewal call", raisedEventId: e.id });
    const [c] = await db.select().from(talkingPointsTable).where(eq(talkingPointsTable.id, carry.id));
    expect(c.status).toBe("open");

    expect(followUps).toEqual([expect.objectContaining({ title: "Renewal call", to: ["Sam Lee"] })]);
    expect(gmailDrafts).toEqual([expect.objectContaining({ to: "Sam Lee <sam@client.com>", subject: "Following up: Renewal call" })]);
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.sourceRef, "granola:n1#follow-up"));
    expect(task).toMatchObject({ title: "Send the follow-up for Renewal call", status: "now", source: "meeting" });
    const [draft] = await db.select().from(replyDraftsTable).where(eq(replyDraftsTable.taskId, task.id));
    expect(draft).toMatchObject({ state: "ready", gmailDraftId: "draft-1" });
    expect(draft.savedAt).not.toBeNull();
    const drafts = (await api("email/drafts")).body.items;
    expect(drafts.find((d: { task: { id: number } }) => d.task.id === task.id)).toMatchObject({ followUp: true, chase: false });
    expect((await api(`briefs/${e.id}`)).body.followUpTaskId).toBe(task.id);

    // The same notes again: no second follow-up.
    await captureMeetings([note()], { me: "", now: new Date(), myEmails: new Set([OLLIE]) });
    expect(followUps).toHaveLength(1);
  });

  it("writes no follow-up for an internal meeting", async () => {
    const colleague = await person("Amy Park");
    await db.update(peopleTable).set({ email: "amy@example.com" }).where(eq(peopleTable.id, colleague.id));
    await meeting({ ref: "cal-k2", title: "Team sync", starts: new Date(Date.now() - 2 * 3600_000), attendees: [{ name: "Amy Park", email: "amy@example.com" }], personIds: [colleague.id] });
    covered = [];
    followUps = [];
    const counts = await captureMeetings([note({ noteId: "n2", calendarEventId: "cal-k2", people: [{ name: "Amy Park", email: "amy@example.com" }] })], { me: "", now: new Date(), myEmails: new Set([OLLIE]) });
    expect(counts.follow_ups ?? 0).toBe(0);
    expect(followUps).toHaveLength(0);
  });
});

describe("prep reminder", () => {
  it("lists an external meeting today until its prep page is opened", async () => {
    const p = await sam();
    const day = addDays(todayLondon(), 1);
    const morning = londonWallTimeToInstant(day, 8, 0);
    const e = await meeting({ ref: "cal-k3", title: "Pricing review", starts: londonWallTimeToInstant(day, 15, 0), attendees: [{ name: "Sam Lee", email: "sam@client.com" }], personIds: [p.id] });
    expect([...(await notPreppedIds([e], morning))]).toEqual([e.id]);
    let digest = await buildDigest(day, morning);
    expect(digest.sections.needs!.items).toContainEqual({ text: "Not prepped yet: Pricing review at 15:00", href: `/briefs/${e.id}`, refs: [], confidential: false });

    expect((await api(`briefs/${e.id}`)).body.openedAt).not.toBeNull();
    expect([...(await notPreppedIds([e], morning))]).toEqual([]);
    digest = await buildDigest(day, morning);
    expect((digest.sections.needs?.items ?? []).some((i) => i.text.startsWith("Not prepped"))).toBe(false);
  });
});
