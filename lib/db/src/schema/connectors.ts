import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One row per time OllieOS read a service itself (Google Calendar now; Gmail, Slack, Drive and
 * Granola later). trigger is "timer" or "manual". Kept for 30 days.
 */
export const connectorRunsTable = pgTable(
  "connector_runs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    connector: text("connector").notNull(),
    trigger: text("trigger").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ok: boolean("ok").notNull().default(false),
    /** What the service gave back (events in the window, emails, messages). */
    found: integer("found").notNull().default(0),
    /** Per-connector counts, for example { replaced, removed, skipped }. */
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    /** The account read, for example the calendar's email address. */
    account: text("account"),
    error: text("error"),
  },
  (t) => [index("connector_runs_connector_idx").on(t.connector, t.startedAt)],
);

export type ConnectorRun = typeof connectorRunsTable.$inferSelect;
