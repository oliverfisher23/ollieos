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
    personIds: integer("person_ids").array().notNull().default(sql`'{}'::integer[]`),
    projectId: integer("project_id").references(() => projectsTable.id),
    location: text("location"),
    /** Part R: Google Calendar's id for the repeating series, when the event is one of a series */
    recurringEventId: text("recurring_event_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("calendar_events_starts_idx").on(t.startsAt)],
);

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
