import { sql } from "drizzle-orm";
import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import {
  captureOutcomeEnum,
  noiseMatchEnum,
  priorityEnum,
  taskKindEnum,
  taskSourceEnum,
  taskStatusEnum,
  tsvector,
} from "./enums";
import { peopleTable, projectsTable } from "./knowledge";
import { goalsTable } from "./goals";

export const noiseRulesTable = pgTable("noise_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  matchType: noiseMatchEnum("match_type").notNull(),
  /** Stored lower-case */
  matchValue: text("match_value").notNull(),
  /** null means any source (meeting items are never auto-noised) */
  source: taskSourceEnum("source"),
  enabled: boolean("enabled").notNull().default(true),
  hitCount: integer("hit_count").notNull().default(0),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
  createdFromTaskId: integer("created_from_task_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tasksTable = pgTable(
  "tasks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    kind: taskKindEnum("kind").notNull().default("task"),
    status: taskStatusEnum("status").notNull().default("inbox"),
    priority: priorityEnum("priority").notNull().default("medium"),
    dueDate: date("due_date", { mode: "string" }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    source: taskSourceEnum("source").notNull().default("manual"),
    sourceRef: text("source_ref"),
    sourceUrl: text("source_url"),
    sourceQuote: text("source_quote"),
    sourceSubject: text("source_subject"),
    sourceChannel: text("source_channel"),
    fromName: text("from_name"),
    fromAddress: text("from_address"),
    snippet: text("snippet"),
    suggestedAction: text("suggested_action"),
    notes: text("notes"),
    waitingOnPersonId: integer("waiting_on_person_id").references(() => peopleTable.id),
    waitingSince: timestamp("waiting_since", { withTimezone: true }),
    personId: integer("person_id").references(() => peopleTable.id),
    projectId: integer("project_id").references(() => projectsTable.id),
    noiseRuleId: integer("noise_rule_id").references(() => noiseRulesTable.id),
    /** Overrides the goal inherited from the project (feature 04) */
    goalId: integer("goal_id").references(() => goalsTable.id, { onDelete: "set null" }),
    /** Ollie said this is not goal work, so the Goals page stops asking */
    notGoalWork: boolean("not_goal_work").notNull().default(false),
    /** null means inherit from linked items */
    confidential: boolean("confidential"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    /** Why the noise check thinks this Inbox item is probably noise; null when it looks real */
    noiseHint: text("noise_hint"),
    /** Ollie kept it despite the hint; kept items teach the check what is not noise */
    noiseHintKept: boolean("noise_hint_kept").notNull().default(false),
    /** When the noise check last looked at it; null means not yet */
    noiseCheckedAt: timestamp("noise_checked_at", { withTimezone: true }),
    search: tsvector("search").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(snippet,'') || ' ' || coalesce(notes,'') || ' ' || coalesce(source_quote,'') || ' ' || coalesce(from_name,''))`,
    ),
  },
  (t) => [
    index("tasks_status_idx").on(t.status),
    index("tasks_due_idx").on(t.dueDate),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_person_idx").on(t.personId),
    index("tasks_waiting_on_idx").on(t.waitingOnPersonId),
    index("tasks_completed_idx").on(t.completedAt),
    uniqueIndex("tasks_source_ref_unique").on(t.source, t.sourceRef).where(sql`source_ref is not null`),
    index("tasks_search_idx").using("gin", t.search),
  ],
);

export const captureLogTable = pgTable(
  "capture_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    source: taskSourceEnum("source").notNull(),
    sourceRef: text("source_ref").notNull(),
    taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
    outcome: captureOutcomeEnum("outcome").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("capture_log_source_ref_unique").on(t.source, t.sourceRef)],
);

export type Task = typeof tasksTable.$inferSelect;
export type InsertTask = typeof tasksTable.$inferInsert;
export type NoiseRule = typeof noiseRulesTable.$inferSelect;
export type CaptureLogEntry = typeof captureLogTable.$inferSelect;

/**
 * A reply to an email task, written by AI and edited by Ollie, and the Gmail draft it was saved to.
 * OllieOS never sends it; Ollie sends it from his own email.
 */
export const replyDraftsTable = pgTable("reply_drafts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  taskId: integer("task_id")
    .notNull()
    .unique()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  toLine: text("to_line").notNull().default(""),
  ccLine: text("cc_line").notNull().default(""),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull(),
  /** The Gmail thread it replies in; null when the email did not come from Gmail directly */
  threadId: text("thread_id"),
  /** Message-ID header of the message replied to, and the References chain */
  inReplyTo: text("in_reply_to"),
  references: text("references"),
  account: text("account"),
  gmailDraftId: text("gmail_draft_id"),
  savedAt: timestamp("saved_at", { withTimezone: true }),
  /** When a Gmail check saw Ollie send an email in the thread after this draft was written */
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** When Ollie took it off the Drafts list on the Email page; the draft stays on the task */
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ReplyDraft = typeof replyDraftsTable.$inferSelect;
