import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Part S (build plan section 19): the tone of a meeting, from its Granola notes, for the client
 * pulse. One row per note.
 */
export const meetingTonesTable = pgTable(
  "meeting_tones",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    granolaRef: text("granola_ref").notNull().unique(),
    title: text("title").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** positive, neutral or concerned */
    tone: text("tone").notNull(),
    reason: text("reason"),
    personIds: integer("person_ids").array().notNull().default(sql`'{}'::integer[]`),
  },
  (t) => [index("meeting_tones_at_idx").on(t.at)],
);

/**
 * Part S: two known people seen together on an email thread or in a meeting. One row per pair and
 * thread or meeting (person_a < person_b). Used to propose "works with" relationships.
 */
export const coOccurrencesTable = pgTable(
  "co_occurrences",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    personA: integer("person_a").notNull(),
    personB: integer("person_b").notNull(),
    /** email or meeting */
    kind: text("kind").notNull(),
    /** The thread id or calendar source ref */
    ref: text("ref").notNull(),
    /** A subject or meeting title, for the evidence line */
    label: text("label"),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("co_occurrences_pair_ref_idx").on(t.personA, t.personB, t.ref), index("co_occurrences_at_idx").on(t.at)],
);

/**
 * Part R (build plan section 19): every work meeting Ollie went to, kept 2 years after the calendar
 * row is cleared (30 days), so OllieOS can say where time went and which repeating meetings bring
 * nothing. Written when the meeting ends; Granola fills in what came out of it.
 */
export const meetingHistoryTable = pgTable(
  "meeting_history",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** The calendar event id */
    sourceRef: text("source_ref").notNull().unique(),
    /** The repeating series it belongs to, if any */
    seriesId: text("series_id"),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    minutes: integer("minutes").notNull(),
    /** internal or external */
    scope: text("scope").notNull(),
    projectId: integer("project_id"),
    goalId: integer("goal_id"),
    /** The project's function: delivery, product, sales or marketing */
    businessFunction: text("business_function"),
    orgIds: integer("org_ids").array().notNull().default(sql`'{}'::integer[]`),
    personIds: integer("person_ids").array().notNull().default(sql`'{}'::integer[]`),
    /** Organiser's email, for "Draft a note to the organiser" */
    organiser: text("organiser"),
    hadNotes: boolean("had_notes").notNull().default(false),
    actions: integer("actions").notNull().default(0),
    decisions: integer("decisions").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("meeting_history_starts_idx").on(t.startsAt), index("meeting_history_series_idx").on(t.seriesId)],
);

/**
 * Section 25, the contact finder: someone OllieOS saw in an email thread, Slack conversation or
 * meeting who is not in Contacts. One row per person and place. Only exchanges AI may read are
 * recorded. Kept a year.
 */
export const contactSightingsTable = pgTable(
  "contact_sightings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** The lower-case email, or "slack:<user id>" */
    key: text("key").notNull(),
    email: text("email"),
    slackId: text("slack_id"),
    /** The display name as seen */
    name: text("name"),
    /** email, slack or meeting */
    source: text("source").notNull(),
    /** The thread, conversation or meeting note */
    ref: text("ref").notNull(),
    /** A subject or meeting title, for the card and the model */
    label: text("label"),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** Ollie wrote in it (sent, replied or posted) */
    ollieWrote: boolean("ollie_wrote").notNull().default(false),
    /** They wrote in it */
    theyWrote: boolean("they_wrote").notNull().default(false),
    /** From their email signature, when the reader found one */
    title: text("title"),
    company: text("company"),
  },
  (t) => [uniqueIndex("contact_sightings_key_ref_idx").on(t.key, t.ref), index("contact_sightings_key_idx").on(t.key), index("contact_sightings_at_idx").on(t.at)],
);

/**
 * Section 25: what the contact finder has already done with each person (key) and new company
 * domain ("domain:acme.com"), so nothing is proposed twice and a card Ollie rejected is never
 * proposed again.
 */
export const contactFinderSeenTable = pgTable("contact_finder_seen", {
  key: text("key").primaryKey(),
  /** proposed: a card is waiting; added: in Contacts; ignored: not a person or company, or Ollie said no */
  status: text("status").$type<"proposed" | "added" | "ignored">().notNull(),
  suggestionId: integer("suggestion_id"),
  /** person:<id> or organisation:<id> once added */
  result: text("result"),
  why: text("why"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export type ContactSighting = typeof contactSightingsTable.$inferSelect;
