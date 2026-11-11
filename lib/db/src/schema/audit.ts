import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
  },
  (t) => [
    index("audit_events_entity_idx").on(t.entityType, t.entityId),
    index("audit_events_created_idx").on(t.createdAt),
    index("audit_events_action_idx").on(t.action),
  ],
);

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
});

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
