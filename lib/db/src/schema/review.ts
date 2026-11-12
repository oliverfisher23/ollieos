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
    /** Section 23: the pre-sorter's hint for Ollie (keep, reject, same as existing, a repeat); null when it gave none */
    presort: jsonb("presort").$type<PresortHint | null>(),
    /** Section 23: when the pre-sorter looked at this card; null until it has */
    presortedAt: timestamp("presorted_at", { withTimezone: true }),
    status: suggestionStatusEnum("status").notNull().default("pending"),
    /** What approval created */
    resultType: entityTypeEnum("result_type"),
    resultId: integer("result_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("suggestions_status_idx").on(t.status),
    index("suggestions_source_status_result_idx").on(t.sourceRef, t.status, t.resultType),
    index("suggestions_entity_idx").on(t.entityType, t.entityId),
    index("suggestions_text_idx").on(t.normalisedText),
  ],
);

/**
 * Section 23, the Knowledge Inbox pre-sorter: what it thinks Ollie will do with a card. "duplicate"
 * is found in code (another card waiting says the same); the rest come from the model.
 */
export interface PresortHint {
  verdict: "keep" | "reject" | "same" | "duplicate";
  /** One line on why */
  why: string;
  /** For "same": the approved item the card already says */
  sameAs?: { type: "fact" | "decision" | "rule"; id: number; text: string } | null;
  /** For "duplicate": the older card waiting that says the same */
  duplicateOf?: number | null;
}

/** Section 23, the stale fact checker: what OllieOS has seen since a stale fact was last confirmed. */
export interface StaleEvidence {
  /** confirmed: something since says it still holds; changed: something since says otherwise; none: nothing either way */
  verdict: "confirmed" | "changed" | "none";
  why: string;
  /** For "changed": the fact as it now seems to stand */
  newText: string | null;
  /** What it read, newest first: a ref ("note:3"), a label and when */
  sources: { ref: string; label: string; at: string }[];
}

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
    /** Section 23: for a stale review, what the stale fact checker found; null until it has looked */
    evidence: jsonb("evidence").$type<StaleEvidence | null>(),
    evidenceCheckedAt: timestamp("evidence_checked_at", { withTimezone: true }),
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

/**
 * Section 23, the Friday update drafter: Ollie's weekly leadership update for Slack, drafted from
 * the week in OllieOS. One row per week, keyed by the Friday it ends on. Never posted by OllieOS.
 */
export interface WeeklyUpdateSections {
  wins: string[];
  blockers: string[];
  ai: string[];
  quarterly: string[];
}

export const weeklyUpdatesTable = pgTable("weekly_updates", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  /** The Friday (London) the week ends on, YYYY-MM-DD */
  weekEnding: text("week_ending").notNull().unique(),
  sections: jsonb("sections").$type<WeeklyUpdateSections>().notNull(),
  /** How many items of each kind it was drafted from, and how many were hidden from AI */
  basis: jsonb("basis").notNull(),
  /** Ollie's own edits to the post, when he has made any; the post as drafted otherwise */
  editedText: text("edited_text"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type WeeklyUpdate = typeof weeklyUpdatesTable.$inferSelect;
export type Suggestion = typeof suggestionsTable.$inferSelect;
export type WeeklyRoundup = typeof weeklyRoundupsTable.$inferSelect;
export type FactReview = typeof factReviewsTable.$inferSelect;
