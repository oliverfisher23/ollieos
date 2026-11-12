import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { aiClientsTable } from "./access";
import { projectsTable } from "./knowledge";

/** One person on a calendar invite. response: accepted, tentative, declined or none (not answered). */
export interface CalendarAttendee {
  name: string;
  email?: string | null;
  response?: "accepted" | "tentative" | "declined" | "none" | null;
  organiser?: boolean;
}

/** One message in the conversation that shapes a meeting's agenda. */
export interface AgendaTurn {
  role: "ollie" | "ai";
  text: string;
  at: string;
}

/** How the meeting went against Ollie's agenda, worked out from its Granola note. */
export interface AgendaCheck {
  /** The note and the agenda (a hash of it) the check was made from, so a change to either shows as out of date */
  granolaRef: string;
  agendaHash: string;
  at: string;
  items: {
    title: string;
    status: "covered" | "partly" | "not_covered";
    /** One line on what was said or decided, or what was left */
    note: string;
    /** Ollie dropped it, so it is not offered on the next meeting's agenda */
    dropped?: boolean;
  }[];
}

/**
 * Today and the next 7 days, upserted by source_ref on each sweep so ids stay stable for briefs.
 * Future events no longer in the feed are removed; past events are kept for 30 days (build plan 29).
 * `attendees` holds names only (used for display and the AI name filter); `attendee_details` holds
 * the email and response for each, when the sweep sends them.
 */
export const calendarEventsTable = pgTable(
  "calendar_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sourceRef: text("source_ref").notNull().unique(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    attendees: text("attendees").array().notNull().default(sql`'{}'::text[]`),
    attendeeDetails: jsonb("attendee_details").$type<CalendarAttendee[]>().notNull().default([]),
    /** Teams, Zoom, Meet or In person; from the sweep, or worked out from the location */
    platform: text("platform"),
    personal: boolean("personal").notNull().default(false),
    /** Ollie said whether this is personal, so the calendar check leaves `personal` alone; carries to the rest of a repeating series */
    personalSetByOllie: boolean("personal_set_by_ollie").notNull().default(false),
    personIds: integer("person_ids").array().notNull().default(sql`'{}'::integer[]`),
    projectId: integer("project_id").references(() => projectsTable.id),
    location: text("location"),
    /** Part R: Google Calendar's id for the repeating series, when the event is one of a series */
    recurringEventId: text("recurring_event_id"),
    /**
     * Ollie's own agenda and notes for the meeting. Kept on the event, not the brief, so a meeting
     * with no prep page has them too. Only handed to AI when Ollie asks the agenda writer to shape
     * it. Older notes may still be on the brief.
     */
    notes: text("notes"),
    /** The conversation that shaped the agenda in notes: Ollie's thoughts and the agenda writer's replies */
    agendaChat: jsonb("agenda_chat").$type<AgendaTurn[]>().notNull().default([]),
    /**
     * The Granola note for the meeting, once it has ended: kept on every work meeting, with or
     * without a brief (a brief keeps its own copy too).
     */
    granolaRef: text("granola_ref"),
    granolaUrl: text("granola_url"),
    granolaNotes: text("granola_notes"),
    /** Inbox tasks made from the note's actions */
    granolaTaskIds: integer("granola_task_ids").array().notNull().default(sql`'{}'::integer[]`),
    granolaAttachedAt: timestamp("granola_attached_at", { withTimezone: true }),
    /** Each agenda item marked covered, partly or not covered from the Granola note; null until checked */
    agendaCheck: jsonb("agenda_check").$type<AgendaCheck | null>(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("calendar_events_starts_idx").on(t.startsAt)],
);

/**
 * Ollie's agenda for a meeting that left the calendar window before it started (moved further out,
 * or cancelled). Given back when an event with the same source_ref returns; cleared after 90 days.
 */
export const parkedMeetingNotesTable = pgTable("parked_meeting_notes", {
  sourceRef: text("source_ref").primaryKey(),
  title: text("title").notNull(),
  notes: text("notes"),
  agendaChat: jsonb("agenda_chat").$type<AgendaTurn[]>().notNull().default([]),
  parkedAt: timestamp("parked_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sweepRunsTable = pgTable(
  "sweep_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    itemsCreated: integer("items_created").notNull().default(0),
    itemsNoise: integer("items_noise").notNull().default(0),
    itemsDuplicate: integer("items_duplicate").notNull().default(0),
    activityLogged: integer("activity_logged").notNull().default(0),
    errors: jsonb("errors").$type<string[]>().notNull().default([]),
    clientId: integer("client_id").references(() => aiClientsTable.id),
  },
  (t) => [index("sweep_runs_finished_idx").on(t.finishedAt)],
);

export type CalendarEvent = typeof calendarEventsTable.$inferSelect;
export type SweepRun = typeof sweepRunsTable.$inferSelect;
