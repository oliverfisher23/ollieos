import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { priorityEnum, reviewItemKindEnum, reviewItemStateEnum } from "./enums";
import { peopleTable, projectsTable } from "./knowledge";
import { tasksTable } from "./tasks";

/**
 * The Review page. Two kinds of item wait here rather than in the Inbox, so weeks of old items do
 * not flood it:
 * - action (Assist Part C): actions a look back over old Granola notes found. Ollie turns each into
 *   a task (Now, Backlog or Waiting on), marks it already done, or drops it.
 * - no_reply (Assist Part D): an email Ollie sent that asked for something and got no answer.
 *   Chase makes a Waiting on task; Already handled and Dropped close it. When someone answers
 *   later, OllieOS closes it as answered.
 */
export const reviewItemsTable = pgTable(
  "review_items",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: reviewItemKindEnum("kind").notNull(),
    state: reviewItemStateEnum("state").notNull().default("pending"),
    /** granola:<note id>, with #2, #3 for more items from the same note; gmail:<message id> for Ollie's unanswered email */
    sourceRef: text("source_ref").notNull(),
    sourceUrl: text("source_url"),
    /** The meeting title, or the email subject */
    meetingTitle: text("meeting_title").notNull(),
    /** When the meeting was, or when Ollie sent the email */
    meetingAt: timestamp("meeting_at", { withTimezone: true }).notNull(),
    /** no_reply: the Gmail thread */
    threadId: text("thread_id"),
    /** no_reply: the address of the person who should answer */
    email: text("email"),
    /** no_reply: why Ollie was expecting an answer */
    reason: text("reason"),
    /** The action, written as a task title */
    text: text("text").notNull(),
    /** The next step for Ollie, in one sentence */
    action: text("action"),
    /** The line in the notes it came from */
    quote: text("quote"),
    /** What the sorter took it for: task, promise or waiting */
    suggestedType: text("suggested_type").notNull(),
    /** Who owns it, in words: "You" or the other person's name */
    owner: text("owner").notNull(),
    /** The person it is with, when they are in People */
    personId: integer("person_id").references(() => peopleTable.id, { onDelete: "set null" }),
    projectId: integer("project_id").references(() => projectsTable.id, { onDelete: "set null" }),
    dueDate: date("due_date", { mode: "string" }),
    priority: priorityEnum("priority").notNull().default("medium"),
    confidential: boolean("confidential"),
    /** The task it became (accepted, or done) */
    taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("review_items_source_ref_idx").on(t.sourceRef), index("review_items_state_idx").on(t.kind, t.state), index("review_items_thread_idx").on(t.threadId)],
);

export type ReviewItem = typeof reviewItemsTable.$inferSelect;
