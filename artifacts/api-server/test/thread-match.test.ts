/**
 * Recent email and Slack on the prep page: only threads about the meeting, learning from Ollie's
 * "Not about this meeting".
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityTable, calendarEventsTable, db, meetingThreadChecksTable, peopleTable } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import { api, useServer } from "./harness";
import { person } from "./helpers";

type JudgeInput = { meeting: { title: string; attendees: string[] }; threads: { id: string; text: string }[]; examples: { meeting: string; thread: string; related: boolean }[] };
const judged = vi.hoisted(() => [] as JudgeInput[]);
const briefDocs = vi.hoisted(() => [] as string[][]);

// The matcher says SCORM threads are not about anything but SCORM.
vi.mock("../src/services/threadJudge", () => ({
  judgeThreads: async (input: JudgeInput) => {
    judged.push(input);
    return input.threads.map((t) => ({ id: t.id, related: !/SCORM/i.test(t.text) || /SCORM/i.test(input.meeting.title), reason: "About SCORM, not this" }));
  },
}));
vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  writeBriefFromDocs: async (_m: unknown, docs: AiDoc[]) => {
    briefDocs.push(docs.map((d) => d.ref));
    return { why: [], agenda: [], questions: [], questionsNote: "" };
  },
}));

useServer();

const today = todayLondon();
const at = (days: number, h: number) => londonWallTimeToInstant(addDays(today, days), h, 0);

async function zoe() {
  const p = await person("Zoe Park");
  await db.update(peopleTable).set({ email: "zoe@example.test" }).where(eq(peopleTable.id, p.id));
  return p;
}

async function thread(personId: number, summary: string, daysAgo: number) {
  const [row] = await db
    .insert(activityTable)
    .values({ entityType: "person", entityId: personId, kind: "slack", summary, occurredAt: new Date(Date.now() - daysAgo * 86_400_000), createdBy: "test" })
    .returning();
  return row;
}

async function meeting(ref: string, title: string, days: number, series: string | null = null) {
  const [row] = await db
    .insert(calendarEventsTable)
    .values({
      sourceRef: ref,
      title,
      startsAt: at(days, 11),
      endsAt: new Date(at(days, 11).getTime() + 45 * 60_000),
      attendees: ["Zoe Park"],
      attendeeDetails: [{ name: "Zoe Park", email: "zoe@example.test" }],
      recurringEventId: series,
    })
    .returning();
  return row;
}

describe("Recent email and Slack on the prep page", () => {
  it("shows only threads the matcher thinks are about the meeting, and caches its verdicts", async () => {
    judged.length = 0;
    const z = await zoe();
    const scorm = await thread(z.id, "Zoe confirmed the SCORM publish fix is working", 1);
    const data = await thread(z.id, "Zoe shared the data warehouse schema for Studio", 2);
    const ev = await meeting("t1", "Studio Signals Data - Scoping", 1);

    const v = (await api(`briefs/${ev.id}`)).body;
    expect(v.threads.map((t: { id: number }) => t.id)).toEqual([data.id]);
    expect(v.threadsHidden).toMatchObject([{ id: scorm.id, by: "ai", reason: "About SCORM, not this" }]);
    expect(judged).toHaveLength(1);
    expect(judged[0].meeting.attendees).toEqual(["Zoe Park"]);

    // Judged once per meeting.
    await api(`briefs/${ev.id}`);
    expect(judged).toHaveLength(1);
  });

  it("Ollie's verdict wins, carries to the rest of the series, and is handed to the matcher as an example", async () => {
    judged.length = 0;
    const z = await zoe();
    const data = await thread(z.id, "Zoe shared the data warehouse schema for Studio", 2);
    const first = await meeting("s1", "Weekly sync", 1, "series-1");

    expect((await api(`briefs/${first.id}`)).body.threads.map((t: { id: number }) => t.id)).toEqual([data.id]);
    expect((await api(`meetings/${first.id}/threads/${data.id}`, { method: "PUT", body: { related: false } })).status).toBe(204);
    const after = (await api(`briefs/${first.id}`)).body;
    expect(after.threads).toEqual([]);
    expect(after.threadsHidden).toMatchObject([{ id: data.id, by: "ollie" }]);

    // The next meeting in the series hides it without asking; a different meeting learns from it.
    const next = await meeting("s2", "Weekly sync", 8, "series-1");
    expect((await api(`briefs/${next.id}`)).body.threadsHidden.map((t: { id: number }) => t.id)).toEqual([data.id]);
    const other = await meeting("o1", "Hiring plan", 2);
    await thread(z.id, "Zoe asked about interview slots", 1);
    await api(`briefs/${other.id}`);
    const last = judged[judged.length - 1];
    expect(last.examples).toEqual([{ meeting: "Weekly sync", thread: "Zoe shared the data warehouse schema for Studio", related: false }]);

    // "It is about this meeting" puts it back.
    await api(`meetings/${first.id}/threads/${data.id}`, { method: "PUT", body: { related: true } });
    expect((await api(`briefs/${first.id}`)).body.threads.map((t: { id: number }) => t.id)).toContain(data.id);
    const [row] = await db.select().from(meetingThreadChecksTable).where(eq(meetingThreadChecksTable.calendarEventId, first.id));
    expect(row).toMatchObject({ related: true, source: "ollie", meetingTitle: "Weekly sync" });
  });

  it("keeps threads judged not about the meeting out of the brief writer", async () => {
    briefDocs.length = 0;
    const z = await zoe();
    const scorm = await thread(z.id, "Zoe confirmed the SCORM publish fix is working", 1);
    const ev = await meeting("b1", "Data scoping", 1);
    await db.insert(meetingThreadChecksTable).values({ calendarEventId: ev.id, activityId: scorm.id, related: false, source: "ollie", meetingTitle: ev.title, threadSummary: scorm.summary });
    await api(`briefs/${ev.id}`);
    expect(briefDocs.flat()).not.toContain(`activity:${scorm.id}`);
  });

  it("refuses verdicts on personal events and missing threads", async () => {
    const z = await zoe();
    const a = await thread(z.id, "Something", 1);
    const [personal] = await db.insert(calendarEventsTable).values({ sourceRef: "p1", title: "Dentist", startsAt: at(1, 9), endsAt: at(1, 10), personal: true }).returning();
    expect((await api(`meetings/${personal.id}/threads/${a.id}`, { method: "PUT", body: { related: false } })).status).toBe(404);
    const ev = await meeting("m1", "Sync", 1);
    expect((await api(`meetings/${ev.id}/threads/999999`, { method: "PUT", body: { related: false } })).status).toBe(404);
  });
});
