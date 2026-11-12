import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { activityTable, peopleTable } from "./knowledge";
import { calendarEventsTable } from "./calendar";

/** One sentence or question in a brief, with the refs it relies on (feature 03 rule 3). */
export interface BriefLine {
  text: string;
  cited: string[];
}

/**
 * Meeting briefs (feature 03). One per calendar event, written by Ask OllieOS from what AI may
 * read. why = null means "Not much on file". Removed with its event (30 days after it ends).
 */
export const meetingBriefsTable = pgTable("meeting_briefs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  calendarEventId: integer("calendar_event_id")
    .notNull()
    .unique()
    .references(() => calendarEventsTable.id, { onDelete: "cascade" }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
  why: jsonb("why").$type<BriefLine[] | null>(),
  questions: jsonb("questions").$type<BriefLine[] | null>(),
  /** Suggested agenda items; null on briefs written before the agenda existed */
  agenda: jsonb("agenda").$type<BriefLine[] | null>(),
  /** Why the questions are the kind they are, e.g. "You planned to start with discovery" */
  questionsNote: text("questions_note"),
  attendeeIds: integer("attendee_ids").array().notNull().default(sql`'{}'::integer[]`),
  projectIds: integer("project_ids").array().notNull().default(sql`'{}'::integer[]`),
  goalIds: integer("goal_ids").array().notNull().default(sql`'{}'::integer[]`),
  promiseIds: integer("promise_ids").array().notNull().default(sql`'{}'::integer[]`),
  documentIds: integer("document_ids").array().notNull().default(sql`'{}'::integer[]`),
  /** Rules (called playbooks before Part M, hence the column name) */
  ruleIds: integer("playbook_ids").array().notNull().default(sql`'{}'::integer[]`),
  /** Part M: In use playbooks linked to the meeting's projects and organisations */
  playbookIds: integer("process_playbook_ids").array().notNull().default(sql`'{}'::integer[]`),
  /** Part M: products linked to the meeting's projects and organisations */
  productIds: integer("product_ids").array().notNull().default(sql`'{}'::integer[]`),
  citedIds: text("cited_ids").array().notNull().default(sql`'{}'::text[]`),
  /** Every ref handed to the model */
  inputRefs: text("input_refs").array().notNull().default(sql`'{}'::text[]`),
  /** People, projects and organisations left out because they are hidden from AI; what "Allow" would open */
  heldBack: text("held_back").array().notNull().default(sql`'{}'::text[]`),
  /** Skips the model call when nothing it would read has changed */
  inputsHash: text("inputs_hash"),
  usedConfidential: boolean("used_confidential").notNull().default(false),
  /** The model call failed; why and questions are empty until it is tried again */
  failed: boolean("failed").notNull().default(false),
  notes: text("notes"),
  granolaRef: text("granola_ref"),
  granolaNotes: text("granola_notes"),
  /** Inbox tasks made from the meeting's actions (build plan 31) */
  actionTaskIds: integer("action_task_ids").array().notNull().default(sql`'{}'::integer[]`),
  model: text("model"),
  /** Part K: when Ollie first opened the prep page; null means not prepped yet */
  openedAt: timestamp("opened_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** One line in a digest section. refs let the summary step leave out items hidden from AI. */
export interface DigestItem {
  text: string;
  href: string | null;
  refs: string[];
  /** Hidden from AI by default: shown to Ollie with a lock, never named in an email */
  confidential: boolean;
}

export interface DigestSection {
  items: DigestItem[];
  /** How many more beyond the five shown */
  more: number;
  moreHref: string | null;
}

export interface DigestEvent {
  eventId: number;
  title: string;
  startsAt: string;
  hasBrief: boolean;
}

export interface DigestSections {
  needs: DigestSection | null;
  moved: DigestSection | null;
  quiet: DigestSection | null;
  /** Part Q: Library documents someone else changed since the last digest. Missing on older digests. */
  changed?: DigestSection | null;
  today: DigestEvent[];
  quietNight: boolean;
}

/** Daily digest (feature 08): one per weekday, built after the first sweep. Kept 30 days. */
export const digestsTable = pgTable("digests", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  forDate: date("for_date", { mode: "string" }).notNull().unique(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  summary: text("summary"),
  sections: jsonb("sections").$type<DigestSections>().notNull(),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MeetingBrief = typeof meetingBriefsTable.$inferSelect;
export type Digest = typeof digestsTable.$inferSelect;

/**
 * "Next time I see…" points (build plan section 14, Part K): things Ollie wants to raise with a
 * person. Open points go at the top of the agenda of the next meeting that person is in. When that
 * meeting's Granola notes arrive, points the notes show were covered move to Raised; the rest carry
 * over. Ollie can tick or untick by hand.
 */
export const talkingPointsTable = pgTable(
  "talking_points",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    personId: integer("person_id")
      .notNull()
      .references(() => peopleTable.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** ollie, or the AI client that added it */
    createdBy: text("created_by").notNull(),
    /** open or raised */
    status: text("status").notNull().default("open"),
    raisedAt: timestamp("raised_at", { withTimezone: true }),
    /** The meeting it was raised in, while that meeting is still on file */
    raisedEventId: integer("raised_event_id").references(() => calendarEventsTable.id, { onDelete: "set null" }),
    raisedTitle: text("raised_title"),
    /** notes: Granola notes showed it was covered; ollie: ticked by hand */
    raisedHow: text("raised_how"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("talking_points_person_idx").on(t.personId, t.status)],
);

export type TalkingPoint = typeof talkingPointsTable.$inferSelect;

/**
 * Whether a recent email or Slack thread is about a meeting, for its prep page. Ollie's own
 * verdicts (source "ollie", from "Not about this meeting") are the examples the thread matcher
 * learns from; its own verdicts (source "ai") are cached so each thread is judged once per meeting.
 * Ollie's "not about it" also applies to the rest of a repeating series.
 */
export const meetingThreadChecksTable = pgTable(
  "meeting_thread_checks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    calendarEventId: integer("calendar_event_id")
      .notNull()
      .references(() => calendarEventsTable.id, { onDelete: "cascade" }),
    /** Google Calendar's series id, so a verdict carries to the next meeting in the series */
    seriesId: text("series_id"),
    activityId: integer("activity_id")
      .notNull()
      .references(() => activityTable.id, { onDelete: "cascade" }),
    related: boolean("related").notNull(),
    /** "ollie" or "ai" */
    source: text("source").notNull(),
    reason: text("reason"),
    /** What the meeting and thread were called when judged: the examples outlive the meeting */
    meetingTitle: text("meeting_title").notNull(),
    threadSummary: text("thread_summary").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("meeting_thread_checks_event_activity").on(t.calendarEventId, t.activityId),
    index("meeting_thread_checks_series_idx").on(t.seriesId),
    index("meeting_thread_checks_source_idx").on(t.source, t.updatedAt),
  ],
);

export type MeetingThreadCheck = typeof meetingThreadChecksTable.$inferSelect;
