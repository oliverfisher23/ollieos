/**
 * The one way OllieOS calls a model (build plan section 21, Part V). Each call is recorded in
 * `ai_runs` against the agent that made it, with tokens, time and an estimated cost. Recording never
 * fails the call: a problem writing the row is only logged.
 */
import { createHash } from "node:crypto";
import { lt } from "drizzle-orm";
import { aiRunsTable, db } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { costMicros, type AgentKey, type RunUsage } from "./agents";
import { logger } from "./logger";

type CreateParams = Parameters<typeof anthropic.messages.create>[0];

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null;
}

/** A short fingerprint of the instructions: the same prompt gives the same version. */
export function promptVersion(system: unknown): string {
  const text = typeof system === "string" ? system : JSON.stringify(system ?? "");
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

export function usageOf(u: ResponseUsage | undefined): RunUsage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    webSearches: u?.server_tool_use?.web_search_requests ?? 0,
  };
}

async function record(agent: AgentKey, model: string, version: string, started: number, ok: boolean, error: string | null, usage: RunUsage) {
  try {
    await db.insert(aiRunsTable).values({
      agent,
      model,
      promptVersion: version,
      startedAt: new Date(started),
      durationMs: Date.now() - started,
      ok,
      error: error ? error.slice(0, 500) : null,
      ...usage,
      costMicros: costMicros(model, usage),
    });
  } catch (err) {
    logger.warn({ err, agent }, "Could not record an AI run");
  }
}

/**
 * anthropic.messages.create, recorded. Returns the response as the SDK gives it, and rethrows the
 * SDK's error after recording it, so callers handle failures exactly as before.
 */
export async function recordedCreate<T = unknown>(agent: AgentKey, params: CreateParams): Promise<T> {
  const started = Date.now();
  const model = String((params as { model: string }).model);
  const version = promptVersion((params as { system?: unknown }).system);
  try {
    const res = (await anthropic.messages.create(params)) as unknown as { usage?: ResponseUsage };
    await record(agent, model, version, started, true, null, usageOf(res.usage));
    return res as T;
  } catch (err) {
    await record(agent, model, version, started, false, err instanceof Error ? err.message : String(err), usageOf(undefined));
    throw err;
  }
}

/** Runs older than this are cleared. */
export const KEEP_RUNS_DAYS = 90;

export async function clearOldAiRuns(now = new Date()): Promise<number> {
  const rows = await db
    .delete(aiRunsTable)
    .where(lt(aiRunsTable.startedAt, new Date(now.getTime() - KEEP_RUNS_DAYS * 86_400_000)))
    .returning({ id: aiRunsTable.id });
  return rows.length;
}
