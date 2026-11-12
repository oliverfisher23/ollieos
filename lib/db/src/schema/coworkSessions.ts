import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { tsvector } from "./enums";

/**
 * Cowork sessions (build plan 13, Part F): what Claude did in one Cowork session, saved by Claude at
 * the end with `save_session`. Kept as a record of work; facts and decisions in it reach Knowledge
 * only through the Knowledge Inbox. The table is not called "sessions" because sign-in uses that.
 */
export const coworkSessionsTable = pgTable(
  "cowork_sessions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** What was done, one line each */
    outcomes: jsonb("outcomes").$type<string[]>().notNull().default([]),
    /** Section 27: questions the session left open ("Decide whether…"), kept here instead of becoming Inbox tasks */
    openQuestions: jsonb("open_questions").$type<string[]>().notNull().default([]),
    /** The transcript or its key parts, as Claude sent it */
    transcript: text("transcript"),
    /** When the session happened (when it was saved, unless Claude says otherwise) */
    happenedAt: timestamp("happened_at", { withTimezone: true }).notNull().defaultNow(),
    /** Projects and people it touched: from Claude, and from what the knowledge step recognised */
    projectIds: integer("project_ids").array().notNull().default(sql`'{}'::integer[]`),
    personIds: integer("person_ids").array().notNull().default(sql`'{}'::integer[]`),
    /** Tasks and promises made in the session, including ones Claude logged as it went */
    taskIds: integer("task_ids").array().notNull().default(sql`'{}'::integer[]`),
    /** null means inherit from the projects it touched */
    confidential: boolean("confidential"),
    /** Claude's own id for the session, so saving it twice updates it */
    externalRef: text("external_ref").unique(),
    clientId: integer("client_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(outcomes::text,'') || ' ' || left(coalesce(transcript,''), 50000))`,
    ),
  },
  (t) => [index("cowork_sessions_search_idx").using("gin", t.search), index("cowork_sessions_happened_idx").on(t.happenedAt)],
);

export type CoworkSession = typeof coworkSessionsTable.$inferSelect;
