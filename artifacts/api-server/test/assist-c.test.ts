/**
 * Assist Part C: look back at Granola. Decisions to the Knowledge Inbox, actions to Review,
 * nothing twice, every Review button, stop and resume, and a rerun that adds nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appSettingsTable, db, decisionsTable, projectsTable, reviewItemsTable, suggestionsTable, tasksTable } from "@workspace/db";
import { closeMatch, wordsOf } from "../src/services/similar";
import { waitForLookBack } from "../src/services/connectors/lookBack";
import type { GranolaNote } from "../src/services/connectors/granola";
import { api, OLLIE, useServer } from "./harness";
import { decision, person, project, task } from "./helpers";

/* A fake Granola behind the connector proxy, with two pages of notes. */
let pages: { id: string; created_at: string }[][] = [];
let notes: Record<string, GranolaNote> = {};
let listed: URLSearchParams[] = [];
/** What the fake Haiku says for each note */
let answers: Record<string, Record<string, unknown>> = {};
/** When set, sorting waits for this before answering (to stop a run part way) */
let gate: Promise<void> | null = null;
let sorted: string[] = [];

vi.mock("../src/services/connectors/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/http")>();
  const json = (path: string): Record<string, unknown> | null => {
    const url = new URL("https://x" + path);
    if (url.pathname === "/v1/notes") {
      listed.push(url.searchParams);
      const page = Number(url.searchParams.get("cursor") ?? "0");
      const more = page + 1 < pages.length;
      return { notes: pages[page] ?? [], hasMore: more, cursor: more ? String(page + 1) : null };
    }
    const n = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname);
    if (n) return (notes[decodeURIComponent(n[1])] as unknown as Record<string, unknown>) ?? null;
    throw new Error("Unexpected path " + path);
  };
  return {
    ...real,
    proxyJson: async (_c: string, _n: string, path: string) => json(path) ?? {},
    proxyJsonOrNull: async (_c: string, _n: string, path: string) => json(path),
  };
});
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    const id = /\[granola:([^\]]+)\]/.exec(content)![1];
    sorted.push(id);
    if (gate) await gate;
    const a = answers[id] ?? { summary: "", project: "", items: [], decisions: [] };
    const ref = `granola:${id}`;
    return { ...a, items: ((a.items as Record<string, unknown>[]) ?? []).map((i) => ({ ref, action: "", priority: "medium", due: "", project: "", person: "", quote: "", confidential: false, ...i })) };
  },
}));

useServer();

beforeEach(() => {
  listed = [];
  sorted = [];
  gate = null;
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

const note = (id: string, days: number, mine = true): GranolaNote => ({
  id,
  title: `Meeting ${id}`,
  owner: { name: "A colleague", email: mine ? OLLIE : "colleague@example.com" },
  created_at: ago(days),
  updated_at: ago(days),
  web_url: `https://notes.granola.ai/d/${id}`,
  calendar_event: null,
  attendees: [{ name: "Sam Lee", email: "sam@client.com" }],
  summary_markdown: `Notes for ${id}.`,
});

function setNotes(list: GranolaNote[], perPage = 2) {
  notes = {};
  const entries = list.map((n) => {
    const id = n.id;
    notes[id] = n;
    return { id, created_at: n.created_at };
  });
  pages = [];
  for (let i = 0; i < entries.length; i += perPage) pages.push(entries.slice(i, i + perPage));
}

async function lookBack(body: Record<string, unknown> = { decisionsDays: 183, actionsDays: 30 }) {
  const r = await api("connectors/granola/look-back", { body });
  expect(r.status).toBe(200);
  await waitForLookBack();
  return (await api("connectors/granola/look-back")).body;
}

describe("close wording", () => {
  it("matches the same action written slightly differently, but not a different one", () => {
    expect(closeMatch(wordsOf("Book the venue for the launch party"), wordsOf("Book venue for launch party"))).toBe(true);
    expect(closeMatch(wordsOf("Send the venue contract to Sam"), wordsOf("Send the venue contract"))).toBe(true);
    expect(closeMatch(wordsOf("Send the venue contract"), wordsOf("Sign the catering contract"))).toBe(false);
  });
});

describe("Look back at Granola", () => {
  it("finds Ollie's meetings in range, sends decisions to the Knowledge Inbox and actions to Review, and leaves out what OllieOS has", async () => {
    const launch = await project("Spring Launch");
    const sam = await person("Sam Lee");
    await decision(launch.id, "Move the launch to March");
    await task("Book venue for launch party");
    // The regular check already captured this meeting's actions.
    await db.insert(tasksTable).values({ title: "Already captured", source: "meeting", sourceRef: "granola:captured", createdBy: "ollieos" });

    setNotes([note("recent", 10), note("captured", 12), note("theirs", 15, false), note("older", 90)]);
    answers = {
      recent: {
        // A mixed meeting: no one project, so a decision with none stays without one.
        project: "",
        items: [
          { type: "task", title: "Send the venue contract", project: "Spring Launch", quote: "Ollie to send the venue contract." },
          { type: "waiting", title: "Sam to send the guest list", project: "Spring Launch", person: "Sam Lee", quote: "Sam will send the guest list." },
          { type: "task", title: "Book the venue for the launch party" },
        ],
        decisions: [
          { text: "Move the launch to March", project: "Spring Launch", topic: "Launch date", confidential: false },
          { text: "Hire a second designer", project: "", topic: "Design hiring", confidential: false },
        ],
      },
      captured: { project: "", items: [{ type: "task", title: "Draft the press release" }], decisions: [] },
      theirs: { project: "", items: [{ type: "task", title: "Not Ollie's meeting" }], decisions: [{ text: "Not his decision", project: "" }] },
      older: { project: "Spring Launch", items: [{ type: "task", title: "Too old to be an action" }], decisions: [{ text: "Use one supplier for print", project: "Spring Launch", topic: "Print" }] },
    };

    const lb = await lookBack();
    expect(lb).toMatchObject({ status: "done", total: 4, done: 4, error: null, reviewPending: 2 });
    expect(lb.counts).toMatchObject({ listed: 4, already: 0, meetings: 3, left_out: 1, decisions: 2, actions: 2, failed: 0 });
    // Two pages, listed by creation date from 6 months back.
    expect(listed).toHaveLength(2);
    const from = new Date(listed[0].get("created_after")!).getTime();
    expect(Math.abs(from - (Date.now() - 183 * DAY))).toBeLessThan(60_000);
    expect(sorted).not.toContain("theirs");

    // Actions: only from the last month, not already captured, not close to an existing task.
    const items = await db.select().from(reviewItemsTable).orderBy(reviewItemsTable.id);
    expect(items.map((i) => [i.text, i.sourceRef, i.owner, i.personId, i.projectId])).toEqual([
      ["Send the venue contract", "granola:recent", "You", null, launch.id],
      ["Sam to send the guest list", "granola:recent#2", "Sam Lee", sam.id, launch.id],
    ]);
    expect(items[0]).toMatchObject({ state: "pending", meetingTitle: "Meeting recent", quote: "Ollie to send the venue contract.", sourceUrl: "https://notes.granola.ai/d/recent" });
    // Nothing went to the Inbox.
    expect((await db.select().from(tasksTable)).length).toBe(2);

    // Decisions: the one OllieOS has is left out; one with a project and one without.
    const sugg = await db.select().from(suggestionsTable).orderBy(suggestionsTable.id);
    expect(sugg.map((s) => [(s.payload as { text: string }).text, s.entityId, s.proposedBy])).toEqual([
      ["Hire a second designer", null, "Granola look back"],
      ["Use one supplier for print", launch.id, "Granola look back"],
    ]);
    expect(sugg[0].payload).toMatchObject({ project_hint: "Design hiring" });

    // The Knowledge Inbox marks them, counts them and can show only them.
    const inbox = await api("suggestions?origin=look_back");
    expect(inbox.body.counts.lookBack).toBe(2);
    expect(inbox.body.items).toHaveLength(2);
    const free = inbox.body.items.find((i: { id: number }) => i.id === sugg[0].id);
    expect(free).toMatchObject({ lookBack: true, needsProject: true, projectHint: "Design hiring" });

    // A rerun over the same range reads nothing again and adds nothing.
    sorted = [];
    const again = await lookBack();
    expect(again.counts).toMatchObject({ listed: 4, already: 4, meetings: 0, decisions: 0, actions: 0 });
    expect(sorted).toEqual([]);
    expect(await db.select().from(reviewItemsTable)).toHaveLength(2);
    expect(await db.select().from(suggestionsTable)).toHaveLength(2);
  });

  it("lets a decision stand on its own, or go under a new project when approved", async () => {
    setNotes([note("a", 5), note("b", 6)]);
    answers = {
      a: { project: "", items: [], decisions: [{ text: "Stop weekly status emails", project: "", topic: "Status emails" }] },
      b: { project: "", items: [], decisions: [{ text: "Hire a second designer", project: "", topic: "Design hiring" }] },
    };
    await lookBack({ decisionsDays: 30, actionsDays: 0 });
    const [s1, s2] = await db.select().from(suggestionsTable).orderBy(suggestionsTable.id);

    const alone = await api(`suggestions/${s1.id}/approve`, { body: {} });
    expect(alone.status).toBe(200);
    const filed = await api(`suggestions/${s2.id}/approve`, { body: { newProjectName: "Design team" } });
    expect(filed.status).toBe(200);

    const list = (await api("decisions")).body as { text: string; project: { name: string } | null }[];
    expect(list.map((d) => [d.text, d.project?.name ?? null]).sort()).toEqual([
      ["Hire a second designer", "Design team"],
      ["Stop weekly status emails", null],
    ]);
    const [p] = await db.select().from(projectsTable).where(eq(projectsTable.name, "Design team"));
    expect(p).toBeTruthy();

    // Decisions can also be recorded, and taken off a project, by hand.
    const made = await api("decisions", { body: { text: "Keep Fridays free of meetings", decidedAt: "2026-11-02" } });
    expect(made.status).toBe(201);
    expect(made.body.project).toBeNull();
    const d = (await db.select().from(decisionsTable).where(eq(decisionsTable.projectId, p.id)))[0];
    const off = await api(`decisions/${d.id}`, { method: "PATCH", body: { projectId: null } });
    expect(off.status).toBe(200);
    expect(off.body.project).toBeNull();
  });

  it("can be stopped part way and resumed from where it got to", async () => {
    setNotes([note("one", 3), note("two", 4), note("three", 5)], 3);
    answers = {};
    let release!: () => void;
    gate = new Promise((r) => (release = r));
    await api("connectors/granola/look-back", { body: { decisionsDays: 30, actionsDays: 14 } });
    await vi.waitFor(() => expect(sorted).toEqual(["one"]));
    const stopping = api("connectors/granola/look-back/stop", { method: "POST" });
    await new Promise((r) => setTimeout(r, 50));
    release();
    gate = null;
    const stopped = (await stopping).body;
    expect(stopped).toMatchObject({ status: "stopped", done: 1, total: 3 });

    const resumed = await api("connectors/granola/look-back/resume", { method: "POST" });
    expect(resumed.body.status).toBe("running");
    await waitForLookBack();
    const after = (await api("connectors/granola/look-back")).body;
    expect(after).toMatchObject({ status: "done", done: 3, total: 3 });
    expect(sorted).toEqual(["one", "two", "three"]);

    // Resuming a finished look back is refused; a run cut short by a restart shows as stopped.
    expect((await api("connectors/granola/look-back/resume", { method: "POST" })).status).toBe(400);
    const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "granola_look_back"));
    await db
      .update(appSettingsTable)
      .set({ value: { ...(row.value as object), status: "running", heartbeat: ago(1) } })
      .where(eq(appSettingsTable.key, "granola_look_back"));
    const cut = (await api("connectors/granola/look-back")).body;
    expect(cut.status).toBe("stopped");
    expect(cut.error).toContain("Resume");
  });

  it("refuses ranges that are not offered", async () => {
    expect((await api("connectors/granola/look-back", { body: { decisionsDays: 1000, actionsDays: 30 } })).status).toBe(400);
    expect((await api("connectors/granola/look-back", { body: { decisionsDays: 183, actionsDays: 7 } })).status).toBe(400);
  });
});

describe("Review", () => {
  async function item(text: string, extra: Partial<typeof reviewItemsTable.$inferInsert> = {}) {
    const [row] = await db
      .insert(reviewItemsTable)
      .values({ kind: "action", sourceRef: `granola:m#${text}`, meetingTitle: "Planning", meetingAt: new Date("2026-10-20T10:00:00Z"), text, suggestedType: "task", owner: "You", ...extra })
      .returning();
    return row;
  }

  it("makes Now, Backlog and Waiting on tasks, and closes Already done and Dropped without one", async () => {
    const sam = await person("Sam Lee");
    const pat = await person("Pat Jones");
    const now = await item("Send the contract", { quote: "Ollie to send the contract.", sourceUrl: "https://notes.granola.ai/d/m" });
    const later = await item("Write the case study", { suggestedType: "promise" });
    const wait = await item("Sam to send figures", { suggestedType: "waiting", owner: "Sam Lee", personId: sam.id });
    const waitOther = await item("Pat to confirm the venue", { suggestedType: "waiting", owner: "Pat" });
    const done = await item("Book the room");
    const dropped = await item("Look into podcasts");

    const list = await api("review");
    expect(list.body.pending).toBe(6);
    expect(list.body.items[0]).toMatchObject({ meetingTitle: "Planning", owner: expect.any(String) });

    const decide = (ids: number[], action: string, extra: Record<string, unknown> = {}) => api("review/decide", { body: { ids, action, ...extra } });
    expect((await decide([now.id], "now")).status).toBe(200);
    expect((await decide([later.id], "backlog")).status).toBe(200);
    expect((await decide([wait.id], "waiting")).status).toBe(200);
    expect((await decide([waitOther.id], "waiting", { waitingOnPersonId: pat.id })).status).toBe(200);
    expect((await decide([done.id], "done")).status).toBe(200);
    expect((await decide([dropped.id], "dropped")).status).toBe(200);

    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks.map((t) => [t.title, t.status, t.kind, t.waitingOnPersonId, t.source, t.sourceRef])).toEqual([
      ["Send the contract", "now", "task", null, "meeting", now.sourceRef],
      ["Write the case study", "backlog", "promise", null, "meeting", later.sourceRef],
      ["Sam to send figures", "waiting", "task", sam.id, "meeting", wait.sourceRef],
      ["Pat to confirm the venue", "waiting", "task", pat.id, "meeting", waitOther.sourceRef],
    ]);
    expect(tasks[0]).toMatchObject({ sourceQuote: "Ollie to send the contract.", sourceSubject: "Planning", sourceUrl: "https://notes.granola.ai/d/m" });
    expect(tasks.every((t) => t.triagedAt)).toBe(true);
    expect(tasks[2].waitingSince).toBeTruthy();

    const states = await db.select().from(reviewItemsTable).orderBy(reviewItemsTable.id);
    expect(states.map((s) => [s.state, s.taskId])).toEqual([
      ["accepted", tasks[0].id],
      ["accepted", tasks[1].id],
      ["accepted", tasks[2].id],
      ["accepted", tasks[3].id],
      ["done", null],
      ["dropped", null],
    ]);
    expect((await api("review")).body.pending).toBe(0);

    // Deciding again is refused.
    expect((await decide([now.id], "dropped")).status).toBe(400);
  });

  it("applies one choice to several items at once", async () => {
    const a = await item("First");
    const b = await item("Second");
    const c = await item("Third");
    const r = await api("review/decide", { body: { ids: [a.id, b.id], action: "backlog" } });
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    const tasks = await db.select().from(tasksTable);
    expect(tasks.map((t) => [t.title, t.status]).sort()).toEqual([
      ["First", "backlog"],
      ["Second", "backlog"],
    ]);
    // In bulk, items already decided are skipped.
    const drop = await api("review/decide", { body: { ids: [a.id, c.id], action: "dropped" } });
    expect(drop.body.items.map((i: { id: number }) => i.id)).toEqual([c.id]);
    expect((await api("review")).body.pending).toBe(0);
  });
});
