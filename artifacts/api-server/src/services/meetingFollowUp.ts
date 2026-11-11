/**
 * Follow-up draft after a meeting (build plan section 14, Part K). When Granola notes arrive for an
 * external meeting, OllieOS drafts a recap in Ollie's writing style to the people who were there:
 * thanks, what was decided, who does what by when, and the next step. It is a task on Now ("Send the
 * follow-up for …") with the draft on it, listed on Email, Drafts as a meeting follow-up, and saved
 * to Gmail as a draft. Never sent. Agreed with Ollie: follow-ups only for external meetings.
 */
import { eq } from "drizzle-orm";
import { db, replyDraftsTable, type CalendarEvent } from "@workspace/db";
import { formatLong, formatTime, londonDate, toRef } from "@workspace/shared";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { defaultScope, recordReads, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { captureTask } from "./aiWrites";
import { askScope } from "./ask/ask";
import { draftFollowUpFromDocs } from "./ask/model";
import { loadMatchers, matchEvent } from "./briefs";
import { gmailAccount, saveGmailDraft } from "./connectors/gmail";
import type { MeetingNote } from "./connectors/granola";
import { writingStyleNote } from "./writingStyle";

export const followUpRef = (noteId: string) => `granola:${noteId}#follow-up`;

export interface FollowUpResult {
  taskId: number;
  savedToGmail: boolean;
}

/**
 * Writes the follow-up for one meeting, once. Returns null when the meeting is internal or personal,
 * when anyone or anything in it is hidden from AI, when there is no one to send it to, or when a
 * follow-up was already written for these notes.
 */
export async function writeFollowUp(
  event: CalendarEvent,
  note: MeetingNote,
  sorted: { items: { title: string; person: string; due: string }[]; decisions: { text: string; confidential: boolean }[] },
  myEmails: Set<string>,
): Promise<FollowUpResult | null> {
  if (event.personal) return null;
  const match = matchEvent(event, await loadMatchers());
  if (match.scope !== "external") return null;

  // Nothing about anyone or anything hidden from AI is ever sent to it.
  const refs = [...match.personIds.map((id) => toRef("person", id)), ...match.projectIds.map((id) => toRef("project", id)), ...match.orgIds.map((id) => toRef("organisation", id))];
  const visible = await visibleRefs(defaultScope(), refs);
  if (refs.some((r) => !visible.has(r))) return null;

  const to = (event.attendeeDetails ?? []).filter((a) => a.email && a.response !== "declined" && !myEmails.has(a.email.toLowerCase()));
  if (!to.length) return null;

  const when = `${formatLong(londonDate(event.startsAt))}, ${formatTime(event.startsAt)}`;
  const task = await captureTask(
    { actor: "ollieos", clientId: null },
    {
      title: `Send the follow-up for ${event.title}`.slice(0, 200),
      status: "now",
      source: "meeting",
      sourceRef: followUpRef(note.noteId),
      sourceUrl: note.url,
      sourceSubject: event.title,
      snippet: `Recap of ${event.title} on ${when}, drafted from the Granola notes.`,
      projectId: match.projectIds[0] ?? null,
      capturedAt: note.at,
    },
    { applyNoise: false, via: "meeting_follow_up" },
  );
  if (task.outcome === "duplicate" || task.taskId == null) return null;

  const scope = await askScope();
  const docs = await loadVisibleDocs(scope, await applicableRuleRefs(scope, refs));
  await recordReads(scope, docs.map((d) => d.ref), { via: "meeting_follow_up", event: event.id });
  let draft: { subject: string; body: string };
  try {
    draft = await draftFollowUpFromDocs({
      title: event.title,
      when,
      to: to.map((a) => a.name || a.email!),
      notes: note.notes.slice(0, 12_000),
      actions: sorted.items.map((i) => `${i.title}${i.due ? ` (by ${i.due})` : ""}`),
      decisions: sorted.decisions.filter((d) => !d.confidential).map((d) => d.text),
      docs,
      style: await writingStyleNote(),
    });
  } catch (err) {
    logger.warn({ err, event: event.id }, "Could not write a meeting follow-up");
    await db.insert(replyDraftsTable).values({ taskId: task.taskId, toLine: to.map((a) => a.email).join(", "), subject: `Following up: ${event.title}`, body: "", state: "failed", error: "The follow-up could not be written. Try again from the task." });
    return { taskId: task.taskId, savedToGmail: false };
  }

  const toLine = to.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email!)).join(", ");
  const [row] = await db.insert(replyDraftsTable).values({ taskId: task.taskId, toLine, subject: draft.subject, body: draft.body, state: "ready" }).returning();
  let savedToGmail = false;
  try {
    const draftId = await saveGmailDraft(null, null, { to: toLine, cc: "", subject: draft.subject, body: draft.body, inReplyTo: null, references: null });
    await db.update(replyDraftsTable).set({ gmailDraftId: draftId, savedAt: new Date(), account: await gmailAccount().catch(() => null) }).where(eq(replyDraftsTable.id, row.id));
    savedToGmail = true;
  } catch (err) {
    logger.warn({ err, event: event.id }, "Could not save a meeting follow-up to Gmail");
  }
  await writeAudit(db, { actor: "ollieos", action: "reply_draft", entityType: "task", entityId: task.taskId, payload: { via: "meeting_follow_up", event: event.id, savedToGmail } });
  return { taskId: task.taskId, savedToGmail };
}
