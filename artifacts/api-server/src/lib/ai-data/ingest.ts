import { and, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { aiClientsTable, db, linksTable, noiseRulesTable, notesTable, sweepRunsTable, tasksTable } from "@workspace/db";
import { OPEN_STATUSES, PRIORITIES, TASK_SOURCES, isIsoDate, type Priority, type TaskSource, type TaskStatus } from "@workspace/shared";
import { writeAudit } from "../audit";
import { captureTask, enabledNoiseRules, type CaptureOutcome } from "./capture";
import { invalid, type Writer } from "./errors";
import { resolveLoose } from "./resolve";
import { recordReads, type AiScope } from "./scope";
import { doneSince, toTaskOuts, visibleTaskRows, type TaskOut } from "./tasks";
import { NO_GRANTS } from "./visibility";

/* ---------- The Capture sweep client ---------- */

export const SWEEP_CLIENT_NAME = "Capture sweep";
/** Ingest writes are audited as "ingest"; reads are logged under the client name so the AI log reads naturally. */
export const INGEST_ACTOR = "ingest";

export interface SweepClient {
  id: number;
  name: string;
  revokedAt: Date | null;
}

/** Who an ingest call acts as: the Capture sweep client. */
export interface IngestClient {
  id: number;
  name: string;
}

/** The api_key client the ingest API acts as. Created on first use. */
export async function sweepClient(): Promise<SweepClient> {
  const pick = { id: aiClientsTable.id, name: aiClientsTable.name, revokedAt: aiClientsTable.revokedAt };
  const [found] = await db.select(pick).from(aiClientsTable).where(and(eq(aiClientsTable.auth, "api_key"), eq(aiClientsTable.kind, "scheduled_task"))).orderBy(aiClientsTable.id).limit(1);
  if (found) return found;
  const [created] = await db
    .insert(aiClientsTable)
    .values({ name: SWEEP_CLIENT_NAME, kind: "scheduled_task", auth: "api_key", scopes: ["read", "write"], connectedAt: new Date() })
    .returning(pick);
  return created;
}

/** Ingest matches hints against everything, hidden or not, and reads with no grants. */
export const NO_INGEST_GRANTS = NO_GRANTS;

/** Ingest reads use no grants: a scheduled sweep cannot ask for access, so it sees only what is open to every tool. */
export function ingestScope(client: IngestClient): AiScope {
  return { clientId: client.id, actor: client.name, grants: NO_GRANTS };
}

export function ingestWriter(client: IngestClient): Writer {
  return { actor: INGEST_ACTOR, clientId: client.id };
}

/* ---------- Tasks ---------- */

export interface IngestTaskItem {
  source: TaskSource;
  source_ref: string;
  kind?: "task" | "promise";
  title: string;
  snippet?: string | null;
  source_quote?: string | null;
  source_url?: string | null;
  source_subject?: string | null;
  source_channel?: string | null;
  from_name?: string | null;
  from_address?: string | null;
  suggested_action?: string | null;
  suggested_priority?: Priority | null;
  suggested_due?: string | null;
  project_hint?: string | null;
  person_hint?: string | null;
  waiting_on_hint?: string | null;
  confidential?: boolean | null;
  captured_at?: string | null;
}

export interface IngestTaskResult {
  source_ref: string | null;
  outcome: CaptureOutcome | "error";
  task_id?: number;
  noise_rule_id?: number;
  error?: string;
}

function checkItem(item: IngestTaskItem): string | null {
  if (!item || typeof item !== "object") return "Each item must be an object";
  if (!TASK_SOURCES.includes(item.source)) return `source must be one of ${TASK_SOURCES.join(", ")}`;
  if (typeof item.source_ref !== "string" || !item.source_ref.trim()) return "source_ref is required";
  if (typeof item.title !== "string" || !item.title.trim()) return "title is required";
  if (item.kind && item.kind !== "task" && item.kind !== "promise") return "kind must be task or promise";
  if (item.suggested_priority && !PRIORITIES.includes(item.suggested_priority)) return "suggested_priority must be high, medium or low";
  if (item.suggested_due && !isIsoDate(item.suggested_due)) return "suggested_due must be a date like 2026-11-09";
  if (item.captured_at && Number.isNaN(new Date(item.captured_at).getTime())) return "captured_at must be an ISO date-time";
  return null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * POST /api/ingest/tasks (PRD 12). Each item is its own transaction, so one bad item does not
 * stop the rest. Hints resolve against every item, hidden or not, so a hint naming a hidden
 * project makes the new task inherit hidden. task_id is returned only when the task is visible.
 */
export async function ingestTasks(client: IngestClient, items: IngestTaskItem[]): Promise<IngestTaskResult[]> {
  if (!Array.isArray(items)) throw invalid("Send { items: [...] }.");
  if (items.length > 100) throw invalid("Send at most 100 items per call.");
  const scope = ingestScope(client);
  const who = ingestWriter(client);
  const rules = await enabledNoiseRules();
  const out: IngestTaskResult[] = [];
  for (const item of items) {
    const problem = checkItem(item);
    if (problem) {
      out.push({ source_ref: str(item?.source_ref), outcome: "error", error: problem });
      continue;
    }
    try {
      const hint = async (text: unknown, kind: "project" | "person") => {
        const t = str(text);
        return t ? ((await resolveLoose(t, [kind], NO_GRANTS, false))?.id ?? null) : null;
      };
      const [projectId, personId, waitingOnPersonId] = await Promise.all([
        hint(item.project_hint, "project"),
        hint(item.person_hint, "person"),
        hint(item.waiting_on_hint, "person"),
      ]);
      const res = await captureTask(
        {
          source: item.source,
          sourceRef: item.source_ref,
          kind: item.kind ?? "task",
          title: item.title,
          status: "inbox",
          priority: item.suggested_priority ?? undefined,
          dueDate: item.suggested_due ?? null,
          snippet: str(item.snippet),
          sourceQuote: str(item.source_quote),
          sourceUrl: str(item.source_url),
          sourceSubject: str(item.source_subject),
          sourceChannel: str(item.source_channel),
          fromName: str(item.from_name),
          fromAddress: str(item.from_address),
          suggestedAction: str(item.suggested_action),
          projectId,
          personId,
          waitingOnPersonId,
          confidential: typeof item.confidential === "boolean" ? item.confidential : null,
          capturedAt: item.captured_at ? new Date(item.captured_at) : null,
        },
        who,
        { noiseRules: rules, via: "ingest" },
      );
      const visible = res.taskId ? (await visibleTaskRows(scope, eq(tasksTable.id, res.taskId), { limit: 1 })).length > 0 : false;
      out.push({
        source_ref: item.source_ref,
        outcome: res.outcome,
        ...(visible && res.taskId ? { task_id: res.taskId } : {}),
        ...(res.noiseRuleId ? { noise_rule_id: res.noiseRuleId } : {}),
      });
    } catch (err) {
      out.push({ source_ref: item.source_ref, outcome: "error", error: err instanceof Error ? err.message : "Could not save this item" });
    }
  }
  return out;
}

/* ---------- Sweep runs ---------- */

/** When the last sweep finished with no errors, so the next sweep reads only newer items. */
export async function cursor(): Promise<{ last_finished_at: string | null }> {
  const [row] = await db
    .select({ finishedAt: sweepRunsTable.finishedAt })
    .from(sweepRunsTable)
    .where(and(isNotNull(sweepRunsTable.finishedAt), sql`jsonb_array_length(${sweepRunsTable.errors}) = 0`))
    .orderBy(desc(sweepRunsTable.finishedAt))
    .limit(1);
  return { last_finished_at: row?.finishedAt?.toISOString() ?? null };
}

export async function startSweep(client: IngestClient, startedAt?: string | null): Promise<{ id: number; started_at: string }> {
  const at = startedAt ? new Date(startedAt) : new Date();
  if (Number.isNaN(at.getTime())) throw invalid("started_at must be an ISO date-time.");
  const [row] = await db.insert(sweepRunsTable).values({ startedAt: at, clientId: client.id }).returning();
  await writeAudit(db, { actor: INGEST_ACTOR, clientId: client.id, action: "sweep_start", payload: { sweepRunId: row.id } });
  return { id: row.id, started_at: row.startedAt.toISOString() };
}

export interface FinishSweepInput {
  id: number;
  finished_at?: string | null;
  items_created?: number;
  items_noise?: number;
  items_duplicate?: number;
  activity_logged?: number;
  errors?: string[];
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);

/** Finishes a run and then deletes Noise older than 90 days (PRD 13). */
export async function finishSweep(client: IngestClient, input: FinishSweepInput): Promise<{ id: number; finished_at: string; noise_purged: number }> {
  if (!Number.isSafeInteger(input.id)) throw invalid("id is required to finish a sweep.");
  const at = input.finished_at ? new Date(input.finished_at) : new Date();
  if (Number.isNaN(at.getTime())) throw invalid("finished_at must be an ISO date-time.");
  const errors = Array.isArray(input.errors) ? input.errors.filter((e) => typeof e === "string").map((e) => e.slice(0, 500)).slice(0, 100) : [];
  const [row] = await db
    .update(sweepRunsTable)
    .set({
      finishedAt: at,
      itemsCreated: count(input.items_created),
      itemsNoise: count(input.items_noise),
      itemsDuplicate: count(input.items_duplicate),
      activityLogged: count(input.activity_logged),
      errors,
    })
    .where(eq(sweepRunsTable.id, input.id))
    .returning();
  if (!row) throw invalid("No sweep run has that id.");
  await writeAudit(db, { actor: INGEST_ACTOR, clientId: client.id, action: "sweep_finish", payload: { sweepRunId: row.id, errors: errors.length } });
  const purged = await purgeOldNoise(client.id);
  return { id: row.id, finished_at: at.toISOString(), noise_purged: purged };
}

/** Deletes Noise items untouched for 90 days, with their links and notes. capture_log keeps the source_ref so they stay deduped. */
export async function purgeOldNoise(clientId: number | null, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return db.transaction(async (tx) => {
    const old = await tx
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(eq(tasksTable.status, "noise"), lt(tasksTable.updatedAt, cutoff)));
    const ids = old.map((r) => r.id);
    if (!ids.length) return 0;
    await tx
      .delete(linksTable)
      .where(or(and(eq(linksTable.fromType, "task"), inArray(linksTable.fromId, ids)), and(eq(linksTable.toType, "task"), inArray(linksTable.toId, ids))));
    await tx.delete(notesTable).where(and(eq(notesTable.entityType, "task"), inArray(notesTable.entityId, ids)));
    await tx.update(noiseRulesTable).set({ createdFromTaskId: null }).where(inArray(noiseRulesTable.createdFromTaskId, ids));
    await tx.delete(tasksTable).where(inArray(tasksTable.id, ids));
    await writeAudit(tx, { actor: INGEST_ACTOR, clientId, action: "purge_noise", payload: { taskIds: ids, olderThan: cutoff.toISOString() } });
    return ids.length;
  });
}

/* ---------- Reads ---------- */

export async function ingestNoiseRules() {
  const rules = await enabledNoiseRules();
  return { rules: rules.map((r) => ({ id: r.id, match_type: r.matchType, match_value: r.matchValue, source: r.source })) };
}

export async function ingestOpenTasks(client: IngestClient): Promise<{ tasks: TaskOut[] }> {
  const scope = ingestScope(client);
  const rows = await visibleTaskRows(scope, inArray(tasksTable.status, [...OPEN_STATUSES] as TaskStatus[]), { limit: 1000 });
  const tasks = await toTaskOuts(scope, rows);
  await recordReads(scope, tasks.map((t) => t.ref), { route: "ingest/open-tasks" });
  return { tasks };
}

export async function ingestDone(client: IngestClient, since: string | undefined): Promise<{ tasks: TaskOut[] }> {
  const at = since ? new Date(since) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(at.getTime())) throw invalid("since must be an ISO date or date-time.");
  const scope = ingestScope(client);
  const tasks = await doneSince(scope, at);
  await recordReads(scope, tasks.map((t) => t.ref), { route: "ingest/done" });
  return { tasks };
}
