import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { aiClientsTable } from "./access";
import { entityTypeEnum, reviewKindEnum, reviewStatusEnum, suggestionKindEnum, suggestionStatusEnum } from "./enums";

/**
 * Knowledge Inbox (feature 01): what an AI tool proposes to add or change in the knowledge base.
 * Nothing here is knowledge until Ollie approves it. Rejected rows are kept 30 days so the same
 * thing is not proposed twice, then cleared when a sweep finishes.
 */
export const suggestionsTable = pgTable(
  "suggestions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: suggestionKindEnum("kind").notNull(),
    /** The item it belongs to; null for a new person, organisation or project */
    entityType: entityTypeEnum("entity_type"),
    entityId: integer("entity_id"),
    /** The proposed record, in the shape of the MCP input */
    payload: jsonb("payload").notNull(),
    /** Lower-case, single-spaced main text: the duplicate and 30-day rejected check */
    normalisedText: text("normalised_text").notNull(),
    /** email, meeting, chat, recording, voice */
    sourceType: text("source_type"),
    sourceRef: text("source_ref"),
    sourceUrl: text("source_url"),
    /** Human description of the source, e.g. "Email from Veronica Wilkinson, 30th October" */
    sourceLabel: text("source_label"),
    /** Client name: "Capture sweep", "Claude" */
    proposedBy: text("proposed_by").notNull(),
    /** Part O: when the AI contradiction check looked at this card; null until it has */
    checkedAt: timestamp("contradiction_checked_at", { withTimezone: true }),
    /** Part N: who made the claim, as written; the person when one matched; and when they said it */
    saidByName: text("said_by_name"),
    saidById: integer("said_by_id"),
    saidAt: timestamp("said_at", { withTimezone: true }),
    clientId: integer("client_id").references(() => aiClientsTable.id),
    status: suggestionStatusEnum("status").notNull().default("pending"),
    /** What approval created */
    resultType: entityTypeEnum("result_type"),
    resultId: integer("result_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("suggestions_status_idx").on(t.status),
    index("suggestions_entity_idx").on(t.entityType, t.entityId),
    index("suggestions_text_idx").on(t.normalisedText),
  ],
);

/** An approved item a card contradicts (Part O). */
export interface ContradictedItem {
  type: "fact" | "decision" | "rule";
  id: number;
  /** One line from the AI on how they disagree */
  why: string;
}

/** Stale and conflicting facts (feature 02). A conflict may be between a current fact and a pending suggestion. */
export const factReviewsTable = pgTable(
  "fact_reviews",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: reviewKindEnum("kind").notNull(),
    factIds: integer("fact_ids").array().notNull().default(sql`'{}'`),
    suggestionId: integer("suggestion_id").references(() => suggestionsTable.id, { onDelete: "set null" }),
    /** Part O, kind contradiction: the approved items the card disagrees with, and how, in a line */
    contradicts: jsonb("contradicts").$type<ContradictedItem[] | null>(),
    status: reviewStatusEnum("status").notNull().default("pending"),
    /** { action, keptFactId?, newFactId? } */
    resolution: jsonb("resolution"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("fact_reviews_status_idx").on(t.status)],
);

/** One row per setting (shelf lives, when the weekly check last ran, digest email later). */
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * The weekly round-up (Part O): what changed in the knowledge base over a week, made on the chosen
 * day and time (Fridays at 16:00 unless changed). The content is a snapshot; each line says whether
 * it may go in the Gmail draft (only what AI may see does).
 */
export const weeklyRoundupsTable = pgTable("weekly_roundups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  weekStart: timestamp("week_start", { withTimezone: true }).notNull(),
  weekEnd: timestamp("week_end", { withTimezone: true }).notNull().unique(),
  /** Made by hand from the page rather than on schedule */
  manual: boolean("manual").notNull().default(false),
  content: jsonb("content").notNull(),
  draftId: text("draft_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Suggestion = typeof suggestionsTable.$inferSelect;
export type WeeklyRoundup = typeof weeklyRoundupsTable.$inferSelect;
export type FactReview = typeof factReviewsTable.$inferSelect;
