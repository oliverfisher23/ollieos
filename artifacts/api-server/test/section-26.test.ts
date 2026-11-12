/**
 * Build plan section 26: the stuck-task coach. Slips come from the task's own history in code; the
 * way out comes from the stand-in model, so the real prompt is built and the real answer parsed.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, dayPlansTable, db, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import type { AgentKey } from "../src/lib/agents";
import { coachStuckTasks, isStuck, signalsFor, signalsLine, stuckCount } from "../src/services/stuckTasks";
import { scorecards } from "../src/services/scorecards";
import { api, useServer } from "./harness";

type Call = { agent: AgentKey; system: string; content: string };
const calls: Call[] = [];
const answers: Partial<Record<AgentKey, (c: Call) => unknown>> = {};

vi.mock("../src/lib/aiRuns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/aiRuns")>()),
  recordedCreate: async (agent: AgentKey, params: { system: string; messages: { content: string }[] }) => {
    const c = { agent, system: String(params.system), content: String(params.messages[0].content) };
    calls.push(c);
    const answer = answers[agent];
    if (!answer) throw new Error(`No stand-in answer for ${agent}`);
    return { content: [{ type: "text", text: JSON.stringify(answer(c)) }], usage: {} };
  },
}));

useServer();

const reset = () => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k as AgentKey];
};
const DAY = 86_400_000;

async function task(title: string, extra: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [t] = await db.insert(tasksTable).values({ title, status: "now", createdBy: "ollie", ...extra }).returning();
  return t;
}
async function slips(taskId: number, n: { snoozes?: number; moved?: number; back?: number }) {
  for (let i = 0; i < (n.snoozes ?? 0); i++) await db.insert(auditEventsTable).values({ actor: "ollie", action: "snooze", entityType: "task", entityId: taskId, payload: {} });
  for (let i = 0; i < (n.moved ?? 0); i++)
    await db.insert(auditEventsTable).values({ actor: "ollie", action: "update", entityType: "task", entityId: taskId, payload: { changes: [{ field: "dueDate", from: "Monday 3rd November", to: "Friday 7th November" }] } });
  for (let i = 0; i < (n.back ?? 0); i++)
    await db.insert(auditEventsTable).values({ actor: "ollie", action: "status", entityType: "task", entityId: taskId, payload: { changes: [{ field: "status", from: "Now", to: "Backlog" }] } });
}

/** The stand-in coach: answers each task by a word in its title. */
function standIn() {
  answers.stuck_coach = (c) => ({
    tasks: [...c.content.matchAll(/\[(t\d+)\] (.*)/g)].map((m) => {
      const title = m[2];
      const base = { task: m[1], reasoning: "It keeps slipping", why: "Too big to start — three pieces", steps: [] as string[], repeat_every: "", next_step: "Open the doc and list what is left" };
      if (title.includes("Website")) return { ...base, way_out: "break_down", steps: ["Draft the page outline", "Ask Sam for the photos", "Write the copy"] };
      if (title.includes("Promise")) return { ...base, way_out: "drop" };
      if (title.includes("Review")) return { ...base, way_out: "repeat", repeat_every: "month" };
      if (title.includes("Hand")) return { ...base, way_out: "delegate" };
      return { ...base, way_out: "drop" };
    }),
  });
}

describe("Stuck signals", () => {
  it("counts slips from the history and day plans, and says how it slipped", async () => {
    reset();
    const t = await task("Website refresh", { dueDate: addDays(todayLondon(), -16) });
    await slips(t.id, { snoozes: 2, moved: 1, back: 1 });
    await db.insert(dayPlansTable).values({ date: addDays(todayLondon(), -1), items: [{ taskId: t.id, minutes: 30, start: "10:00" }] });
    const s = (await signalsFor([t.id])).get(t.id)!;
    expect(s).toMatchObject({ snoozes: 2, moved: 1, backToBacklog: 1, carried: 1, overdueDays: 16 });
    expect(isStuck(s)).toBe(true);
    expect(signalsLine(s)).toBe("Snoozed twice, due date moved once, moved back to Backlog once, planned for a day and not finished, overdue by 2 weeks");

    const fresh = await task("Fresh task");
    expect(isStuck((await signalsFor([fresh.id])).get(fresh.id)!)).toBe(false);
    const old = await task("Old in Now", { createdAt: new Date(Date.now() - 25 * DAY) });
    expect(isStuck((await signalsFor([old.id])).get(old.id)!)).toBe(true);
  });
});

describe("Stuck-task coach", () => {
  it("suggests a way out, holds the rules whatever the model says, and never sends a hidden task", async () => {
    reset();
    standIn();
    const web = await task("Website refresh");
    const promise = await task("Promise: send Kim the deck", { kind: "promise" });
    const review = await task("Review the pipeline sheet", { status: "backlog" });
    const hand = await task("Hand the Ely timetable over");
    const secret = await task("Board pack for the buyer", { confidential: true });
    const fine = await task("Just made");
    for (const t of [web, promise, review, hand, secret]) await slips(t.id, { snoozes: 3 });

    const r = await coachStuckTasks();
    expect(r).toMatchObject({ stuck: 5, coached: 4, failed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].content).not.toContain("Board pack");
    expect(calls[0].content).toContain("slipped: Snoozed 3 times");

    const view = async (id: number) => (await api(`tasks/${id}`)).body.task;
    expect((await view(web.id)).stuck).toMatchObject({ wayOut: "break_down", steps: ["Draft the page outline", "Ask Sam for the photos", "Write the copy"], why: "Too big to start, three pieces" });
    // Never drop a promise; delegate only with a colleague found; repeat needs how often.
    expect((await view(promise.id)).stuck).toMatchObject({ wayOut: "next_step", nextStep: "Open the doc and list what is left" });
    expect((await view(hand.id)).stuck.wayOut).toBe("next_step");
    expect((await view(review.id)).stuck).toMatchObject({ wayOut: "repeat", repeatEvery: "month" });
    expect((await view(secret.id)).stuck).toMatchObject({ wayOut: null, signals: "Snoozed 3 times" });
    expect((await view(fine.id)).stuck).toBeNull();
    expect(await stuckCount()).toBe(5);

    // A week later is the next look; not before.
    calls.length = 0;
    expect((await coachStuckTasks()).looked).toBe(0);
  });

  it("Do this makes the change and Not now keeps it off the list for 30 days", async () => {
    reset();
    standIn();
    const web = await task("Website refresh", { steps: [{ id: "a1", title: "Old step", done: true }] });
    const drop = await task("Something old");
    const review = await task("Review the pipeline sheet", { dueDate: todayLondon() });
    const later = await task("Website for later");
    for (const t of [web, drop, review, later]) await slips(t.id, { snoozes: 3 });
    await coachStuckTasks();

    const a = await api(`tasks/${web.id}/stuck/apply`, { method: "POST" });
    expect(a.body.steps.map((s: { title: string }) => s.title)).toEqual(["Old step", "Draft the page outline", "Ask Sam for the photos", "Write the copy"]);
    expect(a.body.stuck).toBeNull();
    expect((await api(`tasks/${web.id}/stuck/apply`, { method: "POST" })).status).toBe(400);

    expect((await api(`tasks/${drop.id}/stuck/apply`, { method: "POST" })).body.status).toBe("dropped");
    expect((await api(`tasks/${review.id}/stuck/apply`, { method: "POST" })).body.repeat).toMatchObject({ every: "month" });

    const d = await api(`tasks/${later.id}/stuck/dismiss`, { method: "POST" });
    expect(d.body.stuck).toBeNull();
    const m = (await scorecards()).find((x) => x.key === "stuck")!;
    expect(m).toMatchObject({ kept: 3, undone: 1 });
    await db.update(tasksTable).set({ stuckCheckedAt: new Date(Date.now() - 8 * DAY) }).where(eq(tasksTable.id, later.id));
    calls.length = 0;
    await coachStuckTasks();
    expect(calls.every((c) => !c.content.includes("Website for later"))).toBe(true);

  });

  it("clears the flag once a task is no longer stuck", async () => {
    reset();
    standIn();
    const t = await task("Website refresh");
    await slips(t.id, { snoozes: 3 });
    await coachStuckTasks();
    expect((await api(`tasks/${t.id}`)).body.task.stuck).not.toBeNull();
    // Its slips are forgotten (say the history was tidied) and a week passes.
    await db.delete(auditEventsTable).where(eq(auditEventsTable.entityId, t.id));
    await db.update(tasksTable).set({ stuckCheckedAt: new Date(Date.now() - 8 * DAY) }).where(eq(tasksTable.id, t.id));
    expect((await coachStuckTasks()).cleared).toBe(1);
    expect((await api(`tasks/${t.id}`)).body.task.stuck).toBeNull();
  });
});
