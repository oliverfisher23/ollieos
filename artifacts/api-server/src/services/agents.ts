/**
 * The Agents page (build plan section 21, Part V): every AI agent inside OllieOS with its runs, cost,
 * speed and errors over the last 7 days, and every connected AI (Claude, ChatGPT, Gemini, the sweep,
 * Ask OllieOS) with what it read, wrote and proposed.
 */
import { and, count, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { aiClientsTable, aiRunsTable, auditEventsTable, db, suggestionsTable } from "@workspace/db";
import { AGENTS, AGENT_KEYS, type AgentKind } from "../lib/agents";

export const AGENTS_WINDOW_DAYS = 7;

export interface AgentView {
  key: string;
  name: string;
  kind: AgentKind | "unknown";
  does: string;
  reads: string;
  /** The model of its latest run, or null when it has not run in the window */
  model: string | null;
  runs: number;
  failures: number;
  /** Estimated cost at list price, US dollars */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  avgMs: number | null;
  lastRunAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  /** Prompt versions it ran on in the window */
  promptVersions: number;
}

export interface ConnectedAiView {
  id: number;
  name: string;
  kind: string;
  auth: string;
  revoked: boolean;
  lastUsedAt: Date | null;
  reads: number;
  writes: number;
  proposals: { approved: number; rejected: number; merged: number; pending: number };
}

export interface AgentsView {
  since: Date;
  totalCostUsd: number;
  totalRuns: number;
  agents: AgentView[];
  connected: ConnectedAiView[];
}

const num = (v: unknown) => Number(v ?? 0);

export async function agentsView(now = new Date()): Promise<AgentsView> {
  const since = new Date(now.getTime() - AGENTS_WINDOW_DAYS * 86_400_000);
  const inWindow = gte(aiRunsTable.startedAt, since);
  const [stats, latest, errors] = await Promise.all([
    db
      .select({
        agent: aiRunsTable.agent,
        runs: count(),
        failures: sql<number>`count(*) filter (where not ${aiRunsTable.ok})`,
        cost: sql<number>`coalesce(sum(${aiRunsTable.costMicros}), 0)`,
        input: sql<number>`coalesce(sum(${aiRunsTable.inputTokens} + ${aiRunsTable.cacheReadTokens} + ${aiRunsTable.cacheWriteTokens}), 0)`,
        output: sql<number>`coalesce(sum(${aiRunsTable.outputTokens}), 0)`,
        avgMs: sql<number>`avg(${aiRunsTable.durationMs})`,
        versions: sql<number>`count(distinct ${aiRunsTable.promptVersion})`,
      })
      .from(aiRunsTable)
      .where(inWindow)
      .groupBy(aiRunsTable.agent),
    db
      .selectDistinctOn([aiRunsTable.agent], { agent: aiRunsTable.agent, model: aiRunsTable.model, at: aiRunsTable.startedAt })
      .from(aiRunsTable)
      .orderBy(aiRunsTable.agent, desc(aiRunsTable.startedAt)),
    db
      .selectDistinctOn([aiRunsTable.agent], { agent: aiRunsTable.agent, error: aiRunsTable.error, at: aiRunsTable.startedAt })
      .from(aiRunsTable)
      .where(and(inWindow, eq(aiRunsTable.ok, false)))
      .orderBy(aiRunsTable.agent, desc(aiRunsTable.startedAt)),
  ]);
  const byStats = new Map(stats.map((s) => [s.agent, s]));
  const byLatest = new Map(latest.map((l) => [l.agent, l]));
  const byError = new Map(errors.map((e) => [e.agent, e]));

  // Every known agent, plus any key recorded that is no longer in the list.
  const keys = [...AGENT_KEYS, ...[...byLatest.keys()].filter((k) => !(k in AGENTS))];
  const agents = keys.map((key): AgentView => {
    const info = (AGENTS as Record<string, { name: string; kind: AgentKind; does: string; reads: string }>)[key];
    const s = byStats.get(key);
    const l = byLatest.get(key);
    const e = byError.get(key);
    return {
      key,
      name: info?.name ?? key,
      kind: info?.kind ?? "unknown",
      does: info?.does ?? "No longer in OllieOS's list of agents.",
      reads: info?.reads ?? "",
      model: l?.model ?? null,
      runs: num(s?.runs),
      failures: num(s?.failures),
      costUsd: num(s?.cost) / 1_000_000,
      inputTokens: num(s?.input),
      outputTokens: num(s?.output),
      avgMs: s?.avgMs != null ? Math.round(num(s.avgMs)) : null,
      lastRunAt: l?.at ?? null,
      lastError: e?.error ?? null,
      lastErrorAt: e?.at ?? null,
      promptVersions: num(s?.versions),
    };
  });
  // Most expensive first, then busiest, then by name; agents with no runs last.
  agents.sort((a, b) => b.costUsd - a.costUsd || b.runs - a.runs || a.name.localeCompare(b.name));

  return {
    since,
    totalCostUsd: agents.reduce((n, a) => n + a.costUsd, 0),
    totalRuns: agents.reduce((n, a) => n + a.runs, 0),
    agents,
    connected: await connectedAis(since),
  };
}

/** Each connected AI: what it read and wrote in the window, and its Knowledge Inbox proposals. */
async function connectedAis(since: Date): Promise<ConnectedAiView[]> {
  const [clients, activity, proposals] = await Promise.all([
    db.select().from(aiClientsTable).orderBy(aiClientsTable.name),
    db
      .select({
        clientId: auditEventsTable.clientId,
        reads: sql<number>`count(*) filter (where ${auditEventsTable.action} = 'read')`,
        writes: sql<number>`count(*) filter (where ${auditEventsTable.action} not in ('read', 'search', 'request_access'))`,
      })
      .from(auditEventsTable)
      .where(and(isNotNull(auditEventsTable.clientId), gte(auditEventsTable.createdAt, since)))
      .groupBy(auditEventsTable.clientId),
    db
      .select({ clientId: suggestionsTable.clientId, status: suggestionsTable.status, n: count() })
      .from(suggestionsTable)
      .where(and(isNotNull(suggestionsTable.clientId), gte(suggestionsTable.createdAt, since), ne(suggestionsTable.status, "pending")))
      .groupBy(suggestionsTable.clientId, suggestionsTable.status),
  ]);
  const pending = await db
    .select({ clientId: suggestionsTable.clientId, n: count() })
    .from(suggestionsTable)
    .where(and(isNotNull(suggestionsTable.clientId), eq(suggestionsTable.status, "pending")))
    .groupBy(suggestionsTable.clientId);
  const act = new Map(activity.map((a) => [a.clientId, a]));
  return clients.map((c) => {
    const a = act.get(c.id);
    const mine = proposals.filter((p) => p.clientId === c.id);
    const of = (s: string) => num(mine.find((p) => p.status === s)?.n);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      auth: c.auth,
      revoked: !!c.revokedAt,
      lastUsedAt: c.lastUsedAt,
      reads: num(a?.reads),
      writes: num(a?.writes),
      proposals: { approved: of("approved"), rejected: of("rejected"), merged: of("merged"), pending: num(pending.find((p) => p.clientId === c.id)?.n) },
    };
  });
}
