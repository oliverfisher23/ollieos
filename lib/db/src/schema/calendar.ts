import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { aiClientsTable } from "./access";
import { projectsTable } from "./knowledge";

/** Today and the next 7 days only; replaced on each sweep. */
export const calendarEventsTable = pgTable(
  "calendar_events",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    sourceRef: text("source_ref").notNull().unique(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    attendees: text("attendees").array().notNull().default(sql`'{}'::text[]`),
    personal: boolean("personal").notNull().default(false),
    personIds: integer("person_ids").array().notNull().default(sql`'{}'::integer[]`),
    projectId: integer("project_id").references(() => projectsTable.id),
    location: text("location"),
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
