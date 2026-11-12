import { date, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { peopleTable } from "./knowledge";
import { tasksTable } from "./tasks";

/**
 * Slack to answer (build plan section 19, Part P): one row per Slack conversation whose newest
 * message, as far as the Slack check has seen, is from someone else and waits on Ollie. Direct
 * messages and group DMs count every message; channels only messages that @mention Ollie.
 *
 * The Slack check keeps each row up to date: a newer message from someone else replaces it, and a
 * message from Ollie after it (in the conversation, or in the thread of a channel mention) closes
 * it. Done hides it until a newer message arrives. Nothing here is ever posted to Slack.
 */
export const slackToAnswerTable = pgTable(
  "slack_to_answer",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** Slack's conversation id (D…, G… or C…) */
    conversationId: text("conversation_id").notNull().unique(),
    /** im, mpim or channel */
    kind: text("kind").notNull(),
    /** The other person for a DM, the names in a group DM, or "#channel" */
    place: text("place").notNull(),
    /** ts of the newest message waiting on Ollie */
    messageTs: text("message_ts").notNull(),
    /** Who wrote it */
    slackUserId: text("slack_user_id"),
    fromName: text("from_name"),
    personId: integer("person_id").references(() => peopleTable.id, { onDelete: "set null" }),
    /** The message, plain text, first 800 characters */
    text: text("text").notNull(),
    url: text("url").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** reply, info, or unknown (not read by AI: hidden from it, or the sorter gave nothing) */
    needs: text("needs").notNull().default("unknown"),
    /** One line on what they want */
    ask: text("ask"),
    /** "hidden" when someone in the conversation is hidden from AI, so it was not read for an ask */
    why: text("why"),
    /** The task made by Make a task */
    taskId: integer("task_id").references(() => tasksTable.id, { onDelete: "set null" }),
    /** messageTs when Ollie marked it Done: hidden until a newer message arrives */
    doneTs: text("done_ts"),
    /** A reply drafted for Ollie to copy, kept until he answers in Slack or removes it */
    draftText: text("draft_text"),
    /** What Ollie asked the draft to say, when he briefed it */
    draftBrief: text("draft_brief"),
    draftAt: timestamp("draft_at", { withTimezone: true }),
    /** Later: hidden until this day, or until a newer message than snoozedTs arrives */
    snoozedUntil: date("snoozed_until", { mode: "string" }),
    snoozedTs: text("snoozed_ts"),
    /** When a message from Ollie after it was seen */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("slack_to_answer_at_idx").on(t.at)],
);

export type SlackToAnswer = typeof slackToAnswerTable.$inferSelect;
