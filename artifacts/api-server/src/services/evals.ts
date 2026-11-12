/**
 * Test cases and replays (build plan section 21, Part X). When Ollie corrects what a reader did (an
 * Inbox item that should not have been made, or one he kept that it got right), "Keep as a test
 * case" saves the exchange it was given and what it should have found. Before a changed prompt or
 * model ships, a replay runs the reader as the code now stands against every saved case and says
 * which pass. Replays keep nothing and make no tasks.
 */
import { asc, desc, eq, lt, sql } from "drizzle-orm";
import { aiInputsTable, db, evalCasesTable, evalReplaysTable, tasksTable, type EvalCase } from "@workspace/db";
import { AGENTS, type AgentKey } from "../lib/agents";
import { projectChoices } from "./connectors/capture";
import type { WorkUnit } from "./connectors/messages";
import { SORT_MODEL, sorterPromptVersion, sortUnits } from "./connectors/sorter";
import { NotFoundError, ValidationError } from "./tasks";
import { lessonsFor } from "./readerLessons";

/** Inputs older than this are cleared; a test case keeps its own copy. */
export const KEEP_INPUTS_DAYS = 30;
/** A replay runs at most this many cases. */
export const MAX_REPLAY_CASES = 60;

const SORTER_FOR: Record<string, AgentKey> = { email: "gmail_sorter", slack: "slack_sorter", meeting: "granola_reader" };
/** The agents test cases can be kept and replayed for. */
export const REPLAY_AGENTS: string[] = Object.values(SORTER_FOR);

export async function clearOldInputs(now = new Date()): Promise<number> {
  const rows = await db
    .delete(aiInputsTable)
    .where(lt(aiInputsTable.at, new Date(now.getTime() - KEEP_INPUTS_DAYS * 86_400_000)))
    .returning({ id: aiInputsTable.id });
  return rows.length;
}

const baseRef = (ref: string) => ref.replace(/#\d+$/, "");

/** What the reader was given for the exchange a task came from, if it is still kept. */
async function inputForTask(task: { source: string | null; sourceRef: string | null }) {
  if (!task.sourceRef || !task.source || !(task.source in SORTER_FOR)) return null;
  const [row] = await db
    .select()
    .from(aiInputsTable)
    .where(sql`${aiInputsTable.refs} @> array[${baseRef(task.sourceRef)}]::text[]`)
    .orderBy(desc(aiInputsTable.at))
    .limit(1);
  return row ?? null;
}

export interface TestCaseAvailability {
  /** Whether "Keep as a test case" can be offered */
  available: boolean;
  /** What a case kept now would expect */
  expected: "task" | "no_task";
  caseId: number | null;
}

/** Whether a task's exchange can still be kept as a test case, and what it would expect. */
export async function testCaseFor(taskId: number): Promise<TestCaseAvailability> {
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!t) throw new NotFoundError("That task does not exist");
  const expected = t.status === "noise" || t.status === "dropped" ? "no_task" : "task";
  const [existing] = await db.select({ id: evalCasesTable.id }).from(evalCasesTable).where(eq(evalCasesTable.taskId, taskId));
  if (t.createdBy !== "ollieos") return { available: false, expected, caseId: existing?.id ?? null };
  const input = await inputForTask(t);
  return { available: !!input, expected, caseId: existing?.id ?? null };
}

export interface TestCaseView {
  id: number;
  agent: string;
  agentName: string;
  title: string;
  expected: "task" | "no_task";
  gotThen: string[];
  note: string | null;
  taskId: number | null;
  createdAt: Date;
  lastResult: EvalCase["lastResult"];
}

function view(c: EvalCase): TestCaseView {
  const got = (c.gotThen as { title: string }[]).map((g) => g.title);
  return {
    id: c.id,
    agent: c.agent,
    agentName: (AGENTS as Record<string, { name: string }>)[c.agent]?.name ?? c.agent,
    title: c.title,
    expected: c.expected,
    gotThen: got,
    note: c.note,
    taskId: c.taskId,
    createdAt: c.createdAt,
    lastResult: c.lastResult,
  };
}

/**
 * Keeps the exchange behind a task as a test case. With no expectation given, an item Ollie sent
 * to Noise or dropped expects nothing to be found, and any other expects a task.
 */
export async function keepTestCase(taskId: number, input: { expected?: "task" | "no_task"; note?: string | null }, actor: string): Promise<TestCaseView> {
  const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!t) throw new NotFoundError("That task does not exist");
  if (t.createdBy !== "ollieos") throw new ValidationError("Only items OllieOS found in email, Slack or meeting notes can be kept as test cases");
  const row = await inputForTask(t);
  if (!row) throw new ValidationError(`What the reader was given for this item is no longer kept (inputs are kept ${KEEP_INPUTS_DAYS} days)`);
  const expected = input.expected ?? (t.status === "noise" || t.status === "dropped" ? "no_task" : "task");
  const title = (expected === "no_task" ? `Not a task: ${t.title}` : t.title).slice(0, 200);
  const values = { agent: row.agent, title, unit: row.unit, me: row.me, expected, gotThen: row.output, note: input.note?.trim() || null, taskId, createdBy: actor };
  const [saved] = await db
    .insert(evalCasesTable)
    .values(values)
    .onConflictDoUpdate({ target: [evalCasesTable.agent, evalCasesTable.taskId], set: { title, expected, note: values.note } })
    .returning();
  return view(saved);
}

export async function listTestCases(agent?: string): Promise<TestCaseView[]> {
  const rows = await db
    .select()
    .from(evalCasesTable)
    .where(agent ? eq(evalCasesTable.agent, agent) : undefined)
    .orderBy(asc(evalCasesTable.agent), desc(evalCasesTable.createdAt));
  return rows.map(view);
}

export async function removeTestCase(id: number): Promise<void> {
  const rows = await db.delete(evalCasesTable).where(eq(evalCasesTable.id, id)).returning({ id: evalCasesTable.id });
  if (!rows.length) throw new NotFoundError("That test case does not exist");
}

export interface ReplayResult {
  id: number;
  agent: string;
  model: string;
  promptVersion: string;
  total: number;
  passed: number;
  failed: { caseId: number; title: string; expected: string; got: string[] }[];
  /** The last replay before this one on the same agent, to compare against */
  previous: { model: string; promptVersion: string; total: number; passed: number; at: Date } | null;
  at: Date;
}

/** JSON loses Dates; the reader needs them back. */
function revive(unit: unknown): WorkUnit {
  const u = unit as WorkUnit;
  return { ...u, messages: u.messages.map((m) => ({ ...m, at: new Date(m.at) })) };
}

/**
 * Runs one reader, as the code now stands and with the lessons turned on for it, against its saved
 * cases. Section 24: extraLessonIds adds proposed lessons for a try, and keep: false records nothing
 * (no replay row, and the cases keep their last results).
 */
export async function replay(agent: string, opts: { model?: string | null; extraLessonIds?: number[]; keep?: boolean; by?: string } = {}, by = "ollie"): Promise<ReplayResult> {
  const keep = opts.keep !== false;
  const who = opts.by ?? by;
  if (!REPLAY_AGENTS.includes(agent)) throw new ValidationError("Replays are for the Gmail, Slack and Granola readers");
  const model = opts.model?.trim() || SORT_MODEL;
  const cases = await db.select().from(evalCasesTable).where(eq(evalCasesTable.agent, agent)).orderBy(asc(evalCasesTable.id)).limit(MAX_REPLAY_CASES);
  if (!cases.length) throw new ValidationError("There are no test cases for this agent yet. Keep one from an Inbox item first.");
  const lessons = await lessonsFor(agent, opts.extraLessonIds ?? []);
  const version = sorterPromptVersion(lessons);
  const projects = (await projectChoices()).map((p) => p.name);
  const [previous] = await db.select().from(evalReplaysTable).where(eq(evalReplaysTable.agent, agent)).orderBy(desc(evalReplaysTable.at)).limit(1);

  const failed: ReplayResult["failed"] = [];
  let passed = 0;
  for (const c of cases) {
    const unit = revive(c.unit);
    const now = unit.messages[unit.messages.length - 1]?.at ?? new Date();
    let got: string[];
    try {
      const [sorted] = await sortUnits([unit], { me: c.me, projects, now, known: null, agent: "test_replay", model, keepInputs: false, lessons });
      got = sorted.items.map((i) => i.title);
    } catch (err) {
      got = [`(the reader failed: ${err instanceof Error ? err.message : String(err)})`.slice(0, 200)];
      failed.push({ caseId: c.id, title: c.title, expected: c.expected, got });
      if (keep) await db.update(evalCasesTable).set({ lastResult: { at: new Date().toISOString(), model, promptVersion: version, passed: false, got } }).where(eq(evalCasesTable.id, c.id));
      continue;
    }
    const ok = c.expected === "task" ? got.length > 0 : got.length === 0;
    if (ok) passed++;
    else failed.push({ caseId: c.id, title: c.title, expected: c.expected, got });
    if (keep) await db.update(evalCasesTable).set({ lastResult: { at: new Date().toISOString(), model, promptVersion: version, passed: ok, got } }).where(eq(evalCasesTable.id, c.id));
  }
  const [row] = keep
    ? await db.insert(evalReplaysTable).values({ agent, model, promptVersion: version, total: cases.length, passed, failed, by: who }).returning()
    : [{ id: 0, at: new Date() }];
  return {
    id: row.id,
    agent,
    model,
    promptVersion: version,
    total: cases.length,
    passed,
    failed,
    previous: previous ? { model: previous.model, promptVersion: previous.promptVersion, total: previous.total, passed: previous.passed, at: previous.at } : null,
    at: row.at,
  };
}

export async function listReplays(limit = 20) {
  return db.select().from(evalReplaysTable).orderBy(desc(evalReplaysTable.at)).limit(limit);
}

/** Counts per agent for the Agents page. */
export async function caseCounts(): Promise<Map<string, { cases: number; lastReplay: { passed: number; total: number; at: Date; promptVersion: string; model: string } | null }>> {
  const counts = await db.select({ agent: evalCasesTable.agent, n: sql<number>`count(*)` }).from(evalCasesTable).groupBy(evalCasesTable.agent);
  const last = await db
    .selectDistinctOn([evalReplaysTable.agent], { agent: evalReplaysTable.agent, passed: evalReplaysTable.passed, total: evalReplaysTable.total, at: evalReplaysTable.at, promptVersion: evalReplaysTable.promptVersion, model: evalReplaysTable.model })
    .from(evalReplaysTable)
    .orderBy(evalReplaysTable.agent, desc(evalReplaysTable.at));
  const out = new Map<string, { cases: number; lastReplay: { passed: number; total: number; at: Date; promptVersion: string; model: string } | null }>();
  for (const c of counts) out.set(c.agent, { cases: Number(c.n), lastReplay: null });
  for (const l of last) {
    const cur = out.get(l.agent) ?? { cases: 0, lastReplay: null };
    cur.lastReplay = { passed: l.passed, total: l.total, at: l.at, promptVersion: l.promptVersion, model: l.model };
    out.set(l.agent, cur);
  }
  return out;
}
