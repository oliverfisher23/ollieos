import { sql } from "drizzle-orm";
import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    /** How it repeats, anchored on its due date; null when it does not (Part I) */
    repeat: jsonb("repeat").$type<RepeatRule>(),
    /** The next copy made when this one was ticked off, so it is only made once */
    repeatNextId: integer("repeat_next_id"),
    /** Checklist steps inside the task, in order */
    steps: jsonb("steps").$type<TaskStep[]>().notNull().default([]),
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

/** How a task repeats; mirrors RepeatRule in @workspace/shared, which works out the dates. */
export interface RepeatRule {
  every: "day" | "weekday" | "week" | "fortnight" | "month" | "quarter" | "year";
  day?: number;
  month?: number;
  weekday?: number;
  nth?: number;
}

/** One step of a task's checklist. The id is a short random string made by whoever adds it. */
export interface TaskStep {
  id: string;
  title: string;
  done: boolean;
}

/** One task in a day's plan; start is "HH:MM" London time, null when it did not fit (Part I). */
export interface PlanItem {
  taskId: number;
  minutes: number;
  start: string | null;
}

/** Plan my day: the tasks Ollie picked for a day, fitted around his meetings. */
export const dayPlansTable = pgTable("day_plans", {
  date: date("date", { mode: "string" }).primaryKey(),
  items: jsonb("items").$type<PlanItem[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

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
  /** Ollie's one-line brief from "Brief a reply"; the draft is written from it in the background */
  brief: text("brief"),
  /** Ready to look at, still being written, or the background write failed */
  state: text("state", { enum: ["ready", "writing", "failed"] }).notNull().default("ready"),
  /** Why the background write failed */
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Short summaries of long email threads, kept until a new message arrives. */
export const threadSummariesTable = pgTable("thread_summaries", {
  threadId: text("thread_id").primaryKey(),
  /** The newest message when the summary was written; a newer one means it is out of date */
  lastMessageId: text("last_message_id").notNull(),
  messageCount: integer("message_count").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ThreadSummary = typeof threadSummariesTable.$inferSelect;
export type ReplyDraft = typeof replyDraftsTable.$inferSelect;

/**
 * Evidence on a task (build plan section 20, Part U): a later Slack message, email or meeting note
 * that shows the task is done or moving. One row per task and message. Evidence from the task's own
 * conversation that it is done closes the task (`applied`); evidence from anywhere else puts "Looks
 * done" on it until Ollie marks it done or says it is not (`dismissedAt`). Removed with the task.
 */
export const taskEvidenceTable = pgTable(
  "task_evidence",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskId: integer("task_id")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    /** slack, email or meeting */
    source: text("source").notNull(),
    /** The message's capture ref, for example slack:D123:1731234567.000100 or gmail:18c2f0 */
    sourceRef: text("source_ref").notNull(),
    url: text("url"),
    /** "You" for Ollie, otherwise the name as written */
    saidBy: text("said_by"),
    saidAt: timestamp("said_at", { withTimezone: true }).notNull(),
    /** Where it was said: the Slack conversation, email subject or meeting title */
    place: text("place"),
    quote: text("quote").notNull(),
    /** done or progress */
    shows: text("shows").notNull(),
    /** same: from the task's own conversation; other: anywhere else */
    strength: text("strength").notNull(),
    /** True when this evidence closed the task */
    applied: boolean("applied").notNull().default(false),
    /** Ollie said "Not done" to a Looks done marker */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("task_evidence_task_ref_idx").on(t.taskId, t.sourceRef), index("task_evidence_task_idx").on(t.taskId)],
);

export type TaskEvidence = typeof taskEvidenceTable.$inferSelect;
