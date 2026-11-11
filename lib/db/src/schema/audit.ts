import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { entityTypeEnum } from "./enums";

/** Every write from any source, and every AI read, records who did it. */
export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** "ollie", "ingest", "claude", or the AI client name */
    actor: text("actor").notNull(),
    clientId: integer("client_id"),
    /** create, update, status, read, search, request_access, approve, decline, revoke, ... */
    action: text("action").notNull(),
    entityType: entityTypeEnum("entity_type"),
    entityId: integer("entity_id"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The AI activity group an event belongs to: its batch, or the event on its own. Stored so it
     * can be a plain indexed column; Replit's publish step garbles an index on the expression.
     */
    batchKey: text("batch_key").generatedAlwaysAs(sql`coalesce(payload->>'batch', 'e' || id::text)`),
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_created_idx").on(t.createdAt),
    index("audit_events_action_idx").on(t.action),
    index("audit_events_ai_batch_idx").on(t.batchKey, t.id).where(sql`${t.clientId} is not null and ${t.actor} <> 'ollie'`),
  ],
);

/** Indexed group headers; detailed events remain the source of counts and previews. */
export const aiActivityGroupsTable = pgTable("ai_activity_groups", {
  key: text("key").primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull(),
}, (t) => [index("ai_activity_groups_recent_idx").on(t.at.desc(), t.key.desc())]);

/** Ask OllieOS history. */
export const askThreadsTable = pgTable("ask_threads", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  parentId: integer("parent_id"),
  question: text("question").notNull(),
  answer: jsonb("answer").notNull(),
  citedIds: text("cited_ids").array().notNull(),
  usedConfidential: boolean("used_confidential").notNull().default(false),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ask_threads_parent_created_idx").on(t.parentId, t.createdAt.desc(), t.id.desc())]);

/** One-off imports, once per kind ("tasks", "knowledge"). */
export const importRunsTable = pgTable("import_runs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  kind: text("kind").notNull().unique(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  counts: jsonb("counts"),
  actor: text("actor").notNull(),
});

export type AuditEvent = typeof auditEventsTable.$inferSelect;
export type AskThread = typeof askThreadsTable.$inferSelect;

/**
 * Every call OllieOS makes to a model (build plan section 21, Part V): which agent, model and
 * prompt version, how long it took, whether it worked, tokens, web searches and an estimated cost
 * at list price. No message, email or document text is kept. Kept 90 days.
 */
export const aiRunsTable = pgTable(
  "ai_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** The agent's key in the agent list (lib/agents.ts) */
    agent: text("agent").notNull(),
    model: text("model").notNull(),
    /** A short fingerprint of the instructions, so a prompt change shows as a new version */
    promptVersion: text("prompt_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    /** Estimated cost at list price, in millionths of a US dollar */
    costMicros: integer("cost_micros").notNull().default(0),
  },
  (t) => [index("ai_runs_agent_started_idx").on(t.agent, t.startedAt), index("ai_runs_started_idx").on(t.startedAt)],
);

export type AiRun = typeof aiRunsTable.$inferSelect;

/**
 * Part X (build plan section 21): what a sorter was given for one exchange and what it found, so a
 * correction can be kept as a test case. Only exchanges already cleared for AI reach a sorter, so
 * nothing hidden is kept here. Kept 30 days; a test case keeps its own copy.
 */
export const aiInputsTable = pgTable(
  "ai_inputs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    agent: text("agent").notNull(),
    /** The exchange's key, and the refs of its messages (what tasks point at) */
    unitKey: text("unit_key").notNull(),
    refs: text("refs").array().notNull(),
    /** The exchange as the sorter was given it */
    unit: jsonb("unit").notNull(),
    /** Ollie's account, as the sorter was told */
    me: text("me").notNull(),
    /** What it found: item titles and types */
    output: jsonb("output").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ai_inputs_refs_idx").using("gin", t.refs), index("ai_inputs_at_idx").on(t.at)],
);

/** Part X: an input kept as a test case, with what the agent should have done. */
export const evalCasesTable = pgTable(
  "eval_cases",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    agent: text("agent").notNull(),
    title: text("title").notNull(),
    unit: jsonb("unit").notNull(),
    me: text("me").notNull(),
    /** "task": it should find something to do; "no_task": it should find nothing */
    expected: text("expected").$type<"task" | "no_task">().notNull(),
    /** What it found when the case was kept */
    gotThen: jsonb("got_then").notNull(),
    note: text("note"),
    /** The task the correction was made on */
    taskId: integer("task_id"),
    createdBy: text("created_by").notNull().default("ollie"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** The last replay: when, which model and prompt, passed or not, and what it found */
    lastResult: jsonb("last_result").$type<{ at: string; model: string; promptVersion: string; passed: boolean; got: string[] } | null>(),
  },
  (t) => [uniqueIndex("eval_cases_task_idx").on(t.agent, t.taskId)],
);

/** Part X: each replay of the test cases, for comparing prompt versions and models. */
export const evalReplaysTable = pgTable("eval_replays", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  agent: text("agent").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  total: integer("total").notNull(),
  passed: integer("passed").notNull(),
  failed: jsonb("failed").$type<{ caseId: number; title: string; expected: string; got: string[] }[]>().notNull(),
  by: text("by").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Part Y: how the writers did on one piece of writing. "check" is the code check (1 passed, 0 not),
 * "grade" the sampled Sonnet grade (1 to 5), "thumb" Ollie's thumbs up (1) or down (-1). One of each
 * kind per piece; a later one replaces it.
 */
export const writerScoresTable = pgTable(
  "writer_scores",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    agent: text("agent").notNull(),
    /** What was written, e.g. "ask:12", "brief:4", "digest:9", "draft:31" */
    subject: text("subject").notNull(),
    kind: text("kind").$type<"check" | "grade" | "thumb">().notNull(),
    score: smallint("score").notNull(),
    /** Check: the problems found; grade: the reason; thumb: Ollie's note */
    detail: jsonb("detail"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("writer_scores_subject_kind_idx").on(t.subject, t.kind), index("writer_scores_agent_at_idx").on(t.agent, t.at)],
);

export type EvalCase = typeof evalCasesTable.$inferSelect;
export type WriterScore = typeof writerScoresTable.$inferSelect;
