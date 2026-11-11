import { sql } from "drizzle-orm";
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
    index("audit_events_ai_batch_idx").on(sql`coalesce(${t.payload}->>'batch', 'e' || ${t.id}::text)`, t.id)
      .where(sql`${t.clientId} is not null and ${t.actor} <> 'ollie'`),
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
