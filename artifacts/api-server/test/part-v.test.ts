/**
 * Part V (build plan section 21): every AI run recorded against its agent, and the Agents page.
 */
import { describe, expect, it, vi } from "vitest";
import { aiRunsTable, auditEventsTable, db, suggestionsTable } from "@workspace/db";
import { AGENT_KEYS, costMicros } from "../src/lib/agents";
import { clearOldAiRuns, promptVersion, recordedCreate } from "../src/lib/aiRuns";
import { digestSummaryFromLines } from "../src/services/ask/model";
import { haikuJson } from "../src/services/connectors/sorter";
import { api, useServer } from "./harness";
import { client } from "./helpers";

/** What the fake model answers, or throws. */
let answer: { text: string; usage: Record<string, unknown> } | Error = { text: "{}", usage: {} };
let calls: Record<string, unknown>[] = [];

vi.mock("@workspace/integrations-anthropic-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/integrations-anthropic-ai")>()),
  anthropic: {
    messages: {
      create: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (answer instanceof Error) throw answer;
        return { content: [{ type: "text", text: answer.text }], usage: answer.usage };
      },
    },
  },
}));

useServer();

const DAY = 86_400_000;

describe("estimated cost", () => {
  it("prices Haiku, Sonnet, cache, long prompts and web searches at list price", () => {
    const u = (o: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearches: number }>) => ({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, ...o,
    });
    // Haiku: 1,000 in at $0.10/M and 200 out at $0.50/M is $0.0002.
    expect(costMicros("claude-haiku-5-5", u({ inputTokens: 1000, outputTokens: 200 }))).toBe(200);
    // Cache reads at $0.01/M and writes at $0.125/M.
    expect(costMicros("claude-haiku-5-5", u({ cacheReadTokens: 10_000, cacheWriteTokens: 8000 }))).toBe(1100);
    // Over 100,000 prompt tokens, Haiku is $0.50 in and $2.50 out.
    expect(costMicros("claude-haiku-5-5", u({ inputTokens: 120_000, outputTokens: 1000 }))).toBe(62_500);
    // Sonnet: $2 in, $10 out.
    expect(costMicros("claude-sonnet-5-5", u({ inputTokens: 1000, outputTokens: 1000 }))).toBe(12_000);
    // Three web searches at $10 per 1,000.
    expect(costMicros("claude-sonnet-5-5", u({ webSearches: 3 }))).toBe(30_000);
  });

  it("gives a prompt the same version until it changes", () => {
    expect(promptVersion("You sort email.")).toBe(promptVersion("You sort email."));
    expect(promptVersion("You sort email.")).not.toBe(promptVersion("You sort Slack."));
    expect(promptVersion("x")).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe("recording AI runs", () => {
  it("records a Haiku call against its agent with tokens, cost and prompt version", async () => {
    answer = { text: '{"ok":true}', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } };
    calls = [];
    const r = await haikuJson<{ ok: boolean }>("You judge noise.", "items", { type: "object" }, 512, "noise_judge");
    expect(r).toEqual({ ok: true });
    const [run] = await db.select().from(aiRunsTable);
    expect(run).toMatchObject({
      agent: "noise_judge",
      model: "claude-haiku-5-5",
      promptVersion: promptVersion("You judge noise."),
      ok: true,
      error: null,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 5000,
      costMicros: 250,
    });
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    // The call itself is unchanged.
    expect(calls[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 512, system: "You judge noise." });
  });

  it("records the Ask writers on Sonnet", async () => {
    answer = { text: '{"summary":"Two things need you."}', usage: { input_tokens: 300, output_tokens: 40 } };
    expect(await digestSummaryFromLines(["Needs you: a thing"])).toBe("Two things need you.");
    const [run] = await db.select().from(aiRunsTable);
    expect(run).toMatchObject({ agent: "digest_summary", model: "claude-sonnet-5-5", ok: true, costMicros: 1000 });
  });

  it("records a failed call with its error and still fails the call", async () => {
    answer = new Error("Overloaded");
    await expect(recordedCreate("thread_summary", { model: "claude-haiku-5-5", max_tokens: 10, system: "s", messages: [{ role: "user", content: "x" }] })).rejects.toThrow("Overloaded");
    const [run] = await db.select().from(aiRunsTable);
    expect(run).toMatchObject({ agent: "thread_summary", ok: false, error: "Overloaded", costMicros: 0 });
  });

  it("clears runs older than 90 days", async () => {
    const base = { agent: "noise_judge", model: "claude-haiku-5-5", promptVersion: "abc", durationMs: 10, ok: true };
    await db.insert(aiRunsTable).values([
      { ...base, startedAt: new Date(Date.now() - 91 * DAY) },
      { ...base, startedAt: new Date(Date.now() - 89 * DAY) },
    ]);
    expect(await clearOldAiRuns()).toBe(1);
    expect(await db.select().from(aiRunsTable)).toHaveLength(1);
  });
});

describe("the Agents page", () => {
  it("lists every agent with its week's runs, cost, speed and last error, most expensive first", async () => {
    const run = (agent: string, o: Partial<typeof aiRunsTable.$inferInsert> = {}) => ({
      agent, model: "claude-haiku-5-5", promptVersion: "v1", startedAt: new Date(Date.now() - DAY), durationMs: 400, ok: true, inputTokens: 1000, outputTokens: 100, costMicros: 150, ...o,
    });
    await db.insert(aiRunsTable).values([
      run("slack_sorter"),
      run("slack_sorter", { durationMs: 600, promptVersion: "v2" }),
      run("slack_sorter", { ok: false, error: "Could not read with AI", costMicros: 0, startedAt: new Date(Date.now() - 2 * DAY) }),
      run("brief_writer", { model: "claude-sonnet-5-5", costMicros: 20_000 }),
      // Outside the week: not counted, but its model and last run still show.
      run("research", { model: "claude-sonnet-5-5", startedAt: new Date(Date.now() - 10 * DAY), costMicros: 99_000 }),
    ]);
    const { status, body } = await api("agents");
    expect(status).toBe(200);
    expect(body.agents).toHaveLength(AGENT_KEYS.length);
    expect(body.totalRuns).toBe(4);
    expect(body.totalCostUsd).toBeCloseTo(0.0203, 6);
    expect(body.agents.slice(0, 2).map((a: { key: string }) => a.key)).toEqual(["brief_writer", "slack_sorter"]);
    const slack = body.agents.find((a: { key: string }) => a.key === "slack_sorter");
    expect(slack).toMatchObject({ name: "Slack sorter", kind: "sorter", model: "claude-haiku-5-5", runs: 3, failures: 1, avgMs: 467, promptVersions: 2, lastError: "Could not read with AI", inputTokens: 3000, outputTokens: 300 });
    expect(slack.costUsd).toBeCloseTo(0.0003, 6);
    const research = body.agents.find((a: { key: string }) => a.key === "research");
    expect(research).toMatchObject({ runs: 0, costUsd: 0, model: "claude-sonnet-5-5" });
    expect(research.lastRunAt).not.toBeNull();
  });

  it("shows each connected AI's reads, writes and Knowledge Inbox proposals", async () => {
    const claude = await client("Claude");
    const chatgpt = await client("ChatGPT");
    await db.insert(auditEventsTable).values([
      { actor: "Claude", clientId: claude.id, action: "read" },
      { actor: "Claude", clientId: claude.id, action: "read" },
      { actor: "Claude", clientId: claude.id, action: "create" },
      { actor: "Claude", clientId: claude.id, action: "search" },
      { actor: "Claude", clientId: claude.id, action: "read", createdAt: new Date(Date.now() - 9 * DAY) },
    ]);
    const card = (status: "approved" | "rejected" | "pending" | "merged") => ({ kind: "fact" as const, payload: {}, normalisedText: "x" + Math.random(), proposedBy: "Claude", clientId: claude.id, status });
    await db.insert(suggestionsTable).values([card("approved"), card("approved"), card("merged"), card("rejected"), card("pending")]);
    const { body } = await api("agents");
    const c = body.connected.find((x: { id: number }) => x.id === claude.id);
    expect(c).toMatchObject({ name: "Claude", reads: 2, writes: 1, revoked: false, proposals: { approved: 2, merged: 1, rejected: 1, pending: 1 } });
    const g = body.connected.find((x: { id: number }) => x.id === chatgpt.id);
    expect(g).toMatchObject({ reads: 0, writes: 0, proposals: { approved: 0, merged: 0, rejected: 0, pending: 0 } });
  });
});
