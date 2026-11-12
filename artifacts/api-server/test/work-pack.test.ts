/**
 * Build plan section 28: the work pack, and the delegation suggester no longer resetting the Backlog
 * clear-out clock. The model is stood in at recordedCreate, so the real prompts are built and the
 * real answers parsed.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { coworkSessionsTable, db, peopleTable, taskPacksTable, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import type { AgentKey } from "../src/lib/agents";
import type { OutgoingDraft } from "../src/services/connectors/gmail";
import { suggestDelegations } from "../src/services/delegation";
import { buildWorkPacks, cleanPack, readyCount } from "../src/services/workPack";
import { scorecards } from "../src/services/scorecards";
import { api, useServer } from "./harness";
import { decision, person, project } from "./helpers";

type Call = { agent: AgentKey; system: string; content: string };
const calls: Call[] = [];
const answers: Partial<Record<AgentKey, (c: Call) => unknown>> = {};
const gmailDrafts: OutgoingDraft[] = [];

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
vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  saveGmailDraft: async (_thread: string | null, draftId: string | null, d: OutgoingDraft) => {
    gmailDrafts.push(d);
    return draftId ?? "draft-1";
  },
}));

useServer();

const reset = () => {
  calls.length = 0;
  gmailDrafts.length = 0;
  for (const k of Object.keys(answers)) delete answers[k as AgentKey];
};
const DAY = 86_400_000;
const OLD = new Date(Date.now() - 40 * DAY);

async function task(title: string, extra: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [t] = await db.insert(tasksTable).values({ title, status: "backlog", createdBy: "ollie", ...extra }).returning();
  return t;
}
const row = async (id: number) => (await db.select().from(tasksTable).where(eq(tasksTable.id, id)))[0];
const view = async (id: number) => (await api(`tasks/${id}`)).body.task;

describe("The delegation suggester and the Backlog clear-out clock", () => {
  it("looking at a task never counts as touching it", async () => {
    reset();
    const sam = await person("Sam Hyams");
    await db.update(peopleTable).set({ slackUserId: "USAM" }).where(eq(peopleTable.id, sam.id));
    const t = await task("Sort the filing", { updatedAt: OLD });
    answers.delegation = (c) => ({ tasks: [...c.content.matchAll(/\[(t\d+)\]/g)].map((m) => ({ task: m[1], reasoning: "", delegate: false, person: "", why: "", message: "" })) });
    expect((await suggestDelegations()).looked).toBe(1);
    const after = await row(t.id);
    expect(after.delegateCheckedAt).not.toBeNull();
    expect(after.updatedAt.getTime()).toBe(OLD.getTime());
    expect((await view(t.id)).stale).toBe(true);
  });
});

describe("Work pack", () => {
  async function dneSession(projectId?: number) {
    const [s] = await db
      .insert(coworkSessionsTable)
      .values({ title: "DNE follow-up deck: options and costs", summary: "Built a 13-slide deck for Veronica Wilkinson with three costed options: https://claude.ai/artifact/abc123", createdBy: "Claude", projectIds: projectId ? [projectId] : [] })
      .returning();
    return s;
  }
  const ready = (uses: string[]) => ({
    reasoning: "The deck exists",
    status: "ready_to_send",
    have: "The DNE options deck was built in a Cowork session — it is at https://claude.ai/artifact/abc123.",
    next: "Send Veronica the deck link with a short covering note.",
    uses,
    draft_to: "Veronica Wilkinson",
    draft_subject: "DNE options and costs",
    draft_body: "Hi Veronica,\n\nHere is the options deck: https://claude.ai/artifact/abc123\n\nOllie",
    outline: ["Should be dropped"],
    questions: ["Which option does Ross prefer?"],
  });

  it("finds what is already made, marks the task ready, and saves the message to Gmail as a draft", async () => {
    reset();
    const dne = await project("DNE outreach");
    const secret = await project("Buyer talks", { confidential: true });
    await decision(secret.id, "The DNE options deck goes to the buyer first");
    const veronica = await person("Veronica Wilkinson");
    await db.update(peopleTable).set({ email: "veronica@dne.org" }).where(eq(peopleTable.id, veronica.id));
    const s = await dneSession(dne.id);
    const send = await task("Send Veronica the DNE options deck and costs", { kind: "promise", status: "now", projectId: dne.id, personId: veronica.id });
    const dueSoon = await task("Share the DNE costs sheet", { dueDate: addDays(todayLondon(), 2) });
    const later = await task("Think about DNE next year");
    const hidden = await task("DNE options for the buyer", { status: "now", confidential: true });

    answers.work_pack = (c) => (c.content.includes("title: Send Veronica") ? ready([`session:${s.id}`, "decision:999"]) : { ...ready(["decision:999"]), status: "needs_work" });
    const r = await buildWorkPacks();
    expect(r).toMatchObject({ built: 2, ready: 1, failed: false });
    // Only items AI may see were gathered, and the task's rules of selection held.
    expect(calls.every((c) => !c.content.includes("buyer"))).toBe(true);
    expect(calls[0].content).toContain("https://claude.ai/artifact/abc123");
    expect(await db.select().from(taskPacksTable)).toHaveLength(2);
    expect((await db.select().from(taskPacksTable).where(eq(taskPacksTable.taskId, later.id)))).toHaveLength(0);
    expect((await api(`tasks/${hidden.id}/work-pack`, { method: "POST" })).status).toBe(400);

    const got = (await api(`tasks/${send.id}/work-pack`)).body.pack;
    expect(got).toMatchObject({ status: "ready_to_send", outline: [], questions: ["Which option does Ross prefer?"], savedToGmail: false });
    expect(got.have).not.toContain("—");
    expect(got.sources).toEqual([expect.objectContaining({ ref: `session:${s.id}`, type: "session" })]);
    expect(got.draft).toMatchObject({ to: "Veronica Wilkinson", subject: "DNE options and costs" });
    expect((await view(send.id)).pack).toBe("ready_to_send");
    // A pack that cites nothing it was given says nothing was found, and does not show on the task.
    expect((await api(`tasks/${dueSoon.id}/work-pack`)).body.pack.status).toBe("nothing_found");
    expect((await view(dueSoon.id)).pack).toBeNull();
    expect(await readyCount()).toBe(1);

    const saved = await api(`tasks/${send.id}/work-pack/gmail-draft`, { method: "POST" });
    expect(saved.body).toMatchObject({ savedToGmail: true });
    expect(gmailDrafts[0]).toMatchObject({ to: "veronica@dne.org", subject: "DNE options and costs" });
    expect(await readyCount()).toBe(0);
    expect((await scorecards()).find((x) => x.key === "work_packs")).toMatchObject({ kept: 1, undone: 0 });

    // Not useful takes it off the task; Build again brings a fresh one.
    await api(`tasks/${send.id}/work-pack/dismiss`, { method: "POST" });
    expect((await view(send.id)).pack).toBeNull();
    const again = await api(`tasks/${send.id}/work-pack`, { method: "POST" });
    expect(again.body).toMatchObject({ status: "ready_to_send", dismissedAt: null, savedToGmail: false });
  });

  it("writes no message for an email task, and calls no model with nothing held", async () => {
    reset();
    const s = await dneSession();
    const emailTask = await task("Send the DNE options deck", { status: "now", source: "email", sourceRef: "gmail:x1" });
    const lonely = await task("Zzyx qwv", { status: "now" });
    answers.work_pack = () => ready([`session:${s.id}`]);
    await buildWorkPacks();
    expect((await api(`tasks/${emailTask.id}/work-pack`)).body.pack).toMatchObject({ status: "ready_to_send", draft: null });
    expect((await api(`tasks/${lonely.id}/work-pack`)).body.pack.status).toBe("nothing_found");
    expect(calls.filter((c) => c.agent === "work_pack")).toHaveLength(1);
    expect(calls[0].system).toContain("came from an email");
  });

  it("keeps only refs it was given and never says ready on nothing", () => {
    expect(cleanPack({ status: "ready_to_send", have: "x", uses: ["session:9"] }, ["session:1"], false)).toMatchObject({ status: "nothing_found", uses: [], draft: null });
    expect(cleanPack({ status: "needs_work", have: "Two decisions", next: "Draft it", uses: ["decision:1"], outline: ["One", "Two"], draft_body: "Hi" }, ["decision:1"], false)).toMatchObject({
      status: "needs_work",
      uses: ["decision:1"],
      outline: ["One", "Two"],
      draft: { body: "Hi" },
    });
  });
});
