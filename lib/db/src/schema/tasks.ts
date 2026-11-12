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
    /**
     * The Gmail thread id from the source link, including older account-specific links. Stored so
     * it can be a plain indexed column; Replit's publish step garbles an index on the expression.
     */
    gmailThreadId: text("gmail_thread_id").generatedAlwaysAs(sql`substring(source_url from '#all/([A-Za-z0-9]+)[[:space:]]*$')`),
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
    /**
     * Where Ollie dragged it in the task list; lower comes first. Null means never placed by hand,
     * so it sorts after placed tasks in the usual due-date order.
     */
    position: integer("position"),
    /** Checklist steps inside the task, in order */
    steps: jsonb("steps").$type<TaskStep[]>().notNull().default([]),
    /** Section 23: the delegation suggester's colleague for this task, with why and a draft Slack message */
    delegateHint: jsonb("delegate_hint").$type<DelegateHint | null>(),
    /** When the delegation suggester last looked at it; null means not yet */
    delegateCheckedAt: timestamp("delegate_checked_at", { withTimezone: true }),
    /** Ollie said "Not this one", so it is not suggested again */
    delegateDismissedAt: timestamp("delegate_dismissed_at", { withTimezone: true }),
    /** Section 27: when OllieOS looked for the person this task is with; null means not yet. Looked at once, so a link Ollie removes stays removed. */
    personCheckedAt: timestamp("person_checked_at", { withTimezone: true }),
    /** Section 27: why Ollie dropped it or sent it to Noise (not_mine, already_done, fyi, arranging, duplicate, not_needed); the Reader coach learns from it */
    dropReason: text("drop_reason"),
    /** Section 27: a Waiting on task is not flagged for a chase before this; null means three days after it started waiting */
    chaseAfter: timestamp("chase_after", { withTimezone: true }),
    /** Section 27: the stuck-task coach's line on why this keeps slipping and what to try */
    stuckHint: jsonb("stuck_hint").$type<StuckHint | null>(),
    /** When the stuck-task coach last looked at it; null means not yet */
    stuckCheckedAt: timestamp("stuck_checked_at", { withTimezone: true }),
    /** Ollie said "Not stuck", so it is not flagged again */
    stuckDismissedAt: timestamp("stuck_dismissed_at", { withTimezone: true }),
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
    // Same normalisation as inbox linking, including older account-specific Gmail URLs.
    index("tasks_gmail_thread_idx").on(t.gmailThreadId).where(sql`${t.source} = 'email'`),
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

/** Section 23: who could take a task off Ollie's hands, and the message he could send them. */
export interface DelegateHint {
  personId: number;
  personName: string;
  why: string;
  message: string;
}

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

/** Section 28: a task's work pack, as the writer gave it. */
export interface WorkPackContent {
  /** ready_to_send: the thing to send exists; needs_work: there is something to build on; nothing_found: nothing useful held */
  status: "ready_to_send" | "needs_work" | "nothing_found";
  /** What OllieOS already holds for this task, in a line or two */
  have: string;
  /** The next concrete step */
  next: string;
  /** A message to send, when one helps */
  draft: { to: string; subject: string; body: string } | null;
  /** For work still to do: the shape of it */
  outline: string[];
  /** What is not known and would be needed */
  questions: string[];
  /** Refs of the items it rests on */
  uses: string[];
}

/**
 * Section 28: the work pack for a task: what OllieOS already holds for it and the first output.
 * One per task; rebuilt on request. Only made for tasks AI may see, from items AI may see.
 */
export const taskPacksTable = pgTable("task_packs", {
  taskId: integer("task_id")
    .primaryKey()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  content: jsonb("content").$type<WorkPackContent>().notNull(),
  /** The Gmail draft the pack's message was saved as, if it was */
  gmailDraftId: text("gmail_draft_id"),
  /** Ollie copied or saved the draft */
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** Ollie said it was not useful */
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  /** Part L: the body as OllieOS last wrote it, to compare with what Ollie saved or sent */
  writtenBody: text("written_body"),
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
    /** done, progress, or same (section 26: the same work came up again here) */
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

/** Section 27: what the stuck-task coach says about a task that keeps slipping. */
export interface StuckHint {
  /** Why it looks stuck, for example "Due date moved 3 times" */
  why: string;
  /** first_step, split, delegate or drop */
  kind: string;
  /** One line on what to try */
  suggestion: string;
  /** For first_step and split: the step to add to its checklist */
  step: string | null;
}

/**
 * Section 26: pairs of open tasks that look like the same piece of work, found by matching words
 * and confirmed by the duplicate judge. Ollie merges them or says they are not the same; either
 * way the pair is never suggested again. task_a is always the lower id.
 */
export const taskDuplicatesTable = pgTable(
  "task_duplicates",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskA: integer("task_a")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    taskB: integer("task_b")
      .notNull()
      .references(() => tasksTable.id, { onDelete: "cascade" }),
    /** suggested: waiting for Ollie; not_same: the judge said no; dismissed: Ollie said no; merged */
    state: text("state").notNull().default("suggested"),
    /** The judge's one line on why they are the same work */
    reason: text("reason"),
    /** The task kept when merged */
    keptTaskId: integer("kept_task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("task_duplicates_pair_idx").on(t.taskA, t.taskB), index("task_duplicates_state_idx").on(t.state)],
);

export type TaskDuplicate = typeof taskDuplicatesTable.$inferSelect;

/**
 * Part L (build plan section 14): what OllieOS drafted and what Ollie changed, either by editing the
 * draft in OllieOS before saving it, or in Gmail or Superhuman before sending. Read once a week to
 * propose rules for changes made the same way three or more times.
 */
export const draftEditsTable = pgTable(
  "draft_edits",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
    /** edited: changed in OllieOS before saving; sent: the sent email differed from the draft */
    kind: text("kind").notNull(),
    original: text("original").notNull(),
    final: text("final").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("draft_edits_at_idx").on(t.at)],
);
