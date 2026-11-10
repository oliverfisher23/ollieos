import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, goalsTable, ideasTable, projectsTable, suggestionsTable, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import { retrieveForAsk } from "../src/lib/ai-data/retrieve";
import { buildDigest } from "../src/services/digest";
import { api, call, connect, mcp, useServer } from "./harness";
import { client, project, scopeFor } from "./helpers";

vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => "Overnight things moved.",
}));

useServer();

const today = todayLondon();

async function claude() {
  return mcp((await connect()).access_token);
}

describe("Strategy sections", () => {
  it("adds, edits and reorders sections, keeping the order and the last change", async () => {
    const a = (await api("strategy/sections", { body: { name: "Where we play" } })).body;
    const b = (await api("strategy/sections", { body: { name: "How we win", body: "First line" } })).body;
    expect([a.sortOrder, b.sortOrder]).toEqual([0, 1]);

    await new Promise((r) => setTimeout(r, 15));
    const edited = (await api(`strategy/sections/${a.id}`, { method: "PATCH", body: { body: "Small markets first" } })).body;
    expect(edited.body).toBe("Small markets first");
    expect(new Date(edited.updatedAt).getTime()).toBeGreaterThan(new Date(a.updatedAt).getTime());

    const order = (await api("strategy/sections/order", { method: "PUT", body: { ids: [b.id, a.id] } })).body;
    expect(order.map((s: { name: string }) => s.name)).toEqual(["How we win", "Where we play"]);
    expect((await api("strategy/sections")).body.map((s: { id: number }) => s.id)).toEqual([b.id, a.id]);
    // Every section must be listed once.
    expect((await api("strategy/sections/order", { method: "PUT", body: { ids: [a.id] } })).status).toBe(400);
  });

  it("deletes with Undo", async () => {
    const s = (await api("strategy/sections", { body: { name: "What we won't do" } })).body;
    expect((await api(`strategy/sections/${s.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api("strategy/sections")).body).toEqual([]);
    expect((await api(`strategy/sections/${s.id}/restore`, { body: {} })).body.name).toBe("What we won't do");
    expect((await api("strategy/sections")).body).toHaveLength(1);
  });

  it("links goals and projects, and a hidden project hides the section from AI", async () => {
    const [goal] = await db.insert(goalsTable).values({ name: "Grow revenue" }).returning();
    const open = await project("Open work");
    const secret = await project("Secret deal", { confidential: true });
    const s = (await api("strategy/sections", { body: { name: "Bets", goalIds: [goal.id], projectIds: [open.id] } })).body;
    expect(s.goals).toEqual([{ id: goal.id, name: "Grow revenue" }]);
    expect(s.hiddenFromAi).toBe(false);
    const hidden = (await api(`strategy/sections/${s.id}`, { method: "PATCH", body: { projectIds: [open.id, secret.id] } })).body;
    expect(hidden.hiddenFromAi).toBe(true);
  });
});

describe("Ideas", () => {
  it("moves between tabs, and Come back to needs a date", async () => {
    const i = (await api("ideas", { body: { title: "Podcast series", notes: "Brainstorm:\n- guests\n- format" } })).body;
    expect(i).toMatchObject({ status: "new", source: "ollie", due: false });
    expect((await api(`ideas/${i.id}`, { method: "PATCH", body: { status: "come_back" } })).status).toBe(400);
    const later = (await api(`ideas/${i.id}`, { method: "PATCH", body: { status: "come_back", comeBackOn: addDays(today, 5) } })).body;
    expect(later).toMatchObject({ status: "come_back", due: false });
    const list = (await api("ideas?status=come_back")).body;
    expect(list.counts).toEqual({ new: 0, come_back: 1, taken_forward: 0, dropped: 0 });
    expect((await api("ideas?q=guests")).body.ideas.map((x: { id: number }) => x.id)).toEqual([i.id]);
    const dropped = (await api(`ideas/${i.id}`, { method: "PATCH", body: { status: "dropped" } })).body;
    expect(dropped).toMatchObject({ status: "dropped", comeBackOn: null });
  });

  it("an idea set to come back today shows on Home and in the digest", async () => {
    const i = (await api("ideas", { body: { title: "Annual offsite", status: "come_back", comeBackOn: today } })).body;
    await api("ideas", { body: { title: "Not yet", status: "come_back", comeBackOn: addDays(today, 3) } });
    const home = (await api("home")).body;
    expect(home.ideasDue.map((x: { title: string }) => x.title)).toEqual(["Annual offsite"]);

    await buildDigest(today);
    const d = (await api(`digests/${today}`)).body;
    expect(d.sections.quietNight).toBe(false);
    expect(d.sections.needs.items).toContainEqual(expect.objectContaining({ text: "Idea to come back to: Annual offsite", href: `/strategy?idea=${i.id}` }));

    // Picking a new date takes it off Home.
    await api(`ideas/${i.id}`, { method: "PATCH", body: { comeBackOn: addDays(today, 7) } });
    expect((await api("home")).body.ideasDue).toEqual([]);
  });

  it("takes an idea forward as a task or a project and links back to it", async () => {
    const [goal] = await db.insert(goalsTable).values({ name: "Grow revenue" }).returning();
    const t = (await api("ideas", { body: { title: "Price review", notes: "Look at tiers", goalId: goal.id } })).body;
    const asTask = (await api(`ideas/${t.id}/forward`, { body: { as: "task" } })).body;
    expect(asTask.status).toBe("taken_forward");
    expect(asTask.takenTask.title).toBe("Price review");
    const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, asTask.takenTask.id));
    expect(task).toMatchObject({ status: "backlog", notes: "Look at tiers", goalId: goal.id, createdBy: "ollie" });
    expect((await api(`ideas/${t.id}/forward`, { body: { as: "task" } })).status).toBe(400);

    const p = (await api("ideas", { body: { title: "Community programme", goalId: goal.id } })).body;
    const asProject = (await api(`ideas/${p.id}/forward`, { body: { as: "project" } })).body;
    expect(asProject.takenProject.name).toBe("Community programme");
    const [proj] = await db.select().from(projectsTable).where(eq(projectsTable.id, asProject.takenProject.id));
    expect(proj.goalId).toBe(goal.id);
    expect((await api("ideas?status=taken_forward")).body.ideas).toHaveLength(2);
  });

  it("deletes with Undo", async () => {
    const i = (await api("ideas", { body: { title: "Short-lived" } })).body;
    await api(`ideas/${i.id}`, { method: "DELETE" });
    expect((await api("ideas")).body.ideas).toEqual([]);
    await api(`ideas/${i.id}/restore`, { body: {} });
    expect((await api("ideas")).body.ideas).toHaveLength(1);
  });
});

describe("Claude and strategy", () => {
  it("add_idea lands as New, marked From Claude, and cannot reach the Knowledge Inbox", async () => {
    const c = await claude();
    const out = await call(c, "add_idea", { title: "Partner webinar", notes: "Came up while planning", from_session: true });
    expect(out.isError).toBeFalsy();
    const ref = (out.json.idea as { ref: string }).ref;
    const list = (await api("ideas?status=new")).body.ideas;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Partner webinar", status: "new", source: "session", createdBy: "Claude" });
    expect(ref).toBe(`idea:${list[0].id}`);
    expect(await db.select().from(suggestionsTable)).toEqual([]);

    const plain = await call(c, "add_idea", { title: "Second idea" });
    expect(plain.isError).toBeFalsy();
    const [row] = await db.select().from(ideasTable).where(eq(ideasTable.title, "Second idea"));
    expect(row.source).toBe("claude");
    expect((await call(c, "add_idea", { title: "x", goal: "No such goal" })).json.error).toBe("not_found");
    await c.close();
  });

  it("get_strategy, search and fetch never return a confidential section or idea, or one on a hidden project", async () => {
    const secret = await project("Secret deal", { confidential: true });
    await api("strategy/sections", { body: { name: "Open strategy", body: "Grow the widget market" } });
    await api("strategy/sections", { body: { name: "Hidden strategy", body: "Widget sale plan", confidential: true } });
    await api("strategy/sections", { body: { name: "Off strategy", body: "Widget notes", aiAccess: false } });
    await api("strategy/sections", { body: { name: "Deal strategy", body: "Widget deal", projectIds: [secret.id] } });
    const open = (await api("ideas", { body: { title: "Widget idea", status: "come_back", comeBackOn: today } })).body;
    const hiddenIdea = (await api("ideas", { body: { title: "Widget secret idea", confidential: true } })).body;
    await api("ideas", { body: { title: "Widget deal idea", projectId: secret.id } });
    await api("ideas", { body: { title: "Widget dropped idea", status: "dropped" } });

    const c = await claude();
    const s = (await call(c, "get_strategy", {})).json as { sections: { name: string; text: string }[]; ideas: { title: string; due: boolean }[] };
    expect(s.sections.map((x) => x.name)).toEqual(["Open strategy"]);
    expect(s.ideas.map((x) => [x.title, x.due])).toEqual([["Widget idea", true]]);

    const found = (await call(c, "search", { query: "widget" })).json as { results: { ref: string; title: string }[] };
    expect(found.results.map((r) => r.title).sort()).toEqual(["Open strategy", "Widget dropped idea", "Widget idea"]);
    expect(JSON.stringify(found)).not.toMatch(/secret|Hidden|Off strategy|Deal/);

    expect((await call(c, "fetch", { id: `idea:${open.id}` })).json.text).toContain("Widget idea");
    expect((await call(c, "fetch", { id: `idea:${hiddenIdea.id}` })).json.error).toBe("not_found");
    await c.close();

    // Ask OllieOS reads strategy too, through the same filter.
    const docs = (await retrieveForAsk(await scopeFor(await client("Ask test")), "widget strategy")).docs;
    expect(docs.map((d) => d.ref)).toContain("strategy:1");
    expect(docs.map((d) => d.text).join("\n")).not.toMatch(/sale plan|Widget deal|secret/);
  });
});
