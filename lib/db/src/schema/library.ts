import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { docLocationEnum, tsvector } from "./enums";

/**
 * Document index (feature 06): a link, a summary and project links. OllieOS never stores the file.
 * Linked to projects through `links` (document to project).
 */
export const documentsTable = pgTable(
  "documents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    url: text("url").notNull().unique(),
    location: docLocationEnum("location").notNull(),
    summary: text("summary"),
    /** null means inherit from linked projects (build plan question 44) */
    confidential: boolean("confidential"),
    /** When Ollie or the sweep last confirmed it; shown as "Updated" */
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    suggestionId: integer("suggestion_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))`),
  },
  (t) => [index("documents_search_idx").using("gin", t.search)],
);

/**
 * Playbooks (feature 07): short standing rules every AI tool reads before drafting.
 * Global unless linked to projects or organisations through `links`. Paused ones are never sent to AI.
 */
export const playbooksTable = pgTable(
  "playbooks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    appliesWhen: text("applies_when").notNull(),
    rule: text("rule").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull().default("ollie"),
    suggestionId: integer("suggestion_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Rules stay short: 400 characters or fewer (feature 07 rule 5).
  (t) => [check("playbooks_rule_length", sql`char_length(${t.rule}) <= 400`)],
);

export type Document = typeof documentsTable.$inferSelect;
export type Playbook = typeof playbooksTable.$inferSelect;
