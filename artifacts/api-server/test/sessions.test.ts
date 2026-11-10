import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { coworkSessionsTable, db, suggestionsTable, tasksTable } from "@workspace/db";
import type { Extracted } from "../src/services/documents/knowledge";
import { readWaiting } from "../src/services/documents/reader";
import { api, call, connect, mcp, useServer } from "./harness";
import { person, project } from "./helpers";

/* What the fake model finds, and what it was sent. */
let extract: Extracted;
let sent: string[] = [];
const nothing = (): Extracted => ({ summary: "A session.", confidential: false, projects: [], facts: [], decisions: [], people: [], organisations: [], rules: [], relationships: [] });

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  modelJson: async (_model: string, _system: string, content: string) => {
    sent.push(content);
    return extract;
  },
}));

useServer();

beforeEach(() => {
  extract = nothing();
  sent = [];
});

async function claude() {
  return mcp((await connect()).access_token);
}

const DAY = 86_400_000;

describe("save_session", () => {
  it("keeps the session, sends its actions to the Inbox, proposes its artifacts and reads it for knowledge", async () => {
    const apollo = await project("Apollo");
    const sam = await person("Sam Owner");
    const c = await claude();
    const out = await call(c, "save_session", {
      title: "Apollo launch plan",
      summary: "Worked through the launch plan for Apollo.",
      outcomes: ["Agreed a March launch", "Drafted the launch brief"],
      transcript: "Ollie: let's launch Apollo in March.",
      session_id: "cowork-1",
      projects: ["Apollo"],
      people: ["Sam Owner", "Nobody Known"],
      actions: [
        { title: "Send Sam the launch brief", kind: "promise", person: "Sam Owner", project: "Apollo" },
        { title: "Book the launch venue", due_date: "2026-12-01" },
      ],
      artifacts: [{ title: "Apollo launch brief", content: "# Launch brief\n\nMarch.", kind: "brief" }],
    });
    expect(out.isError).toBeFalsy();
    expect(out.json.saved).toBe(true);
    expect(out.json.unmatched).toEqual(["Nobody Known"]);
    const ref = out.json.session as string;
    const id = Number(ref.split(":")[1]);

    const [row] = await db.select().from(coworkSessionsTable).where(eq(coworkSessionsTable.id, id));
    expect(row.projectIds).toEqual([apollo.id]);
    expect(row.personIds).toEqual([sam.id]);
    expect(row.taskIds).toHaveLength(2);

    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks.map((t) => [t.title, t.kind, t.source, t.status])).toEqual([
      ["Send Sam the launch brief", "promise", "session", "inbox"],
      ["Book the launch venue", "task", "session", "inbox"],
    ]);
    expect(tasks[0].personId).toBe(sam.id);
    expect(tasks[0].sourceRef).toBe(`session:${id}#1`);

    // The artifact waits for approval, citing the session.
    let sugg = await db.select().from(suggestionsTable);
    expect(sugg.map((s) => [s.kind, s.sourceRef])).toEqual([["document", `session:${id}`]]);

    // Reading it proposes knowledge from the session, citing it.
    extract = {
      ...nothing(),
      projects: ["Apollo"],
      decisions: [{ project: "Apollo", topic: "Launch", text: "Launch Apollo in March.", decided_on: "", decided_by: "Ollie" }],
    };
    expect(await readWaiting(5)).toBe(1);
    expect(sent[0]).toContain("Agreed a March launch");
    expect(sent[0]).toContain("launch Apollo in March");
    sugg = await db.select().from(suggestionsTable).orderBy(suggestionsTable.id);
    const dec = sugg.find((s) => s.kind === "decision")!;
    expect(dec.sourceRef).toBe(`session:${id}`);
    expect(dec.sourceLabel).toBe("Cowork session: Apollo launch plan");
    expect(dec.proposedBy).toBe("Document reader");

    const inbox = await api("suggestions?origin=documents");
    expect(inbox.body.items.some((i: { fromDocument: string }) => i.fromDocument === `session:${id}`)).toBe(true);

    // Approving the decision shows on the session.
    expect((await api(`suggestions/${dec.id}/approve`, { body: {} })).status).toBe(200);
    const detail = await api(`sessions/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.outcomes).toEqual(["Agreed a March launch", "Drafted the launch brief"]);
    expect(detail.body.decisions.map((d: { text: string }) => d.text)).toEqual(["Launch Apollo in March."]);
    expect(detail.body.tasks).toHaveLength(2);
    expect(detail.body.projects.map((p: { name: string }) => p.name)).toEqual(["Apollo"]);
    expect(detail.body.knowledge.state).toBe("read");
    expect(detail.body.archived).toBe(false);

    // Saving the same session again updates it; actions are not captured twice.
    const again = await call(c, "save_session", {
      title: "Apollo launch plan",
      summary: "Worked through the launch plan for Apollo, then the budget.",
      session_id: "cowork-1",
      actions: [{ title: "Send Sam the launch brief", kind: "promise", person: "Sam Owner" }],
    });
    await c.close();
    expect(again.json.updated).toBe(true);
    expect(await db.select().from(coworkSessionsTable)).toHaveLength(1);
    expect(await db.select().from(tasksTable)).toHaveLength(2);

    const list = await api("sessions");
    expect(list.body).toHaveLength(1);
    expect(list.body[0].summary).toContain("the budget");
    expect(list.body[0].decisionCount).toBe(1);
  });

  it("refuses a session without a summary", async () => {
    const c = await claude();
    const out = await call(c, "save_session", { title: "Empty", summary: "   " });
    await c.close();
    expect(out.isError).toBe(true);
    expect(await db.select().from(coworkSessionsTable)).toHaveLength(0);
  });
});

describe("visibility", () => {
  it("hides a session that touched a confidential person, and never reads it", async () => {
    await project("Apollo");
    const board = await person("Board Member", { confidential: true });
    const c = await claude();
    const out = await call(c, "save_session", { title: "Board prep", summary: "Prepared for the board.", projects: ["Apollo"] });
    expect(out.json.session).toBeTruthy();
    const id = Number((out.json.session as string).split(":")[1]);
    // The person is hidden from Claude, so link them as Ollie would.
    await db.update(coworkSessionsTable).set({ personIds: [board.id] }).where(eq(coworkSessionsTable.id, id));
    await readWaiting(5);

    const ctx = await call(c, "get_context", { name: "Apollo" });
    expect(ctx.json.sessions).toEqual([]);
    const found = await call(c, "search", { query: "board" });
    expect(JSON.stringify(found.json)).not.toContain("Board prep");
    await c.close();

    // Ollie still sees it, marked hidden from AI.
    const mine = await api("search?q=board");
    const hit = mine.body.hits.find((h: { type: string }) => h.type === "session");
    expect(hit.hiddenFromAi).toBe(true);
    const detail = await api(`sessions/${id}`);
    expect(detail.body.hiddenFromAi).toBe(true);
    expect((await api(`sessions/${id}/knowledge`, { method: "POST" })).status).toBe(400);
  });

  it("marking a session confidential hides it from search and context; Always readable brings it back", async () => {
    await project("Apollo");
    const c = await claude();
    const out = await call(c, "save_session", { title: "Pricing review", summary: "Reviewed Apollo pricing.", projects: ["Apollo"] });
    const id = Number((out.json.session as string).split(":")[1]);
    expect(((await call(c, "get_context", { name: "Apollo" })).json.sessions as unknown[]).length).toBe(1);
    expect(JSON.stringify((await call(c, "search", { query: "pricing" })).json)).toContain("Pricing review");

    expect((await api(`sessions/${id}`, { method: "PATCH", body: { confidential: true } })).body.hiddenFromAi).toBe(true);
    expect((await call(c, "get_context", { name: "Apollo" })).json.sessions).toEqual([]);
    expect(JSON.stringify((await call(c, "search", { query: "pricing" })).json)).not.toContain("Pricing review");
    await c.close();
  });
});

describe("archiving", () => {
  it("archives a session over 90 days old once nothing from it is open, and leaves it out of context", async () => {
    await project("Apollo");
    const c = await claude();
    const out = await call(c, "save_session", {
      title: "Old planning",
      summary: "Planned Apollo long ago.",
      projects: ["Apollo"],
      happened_at: new Date(Date.now() - 100 * DAY).toISOString(),
      actions: [{ title: "Follow up on old planning" }],
    });
    const id = Number((out.json.session as string).split(":")[1]);
    expect((await api(`sessions/${id}`)).body.archived).toBe(false);
    expect(((await call(c, "get_context", { name: "Apollo" })).json.sessions as unknown[]).length).toBe(1);

    await db.update(tasksTable).set({ status: "done" });
    expect((await api(`sessions/${id}`)).body.archived).toBe(true);
    expect((await call(c, "get_context", { name: "Apollo" })).json.sessions).toEqual([]);
    await c.close();

    // Still on the page and in search.
    expect((await api("sessions")).body).toHaveLength(1);
    expect((await api("sessions?q=planning")).body).toHaveLength(1);
    expect((await api("sessions?q=nothingmatches")).body).toHaveLength(0);
  });
});

describe("deleting", () => {
  it("deletes the session and keeps the tasks from it", async () => {
    const c = await claude();
    const out = await call(c, "save_session", { title: "Quick one", summary: "A quick session.", actions: [{ title: "Do the thing" }] });
    await c.close();
    const id = Number((out.json.session as string).split(":")[1]);
    expect((await api(`sessions/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(coworkSessionsTable)).toHaveLength(0);
    expect(await db.select().from(tasksTable)).toHaveLength(1);
    expect((await api(`sessions/${id}`)).status).toBe(404);
  });
});
