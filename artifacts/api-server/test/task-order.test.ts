/** Dragging tasks into Ollie's own order on the Tasks page. */
import { describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import { api, useServer } from "./harness";
import { task } from "./helpers";

useServer();

const titles = async (tab: string) => ((await api(`tasks?tab=${tab}`)).body as unknown as { title: string }[]).map((t) => t.title);

async function make(title: string, status: "now" | "backlog", dueIn: number | null) {
  const t = await task(title);
  await db
    .update(tasksTable)
    .set({ status, dueDate: dueIn === null ? null : addDays(todayLondon(), dueIn) })
    .where(eq(tasksTable.id, t.id));
  return t.id;
}

describe("Task order", () => {
  it("keeps a dragged order, and new tasks join below it in due-date order", async () => {
    const a = await make("A", "now", 1);
    const b = await make("B", "now", 2);
    const c = await make("C", "now", 3);
    expect(await titles("now")).toEqual(["A", "B", "C"]);

    expect((await api("tasks/reorder", { body: { ids: [c, a, b] } })).status).toBe(204);
    expect(await titles("now")).toEqual(["C", "A", "B"]);

    // Due sooner than all of them, but never placed by hand, so it waits below.
    await make("D", "now", 0);
    expect(await titles("now")).toEqual(["C", "A", "B", "D"]);
  });

  it("reorders a filtered view without moving it against tasks outside the view", async () => {
    const n1 = await make("Now 1", "now", 1);
    const n2 = await make("Now 2", "now", 2);
    const b1 = await make("Backlog 1", "backlog", 3);
    const b2 = await make("Backlog 2", "backlog", 4);
    await api("tasks/reorder", { body: { ids: [n1, n2, b1, b2] } });
    // Swap the two Backlog tasks from the Backlog tab: they swap places, and still sit after Now.
    await api("tasks/reorder", { body: { ids: [b2, b1] } });
    expect(await titles("backlog")).toEqual(["Backlog 2", "Backlog 1"]);
    expect(await titles("open")).toEqual(["Now 1", "Now 2", "Backlog 2", "Backlog 1"]);
  });

  it("does not count a drag as touching the task, and can go back to due-date order", async () => {
    const a = await make("A", "backlog", 1);
    const b = await make("B", "backlog", 2);
    const old = new Date(Date.now() - 40 * 86400_000);
    await db.update(tasksTable).set({ updatedAt: old }).where(inArray(tasksTable.id, [a, b]));

    await api("tasks/reorder", { body: { ids: [b, a] } });
    const rows = await db.select().from(tasksTable).where(inArray(tasksTable.id, [a, b]));
    expect(rows.every((r) => r.updatedAt.getTime() === old.getTime())).toBe(true);
    expect(await titles("backlog")).toEqual(["B", "A"]);

    expect((await api("tasks/reorder", { body: { ids: [a, b], clear: true } })).status).toBe(204);
    expect(await titles("backlog")).toEqual(["A", "B"]);
    const list = (await api("tasks?tab=backlog")).body as unknown as { position: number | null; stale: boolean }[];
    expect(list.map((t) => t.position)).toEqual([null, null]);
    expect(list.every((t) => t.stale)).toBe(true);
  });

  it("ignores ids that do not exist and rejects a bad body", async () => {
    const a = await make("A", "now", 1);
    const b = await make("B", "now", 2);
    expect((await api("tasks/reorder", { body: { ids: [999999, b, a] } })).status).toBe(204);
    expect(await titles("now")).toEqual(["B", "A"]);
    expect((await api("tasks/reorder", { body: { ids: [] } })).status).toBe(400);
    expect((await api("tasks/reorder", { body: { ids: ["x"] } })).status).toBe(400);
  });
});
