import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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

/** Stale and conflicting facts (feature 02). A conflict may be between a current fact and a pending suggestion. */
export const factReviewsTable = pgTable(
  "fact_reviews",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: reviewKindEnum("kind").notNull(),
    factIds: integer("fact_ids").array().notNull().default(sql`'{}'`),
    suggestionId: integer("suggestion_id").references(() => suggestionsTable.id, { onDelete: "set null" }),
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

export type Suggestion = typeof suggestionsTable.$inferSelect;
export type FactReview = typeof factReviewsTable.$inferSelect;
