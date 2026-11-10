import { sql } from "drizzle-orm";
import { boolean, date, index, integer, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { tsvector } from "./enums";

/**
 * Strategy and ideas (build plan Part H). Strategy is a list of sections Ollie names himself; ideas
 * are things to come back to. Neither is knowledge: Claude can read both and add ideas, but never
 * edits or deletes them, and nothing goes through the Knowledge Inbox.
 */
export const strategySectionsTable = pgTable(
  "strategy_sections",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    body: text("body").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    /** Goals and projects this section drives */
    goalIds: integer("goal_ids").array().notNull().default(sql`'{}'::integer[]`),
    projectIds: integer("project_ids").array().notNull().default(sql`'{}'::integer[]`),
    confidential: boolean("confidential").notNull().default(false),
    aiAccess: boolean("ai_access").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set on delete so Undo can bring it back; purged a week later */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(name,'') || ' ' || coalesce(body,''))`),
  },
  (t) => [index("strategy_sections_search_idx").using("gin", t.search)],
);

export const IDEA_STATUSES = ["new", "come_back", "taken_forward", "dropped"] as const;
export const ideaStatusEnum = pgEnum("idea_status", IDEA_STATUSES);
export const IDEA_SOURCES = ["ollie", "claude", "session"] as const;
export const ideaSourceEnum = pgEnum("idea_source", IDEA_SOURCES);

export const ideasTable = pgTable(
  "ideas",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    /** Can hold a whole brainstorm */
    notes: text("notes"),
    status: ideaStatusEnum("status").notNull().default("new"),
    /** Come back to: the day it shows on Home and in the digest */
    comeBackOn: date("come_back_on", { mode: "string" }),
    goalId: integer("goal_id"),
    projectId: integer("project_id"),
    /** Taken forward: what it became */
    takenTaskId: integer("taken_task_id"),
    takenProjectId: integer("taken_project_id"),
    confidential: boolean("confidential").notNull().default(false),
    aiAccess: boolean("ai_access").notNull().default(true),
    source: ideaSourceEnum("source").notNull().default("ollie"),
    clientId: integer("client_id"),
    sessionId: integer("session_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set on delete so Undo can bring it back; purged a week later */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(title,'') || ' ' || left(coalesce(notes,''), 50000))`),
  },
  (t) => [index("ideas_search_idx").using("gin", t.search), index("ideas_status_idx").on(t.status, t.comeBackOn)],
);

export type StrategySection = typeof strategySectionsTable.$inferSelect;
export type Idea = typeof ideasTable.$inferSelect;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];
export type IdeaSource = (typeof IDEA_SOURCES)[number];
