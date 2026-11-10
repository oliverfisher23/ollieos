import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, digestsTable, meetingBriefsTable, peopleTable, suggestionsTable, tasksTable } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon, weekday } from "@workspace/shared";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import { buildDigest, digestWindowStart } from "../src/services/digest";
import { fact, person, project } from "./helpers";
import { api, call, connect, ingest, mcp, useServer } from "./harness";

/** What each brief and summary call was given. */
const briefDocs: AiDoc[][] = [];
const summaryLines: string[][] = [];

vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  draftCheckInFromDocs: async () => ({ text: "Hi", refs: [] }),
  // One sentence per fact or activity it was given, citing it; plus one citing a made-up ref
  // and one citing nothing, which the brief must drop.
  writeBriefFromDocs: async (_meeting: unknown, docs: AiDoc[]) => {
    briefDocs.push(docs);
    const cited = docs.filter((d) => d.ref.startsWith("fact:") || d.ref.startsWith("activity:"));
    return {
      why: [
        ...cited.map((d) => ({ text: `Because of ${d.ref}.`, refs: [d.ref] })),
        { text: "Invented reason.", refs: ["fact:9999"] },
        { text: "Uncited reason.", refs: [] },
      ],
      questions: [{ text: "What would make this worthwhile?", refs: cited.slice(0, 1).map((d) => d.ref) }],
      questionsNote: "",
    };
  },
  digestSummaryFromLines: async (lines: string[]) => {
    summaryLines.push(lines);
    return "Overnight things moved.";
  },
}));

useServer();

const inMinutes = (n: number) => new Date(Date.now() + n * 60_000);

/** Sends one calendar event through ingest and returns its row. */
async function meeting(ref: string, opts: { title?: string; startsIn?: number; minutes?: number; attendees?: unknown[]; personal?: boolean; project?: string } = {}) {
  const starts = inMinutes(opts.startsIn ?? 30);
  const r = await ingest("calendar", {
    body: {
      events: [
        {
          source_ref: ref,
          title: opts.title ?? "Catch-up",
          starts_at: starts.toISOString(),
          ends_at: new Date(starts.getTime() + (opts.minutes ?? 30) * 60_000).toISOString(),
          attendees: opts.attendees ?? [],
          personal: opts.personal ?? false,
          ...(opts.project ? { project: opts.project } : {}),
          platform: "Teams",
        },
      ],
    },
  });
  expect(r.status).toBe(200);
  const [row] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, ref));
  return row;
}

async function finishSweep() {
  const r = await ingest("sweep-run", { body: { finished_at: new Date().toISOString() } });
  expect(r.status).toBe(201);
  return r.body.scheduled as Record<string, any>;
}

async function sam() {
  const p = await person("Sam Lee", { role: "Head of Talent" });
  await db.update(peopleTable).set({ email: "sam@example.test" }).where(eq(peopleTable.id, p.id));
  return p;
}

/* ---------- 03 Meeting briefs ---------- */

describe("03 Meeting briefs", () => {
  it("criterion 1: a work meeting with a known attendee has a brief before it starts", async () => {
    const s = await sam();
    await fact("person", s.id, "Sam is hiring two graduates in January");
    const ev = await meeting("m1", { attendees: [{ name: "Sam Lee", email: "SAM@example.test", response: "accepted" }] });
    const scheduled = await finishSweep();
    expect(scheduled.briefs).toMatchObject({ built: 1, failed: 0 });
    const [brief] = await db.select().from(meetingBriefsTable).where(eq(meetingBriefsTable.calendarEventId, ev.id));
    expect(brief).toBeTruthy();
    expect(brief.attendeeIds).toEqual([s.id]);
    expect(ev.startsAt.getTime() - brief.generatedAt.getTime()).toBeGreaterThanOrEqual(29 * 60_000);

    // Opening it within 3 hours does not write it again.
    const view = (await api(`briefs/${ev.id}`)).body;
    expect(new Date(view.generatedAt).getTime()).toBe(brief.generatedAt.getTime());
    expect(view.attendees[0]).toMatchObject({ name: "Sam Lee", response: "accepted", person: { id: s.id } });
    expect((await api("briefs/next")).body.event.id).toBe(ev.id);
  });

  it("criterion 2: every statement in Why this meeting links to a source", async () => {
    const s = await sam();
    const f = await fact("person", s.id, "Sam asked for a proposal by Friday");
    const ev = await meeting("m2", { attendees: ["Sam Lee"] });
    const view = (await api(`briefs/${ev.id}`)).body;
    expect(view.notMuch).toBe(false);
    expect(view.why.map((l: { text: string }) => l.text)).toEqual([`Because of fact:${f.id}.`]);
    for (const line of view.why) {
      expect(line.sources.length).toBeGreaterThan(0);
      for (const src of line.sources) expect(src.href).toBeTruthy();
    }
    expect(view.sourcesLine).toBe("Built from 1 fact");
  });

  it("with nothing citable on file, the brief says so instead of padding", async () => {
    await sam();
    const ev = await meeting("m2b", { attendees: ["Sam Lee"] });
    const view = (await api(`briefs/${ev.id}`)).body;
    expect(view).toMatchObject({ notMuch: true, why: null, questions: null });
    expect(view.attendees).toHaveLength(1);
  });

  it("criterion 3: a personal event never gets a brief", async () => {
    const s = await sam();
    await fact("person", s.id, "Sam likes football");
    const ev = await meeting("m3", { title: "Football with Sam", personal: true, attendees: ["Sam Lee"] });
    const scheduled = await finishSweep();
    expect(scheduled.briefs).toMatchObject({ built: 0 });
    expect(await db.select().from(meetingBriefsTable)).toEqual([]);
    expect((await api(`briefs/${ev.id}`)).status).toBe(404);
    expect((await api("briefs/next")).status).toBe(404);
    const home = (await api("home")).body;
    for (const e of home.today) expect(e.hasBrief).toBe(false);
  });

  it("an event with nobody and nothing known gets no brief", async () => {
    const ev = await meeting("m3b", { title: "Vendor demo", attendees: ["stranger@gmail.com"] });
    expect((await api(`briefs/${ev.id}`)).status).toBe(404);
  });

  it("an event with a stranger from an outside company gets a brief, marked external", async () => {
    const ev = await meeting("m3c", { title: "Vendor demo", attendees: ["stranger@elsewhere.test"] });
    const r = await api(`briefs/${ev.id}`);
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({ scope: "external", companies: ["elsewhere.test"] });
    expect(r.body.research).toEqual([expect.objectContaining({ domain: "elsewhere.test", status: "none", body: null })]);
  });

  it("criterion 4: open promises to any attendee appear in What you promised", async () => {
    const s = await sam();
    const jo = await person("Jo Bloggs");
    const [p1] = await db.insert(tasksTable).values({ title: "Send Sam the deck", kind: "promise", status: "now", personId: s.id, createdBy: "test" }).returning();
    const [p2] = await db.insert(tasksTable).values({ title: "Intro Jo to the bank", kind: "promise", status: "backlog", personId: jo.id, createdBy: "test" }).returning();
    await db.insert(tasksTable).values({ title: "Already sent", kind: "promise", status: "done", personId: s.id, createdBy: "test" });
    const ev = await meeting("m4", { attendees: ["Sam Lee", "Jo Bloggs"] });
    const view = (await api(`briefs/${ev.id}`)).body;
    expect(view.promises.map((p: { id: number }) => p.id).sort()).toEqual([p1.id, p2.id].sort());
  });

  it("criterion 5: after the meeting, Granola notes appear on the brief and actions go to the Inbox", async () => {
    const s = await sam();
    const shed = await project("Garden shed");
    const ev = await meeting("m5", { startsIn: -60, attendees: ["Sam Lee"], project: "Garden shed" });
    // The sweep already captured one action from Granola; the same source_ref links it.
    const pre = await ingest("tasks", { body: [{ source: "meeting", source_ref: "granola-1#a1", title: "Send Sam the shed quote" }] });
    expect(pre.body.results[0].outcome).toBe("created");

    const r = await ingest("meeting-notes", {
      body: {
        calendar_source_ref: "m5",
        granola_ref: "granola-1",
        notes: "Sam wants the quote by Friday.",
        actions: [{ title: "Send Sam the shed quote", source_ref: "granola-1#a1" }, { title: "Book the surveyor" }],
        decisions: [{ text: "Go with the timber frame" }],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.actions.map((a: { outcome: string }) => a.outcome)).toEqual(["duplicate", "created"]);
    expect(r.body.decisions[0]).toMatchObject({ status: "suggested" });

    const view = (await api(`briefs/${ev.id}`)).body;
    expect(view.granolaNotes).toBe("Sam wants the quote by Friday.");
    expect(view.actions.map((a: { title: string; status: string }) => [a.title, a.status])).toEqual([
      ["Send Sam the shed quote", "inbox"],
      ["Book the surveyor", "inbox"],
    ]);
    expect(await db.select().from(tasksTable)).toHaveLength(2);
    const [sug] = await db.select().from(suggestionsTable);
    expect(sug).toMatchObject({ kind: "decision", entityType: "project", entityId: shed.id, status: "pending" });

    // Notes for after are Ollie's own.
    expect((await api(`briefs/${ev.id}`, { method: "PATCH", body: { notes: "Follow up Friday" } })).status).toBe(200);
    expect((await api(`briefs/${ev.id}`)).body.notes).toBe("Follow up Friday");
    void s;
  });

  it("Granola notes for a personal event are refused", async () => {
    await sam();
    await meeting("m5b", { personal: true, attendees: ["Sam Lee"] });
    const r = await ingest("meeting-notes", { body: { calendar_source_ref: "m5b", granola_ref: "g", notes: "x" } });
    expect(r.status).toBe(409);
    expect((await ingest("meeting-notes", { body: { calendar_source_ref: "nope", granola_ref: "g", notes: "x" } })).status).toBe(404);
  });

  it("a hidden attendee is held back from the brief until Ollie allows it", async () => {
    const s = await sam();
    const kim = await person("Kim Hidden", { confidential: true });
    const fs = await fact("person", s.id, "Sam runs the graduate scheme");
    const fk = await fact("person", kim.id, "Kim is leaving in March");
    const ev = await meeting("m6", { attendees: ["Sam Lee", "Kim Hidden"] });
    let view = (await api(`briefs/${ev.id}`)).body;
    expect(view.heldBack).toBe(1);
    expect(briefDocs.at(-1)!.map((d) => d.ref)).not.toContain(`fact:${fk.id}`);
    expect(view.why.map((l: { text: string }) => l.text)).toEqual([`Because of fact:${fs.id}.`]);

    view = (await api(`briefs/${ev.id}/allow`, { method: "POST" })).body;
    expect(view.why.map((l: { text: string }) => l.text)).toContain(`Because of fact:${fk.id}.`);
    expect(view.heldBack).toBe(0);
  });

  it("Claude reads a brief filtered for itself, without Ollie's notes (build plan 48)", async () => {
    await sam();
    const s = (await db.select().from(peopleTable).where(eq(peopleTable.name, "Sam Lee")))[0];
    const f = await fact("person", s.id, "Sam wants a pilot in Q1");
    const ev = await meeting("m7", { attendees: ["Sam Lee"] });
    await api(`briefs/${ev.id}`);
    await api(`briefs/${ev.id}`, { method: "PATCH", body: { notes: "Private thought" } });
    const kim = await person("Kim Hidden", { confidential: true });
    // Inserted directly: a second calendar post without m7 would remove it, as the feed is the truth.
    const [hiddenEv] = await db
      .insert(calendarEventsTable)
      .values({ sourceRef: "m7b", title: "Catch-up", startsAt: inMinutes(90), endsAt: inMinutes(120), attendees: ["Kim Hidden"], personIds: [kim.id] })
      .returning();

    const c = await mcp((await connect()).access_token);
    const next = await call(c, "get_meeting_brief", { event: "next" });
    expect(next.isError, next.text).toBeFalsy();
    expect(next.json.event).toMatchObject({ ref: `calendar_event:${ev.id}`, platform: "Teams" });
    expect(next.json.why).toEqual([{ text: `Because of fact:${f.id}.`, refs: [`fact:${f.id}`] }]);
    expect(next.text).not.toContain("Private thought");
    const hidden = await call(c, "get_meeting_brief", { event: `calendar_event:${hiddenEv.id}` });
    expect(hidden.json.error).toBe("not_found");
    const res = await c.readResource({ uri: "ollieos://brief/next" });
    expect(JSON.parse((res.contents[0] as { text: string }).text).event.ref).toBe(`calendar_event:${ev.id}`);
    await c.close();
  });
});

/* ---------- 08 Daily digest ---------- */

describe("08 Daily digest", () => {
  const today = todayLondon();
  const isWeekday = ![0, 6].includes(weekday(today));

  it("the window starts at 18:00 on the previous working day", () => {
    // Monday 9th November 2026 looks back to Friday 6th; Tuesday to Monday.
    expect(digestWindowStart("2026-11-09").toISOString()).toBe(londonWallTimeToInstant("2026-11-06", 18).toISOString());
    expect(digestWindowStart("2026-11-10").toISOString()).toBe(londonWallTimeToInstant("2026-11-09", 18).toISOString());
  });

  it.skipIf(!isWeekday)("criterion 1: after the morning sweep, today's digest exists and is linked from Home", async () => {
    expect((await api("home")).body.digestDate).toBeNull();
    const scheduled = await finishSweep();
    expect(scheduled.digest).toMatchObject({ built: true, date: today });
    expect((await api("home")).body.digestDate).toBe(today);
    const d = (await api("digests/today")).body;
    expect(d.date).toBe(today);
    // A second sweep the same day keeps the morning's digest.
    expect((await finishSweep()).digest).toMatchObject({ built: false });
    expect((await api("digests")).body.map((x: { date: string }) => x.date)).toEqual([today]);
  });

  it("criterion 2: empty sections don't appear, and a night with no changes is a quiet night", async () => {
    await buildDigest(today);
    let d = (await api(`digests/${today}`)).body;
    expect(d.sections).toMatchObject({ needs: null, moved: null, quiet: null, quietNight: true });
    expect(d.summary).toBe("Quiet night.");

    await db.insert(tasksTable).values({ title: "Filed the VAT return", status: "done", completedAt: new Date(), createdBy: "test" });
    await buildDigest(today);
    d = (await api(`digests/${today}`)).body;
    expect(d.sections.quietNight).toBe(false);
    expect(d.sections.needs).toBeNull();
    expect(d.sections.quiet).toBeNull();
    expect(d.sections.moved.items.map((i: { text: string }) => i.text)).toEqual(["Done: Filed the VAT return"]);
    expect(d.summary).toBe("Overnight things moved.");
  });

  it("shows at most 5 items per section with a count of the rest, and never names hidden items to the model", async () => {
    for (let i = 1; i <= 7; i++) {
      await db.insert(tasksTable).values({ title: `Done ${i}`, status: "done", completedAt: new Date(Date.now() - (10 - i) * 1000), createdBy: "test", confidential: i === 7 });
    }
    await buildDigest(today);
    const d = (await api(`digests/${today}`)).body;
    expect(d.sections.moved.items).toHaveLength(5);
    expect(d.sections.moved.more).toBe(2);
    expect(d.sections.moved.items[0]).toMatchObject({ text: "Done: Done 7", confidential: true });
    expect(d.sections.moved.items[1]).toMatchObject({ text: "Done: Done 6", confidential: false });
    const lines = summaryLines.at(-1)!.join("\n");
    expect(lines).not.toContain("Done 7");
    expect(lines).toContain("Done 6");
    expect(lines).toContain("hidden from AI");
  });

  it("digests older than 30 days are cleared when a sweep finishes", async () => {
    await db.insert(digestsTable).values({
      forDate: addDays(today, -31),
      windowStart: new Date(),
      summary: null,
      sections: { needs: null, moved: null, quiet: null, today: [], quietNight: true },
    });
    const scheduled = await finishSweep();
    expect(scheduled.cleared.digests).toBe(1);
  });

  it("a day with no digest is a 404 and a bad date is a 400", async () => {
    expect((await api("digests/2026-01-01")).status).toBe(404);
    expect((await api("digests/yesterday")).status).toBe(400);
  });
});
