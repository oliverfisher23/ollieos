/**
 * Parts X and Y (build plan section 21): test cases kept from corrections and replayed, and checks
 * for the writers (code checks, a sampled grade, thumbs).
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { aiInputsTable, aiRunsTable, askThreadsTable, db, evalCasesTable, evalReplaysTable, rulesTable, tasksTable, writerScoresTable } from "@workspace/db";
import { buildDigest } from "../src/services/digest";
import { clearOldInputs, keepTestCase, replay, testCaseFor } from "../src/services/evals";
import { sortUnits } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { bannedPhrases, checkWriting, gradeIfDue, gradeSample, recordCheck } from "../src/services/writerChecks";
import { api, useServer } from "./harness";

/** What the fake model finds: the sorter returns one item while `finds` is true. */
let finds = true;
let systems: string[] = [];
vi.mock("@workspace/integrations-anthropic-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/integrations-anthropic-ai")>()),
  anthropic: {
    messages: {
      create: async (params: { system: string; model: string }) => {
        systems.push(params.system);
        const text = params.system.includes("You grade writing")
          ? JSON.stringify({ score: 2, reason: "It pads the answer." })
          : JSON.stringify({ results: [{ unit: "u1", summary: "", project: "", items: finds ? [{ type: "task", title: "Sign the contract", ref: "gmail:m1" }] : [], knowledge: [] }] });
        return { content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  },
}));
let digestLine = "Two things need you first — the contract and the budget.";
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => digestLine,
}));

useServer();

const DAY = 86_400_000;
const unit = (ref = "gmail:m1"): WorkUnit => ({
  source: "email",
  key: "gmail:t1",
  subject: "Contract",
  channel: null,
  people: [{ name: "Sam Lee", email: "sam@client.com" }],
  messages: [{ ref, at: new Date("2026-11-10T09:00:00Z"), fromMe: false, fromName: "Sam Lee", fromAddress: "sam@client.com", text: "Please sign the contract by Friday.", url: "https://mail.google.com/mail/u/0/#all/1" }],
});
const ctx = { me: "ollie@example.com", projects: [], now: new Date("2026-11-10T10:00:00Z"), known: null, agent: "gmail_sorter" as const };

async function connectorTask(status: "noise" | "now" | "inbox" = "noise", sourceRef = "gmail:m1") {
  const [t] = await db.insert(tasksTable).values({ title: "Sign the contract", status, createdBy: "ollieos", source: "email", sourceRef }).returning();
  return t;
}

describe("keeping a correction as a test case", () => {
  it("keeps what the reader was given and found, for 30 days", async () => {
    finds = true;
    const [s] = await sortUnits([unit()], ctx);
    expect(s.items.map((i) => i.title)).toEqual(["Sign the contract"]);
    const [row] = await db.select().from(aiInputsTable);
    expect(row).toMatchObject({ agent: "gmail_sorter", unitKey: "gmail:t1", refs: ["gmail:m1"], me: "ollie@example.com", output: [{ type: "task", title: "Sign the contract" }] });
    expect(await clearOldInputs(new Date(Date.now() + 29 * DAY))).toBe(0);
    expect(await clearOldInputs(new Date(Date.now() + 31 * DAY))).toBe(1);
  });

  it("offers it on items a reader made, expecting nothing for one sent to Noise, and updates rather than repeats", async () => {
    finds = true;
    await sortUnits([unit()], ctx);
    const t = await connectorTask("noise", "gmail:m1#2");
    expect(await testCaseFor(t.id)).toEqual({ available: true, expected: "no_task", caseId: null });
    const res = await api(`tasks/${t.id}/test-case`, { method: "POST", body: {} });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ agent: "gmail_sorter", agentName: "Gmail sorter", title: "Not a task: Sign the contract", expected: "no_task", gotThen: ["Sign the contract"], taskId: t.id });
    await api(`tasks/${t.id}/test-case`, { method: "POST", body: { expected: "task", note: "It was real" } });
    const cases = await db.select().from(evalCasesTable);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ expected: "task", title: "Sign the contract", note: "It was real" });
    expect((await api(`tasks/${t.id}/test-case`)).body).toMatchObject({ available: true, caseId: cases[0].id });
  });

  it("is not offered for items Ollie made, or once the input is gone", async () => {
    const [mine] = await db.insert(tasksTable).values({ title: "Mine", createdBy: "ollie", source: "manual" }).returning();
    expect((await testCaseFor(mine.id)).available).toBe(false);
    expect((await api(`tasks/${mine.id}/test-case`, { method: "POST", body: {} })).status).toBe(400);
    const old = await connectorTask("noise", "gmail:gone");
    const res = await api(`tasks/${old.id}/test-case`, { method: "POST", body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("no longer kept");
  });
});

describe("replaying test cases", () => {
  it("runs the reader as the code stands against each case, keeps nothing, and compares with the last replay", async () => {
    finds = true;
    await sortUnits([unit()], ctx);
    const t = await connectorTask("noise");
    await keepTestCase(t.id, {}, "ollie");
    const inputsBefore = (await db.select().from(aiInputsTable)).length;

    const first = await replay("gmail_sorter", {}, "ollie");
    expect(first).toMatchObject({ agent: "gmail_sorter", model: "claude-haiku-5-5", total: 1, passed: 0, previous: null });
    expect(first.failed[0]).toMatchObject({ expected: "no_task", got: ["Sign the contract"] });

    finds = false;
    const res = await api("evals/replay", { method: "POST", body: { agent: "gmail_sorter", model: "claude-sonnet-5-5" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: "claude-sonnet-5-5", total: 1, passed: 1, failed: [], previous: { passed: 0, total: 1 } });
    expect(res.body.promptVersion).toBe(first.promptVersion);

    expect((await db.select().from(aiInputsTable)).length).toBe(inputsBefore);
    expect(await db.select().from(tasksTable)).toHaveLength(1);
    expect(await db.select().from(evalReplaysTable)).toHaveLength(2);
    const runs = await db.select().from(aiRunsTable).where(eq(aiRunsTable.agent, "test_replay"));
    expect(runs.map((r) => r.model)).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    const [c] = await db.select().from(evalCasesTable);
    expect(c.lastResult).toMatchObject({ passed: true, model: "claude-sonnet-5-5", got: [] });

    const agents = (await api("agents")).body.agents as { key: string; tests: unknown; writing: unknown }[];
    expect(agents.find((a) => a.key === "gmail_sorter")!.tests).toMatchObject({ cases: 1, lastReplay: { passed: 1, total: 1 } });
    expect(agents.find((a) => a.key === "noise_judge")!.tests).toBeNull();
  });

  it("refuses an agent with no cases, or one that cannot be replayed", async () => {
    expect((await api("evals/replay", { method: "POST", body: { agent: "slack_sorter" } })).status).toBe(400);
    expect((await api("evals/replay", { method: "POST", body: { agent: "brief_writer" } })).status).toBe(400);
  });

  it("lists and removes cases", async () => {
    finds = true;
    await sortUnits([unit()], ctx);
    const t = await connectorTask("now");
    const c = await keepTestCase(t.id, {}, "ollie");
    expect(c.expected).toBe("task");
    expect((await api("evals/cases?agent=gmail_sorter")).body).toHaveLength(1);
    expect((await api(`evals/cases/${c.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await api(`evals/cases/${c.id}`, { method: "DELETE" })).status).toBe(404);
  });
});

describe("code checks on the writers", () => {
  it("flags em dashes, going over the word limit, citing what it was not given, and phrases a rule bans", async () => {
    await db.insert(rulesTable).values([
      { title: "No check-ins", appliesWhen: "Any email", rule: 'Never write "just checking in".' },
      { title: "Sign-off", appliesWhen: "Any email", rule: 'Sign off with "Best, Ollie".' },
    ]);
    const phrases = await bannedPhrases();
    expect(phrases).toEqual([{ phrase: "just checking in", rule: "No check-ins" }]);
    const issues = checkWriting("Hi Sam — Just checking in on this one.", { maxWords: 5, given: ["task:1"], cited: ["task:1", "task:9"], phrases });
    expect(issues.map((i) => i.kind)).toEqual(["em_dash", "too_long", "unknown_citation", "rule_phrase"]);
    expect(checkWriting("Hi Sam, thanks.", { maxWords: 5, phrases })).toEqual([]);
  });

  it("records a check for each piece written, one per piece", async () => {
    digestLine = "Two things need you first — the contract and the budget.";
    await db.insert(tasksTable).values({ title: "Overdue", status: "now", createdBy: "ollie", dueDate: "2026-11-01" });
    const d = await buildDigest("2026-11-16", new Date("2026-11-16T07:00:00Z"));
    const [row] = await db.select().from(writerScoresTable).where(eq(writerScoresTable.subject, `digest:${d.id}`));
    expect(row).toMatchObject({ agent: "digest_summary", kind: "check", score: 0 });
    expect((row.detail as { issues: { kind: string }[] }).issues.map((i) => i.kind)).toEqual(["em_dash"]);
    await recordCheck("digest_summary", `digest:${d.id}`, "All fine.", { maxWords: 35 });
    const rows = await db.select().from(writerScoresTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(1);
  });
});

describe("grading and thumbs", () => {
  it("grades a sample from each writer once a week, never anything that used hidden items", async () => {
    const now = new Date();
    const answer = { summary: "Sam wants the contract signed.", items: [{ text: "Sign by Friday.", refs: [] }] };
    const [open] = await db.insert(askThreadsTable).values({ question: "What does Sam want?", answer, citedIds: [], usedConfidential: false }).returning();
    await db.insert(askThreadsTable).values({ question: "Secret", answer, citedIds: [], usedConfidential: true });
    systems = [];
    expect(await gradeSample(now)).toBe(1);
    const [g] = await db.select().from(writerScoresTable).where(eq(writerScoresTable.kind, "grade"));
    expect(g).toMatchObject({ agent: "ask_answer", subject: `ask:${open.id}`, score: 2, detail: { reason: "It pads the answer." } });
    expect(systems.filter((s) => s.includes("You grade writing"))).toHaveLength(1);
    // Already graded: not graded again.
    expect(await gradeSample(now)).toBe(0);
    expect((await gradeIfDue(now)).ran).toBe(true);
    expect((await gradeIfDue(new Date(now.getTime() + DAY))).ran).toBe(false);
  });

  it("takes thumbs on Ask, briefs and the digest, and shows them with the grade on the Agents page", async () => {
    const answer = { summary: "x", items: [] };
    const [a] = await db.insert(askThreadsTable).values({ question: "Q", answer, citedIds: [], usedConfidential: false }).returning();
    expect((await api("feedback", { method: "POST", body: { subject: `ask:${a.id}`, thumb: "down", note: "Missed the point" } })).body).toEqual({ subject: `ask:${a.id}`, thumb: "down" });
    expect((await api(`feedback?subjects=ask:${a.id},ask:999`)).body).toEqual([{ subject: `ask:${a.id}`, thumb: "down" }, { subject: "ask:999", thumb: null }]);
    await gradeSample(new Date());
    const agents = (await api("agents")).body.agents as { key: string; writing: { grade: { average: number }; thumbs: { up: number; down: number } } | null }[];
    const w = agents.find((x) => x.key === "ask_answer")!.writing!;
    expect(w.grade.average).toBe(2);
    expect(w.thumbs).toEqual({ up: 0, down: 1 });
    expect(agents.find((x) => x.key === "gmail_sorter")!.writing).toBeNull();

    await api("feedback", { method: "POST", body: { subject: `ask:${a.id}`, thumb: null } });
    expect((await api(`feedback?subjects=ask:${a.id}`)).body).toEqual([{ subject: `ask:${a.id}`, thumb: null }]);
    expect((await api("feedback", { method: "POST", body: { subject: "task:1", thumb: "up" } })).status).toBe(400);
    expect((await api("feedback", { method: "POST", body: { subject: "brief:999", thumb: "up" } })).status).toBe(404);
  });
});
