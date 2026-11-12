/**
 * Message someone on Slack from a task (agreed with Ollie, 12th November 2026): to delegate it or
 * ask a colleague's view, OllieOS sends a Slack direct message as Ollie, then the task waits on
 * that person. The one thing OllieOS sends: only when Ollie presses Send and confirms, only to
 * people inside the business (with a Slack account and not at an outside organisation), and never
 * by AI or on a timer. Their reply is matched back to the task by Part U, like any Slack reply.
 */
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db, organisationsTable, peopleTable, tasksTable } from "@workspace/db";
import { formatShort, todayLondon } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { ConnectorError, proxyWriteJson } from "./connectors/http";
import { NotFoundError, UpstreamError, ValidationError } from "./tasks";

export const MAX_DM = 3000;

export interface DmPerson {
  id: number;
  name: string;
  role: string | null;
}

/** Colleagues OllieOS can message: a Slack account, and not at an outside organisation. */
export async function slackColleagues(): Promise<DmPerson[]> {
  return db
    .select({ id: peopleTable.id, name: peopleTable.name, role: peopleTable.role })
    .from(peopleTable)
    .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
    .where(and(isNotNull(peopleTable.slackUserId), eq(peopleTable.isSelf, false), or(isNull(peopleTable.organisationId), eq(organisationsTable.internal, true))))
    .orderBy(asc(peopleTable.name));
}

export interface DmOptions {
  people: DmPerson[];
  /** The task's own person, when they can be messaged */
  suggestedPersonId: number | null;
}

export async function dmOptions(taskId: number): Promise<DmOptions> {
  const [t] = await db.select({ personId: tasksTable.personId, waitingOn: tasksTable.waitingOnPersonId }).from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!t) throw new NotFoundError("That task does not exist");
  const people = await slackColleagues();
  const ids = new Set(people.map((p) => p.id));
  const suggested = [t.waitingOn, t.personId].find((id) => id != null && ids.has(id)) ?? null;
  return { people, suggestedPersonId: suggested };
}

/** Slack reports most failures as 200 with ok: false. */
async function slackPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let res: Record<string, unknown> | null;
  try {
    res = await proxyWriteJson("slack", "Slack", "POST", path, body);
  } catch (err) {
    if (err instanceof ConnectorError) throw new UpstreamError(err.message);
    throw err;
  }
  if (!res || res.ok === false) {
    const code = String(res?.error ?? "unknown_error");
    if (/missing_scope|not_allowed_token_type|restricted_action/.test(code)) {
      throw new UpstreamError(`Slack would not let OllieOS send messages (${code}). The Slack connection in Replit needs permission to write messages; reconnect it with that permission.`);
    }
    if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(code)) throw new UpstreamError(`Slack refused access (${code}). Reconnect it in Replit.`);
    throw new UpstreamError(`Slack did not send it: ${code}`);
  }
  return res;
}

export interface DmResult {
  personId: number;
  personName: string;
  channel: string;
  ts: string;
  /** Opens the conversation in Slack */
  url: string;
}

/**
 * Sends the message, then moves the task to Waiting on that person with a note of what was sent.
 * Nothing on the task changes when Slack refuses.
 */
export async function sendSlackDm(taskId: number, input: { personId: number; text: string }, actor: string): Promise<DmResult> {
  const text = input.text.trim();
  if (!text) throw new ValidationError("Write the message first");
  if (text.length > MAX_DM) throw new ValidationError(`Keep it under ${MAX_DM} characters`);
  const [task] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
  if (!task) throw new NotFoundError("That task does not exist");
  const colleague = (await slackColleagues()).find((p) => p.id === input.personId);
  if (!colleague) throw new ValidationError("OllieOS can only message colleagues with a Slack account, not people at outside organisations");
  const [person] = await db.select({ slackUserId: peopleTable.slackUserId }).from(peopleTable).where(eq(peopleTable.id, input.personId));

  const opened = await slackPost("/api/conversations.open", { users: person!.slackUserId });
  const channel = String((opened.channel as { id?: string } | undefined)?.id ?? "");
  if (!channel) throw new UpstreamError("Slack did not open a conversation with them");
  const posted = await slackPost("/api/chat.postMessage", { channel, text });
  const ts = String(posted.ts ?? "");

  const line = `Messaged ${colleague.name} on Slack, ${formatShort(todayLondon())}: "${text.length > 300 ? text.slice(0, 297) + "..." : text}"`;
  await db.transaction(async (tx) => {
    await tx
      .update(tasksTable)
      .set({
        status: "waiting",
        waitingOnPersonId: colleague.id,
        waitingSince: new Date(),
        notes: task.notes?.trim() ? `${task.notes.trim()}\n\n${line}` : line,
      })
      .where(eq(tasksTable.id, taskId));
    await writeAudit(tx, { actor, action: "slack_dm", entityType: "task", entityId: taskId, payload: { to: colleague.id, channel, ts, chars: text.length } });
  });
  return { personId: colleague.id, personName: colleague.name, channel, ts, url: `https://slack.com/app_redirect?channel=${channel}` };
}
