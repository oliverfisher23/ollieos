import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
