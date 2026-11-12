/**
 * Tasks that close themselves (build plan section 20, Part U).
 *
 * Before the Slack, Gmail and Granola reads, each exchange is given the open tasks it could be about:
 * tasks from the same Slack conversation or email thread, and tasks with the people in it or their
 * (outside) organisation. Automatic signing confirmations are checked against the tasks touched most
 * recently. The AI says which of them the new messages show are done or moving, quoting the sentence,
 * in the same read that sorts the messages (no extra AI call).
 *
 * Evidence from the task's own conversation that it is done closes it: Ollie saying he did it, or,
 * for a Waiting on task, the other person delivering. Anything else puts "Looks done" on the task
 * for Ollie to confirm. Each piece of evidence is used once per task, so a task Ollie reopens is not
 * closed again by it. Tasks hidden from AI are never offered.
 */
import { and, desc, eq, inArray, isNull, like, notInArray, or, sql } from "drizzle-orm";
import { db, organisationsTable, peopleTable, taskEvidenceTable, tasksTable, type TaskEvidence } from "@workspace/db";
import { OPEN_STATUSES, toRef } from "@workspace/shared";
import { defaultScope, visibleRefs } from "../lib/ai-data/scope";
import { logger } from "../lib/logger";
import type { WorkUnit } from "./connectors/messages";
import { NotFoundError, updateTask } from "./tasks";
import { similarOpenTasks } from "./duplicates";

/** Most open tasks offered from the people in an exchange (question 63) */
const PEOPLE_ITEMS = 15;
/** Most recently touched open tasks offered for a signing confirmation (question 63) */
const CONFIRMATION_ITEMS = 20;
/** Section 25: most open tasks offered because their title words appear in the exchange */
const SIMILAR_ITEMS = 8;
const OPEN = [...OPEN_STATUSES];

export interface OpenItem {
  /** task:<id>, as the AI sees it */
  ref: string;
  taskId: number;
  /** From this exchange's own conversation or thread */
  same: boolean;
  kind: string;
  status: string;
  title: string;
  /** Who it is with: the asker, the person promised to, or the person waited on */
  who: string | null;
  /** When the message it came from was written; later messages only count after this */
  since: Date;
}

export interface SortedProgress {
  /** task:<id> from the open items */
  item: string;
  shows: "done" | "progress";
  /** The message it comes from */
  ref: string;
  quote: string;
}

/** The thread or conversation an exchange belongs to, as tasks record it. */
function sameWhere(u: WorkUnit) {
  const c = u.conversation;
  if (!c) return null;
  if (u.source === "slack") return and(eq(tasksTable.source, "slack"), like(tasksTable.sourceRef, `slack:${c.id}:%`));
  if (u.source === "email") return and(eq(tasksTable.source, "email"), like(tasksTable.sourceUrl, `%#all/${c.id}`));
  return null;
}

const COLS = {
  id: tasksTable.id,
  kind: tasksTable.kind,
  status: tasksTable.status,
  title: tasksTable.title,
  personId: tasksTable.personId,
  waitingOnPersonId: tasksTable.waitingOnPersonId,
  capturedAt: tasksTable.capturedAt,
  createdAt: tasksTable.createdAt,
};
type Row = { id: number; kind: string; status: string; title: string; personId: number | null; waitingOnPersonId: number | null; capturedAt: Date | null; createdAt: Date };

/**
 * The open tasks each exchange could show progress on. `personIds[i]` are the known people in
 * exchange i (Ollie left out). Only tasks AI may see are offered.
 */
export async function openItemsFor(units: WorkUnit[], personIds: number[][]): Promise<OpenItem[][]> {
  const out: OpenItem[][] = [];
  for (const [i, u] of units.entries()) {
    const same = sameWhere(u);
    const sameRows: Row[] = same
      ? await db.select(COLS).from(tasksTable).where(and(same, inArray(tasksTable.status, OPEN))).orderBy(desc(tasksTable.updatedAt)).limit(10)
      : [];
    let otherRows: Row[] = [];
    if (u.confirmation) {
      otherRows = await db.select(COLS).from(tasksTable).where(inArray(tasksTable.status, OPEN)).orderBy(desc(tasksTable.updatedAt)).limit(CONFIRMATION_ITEMS);
    } else if (personIds[i]?.length) {
      const ids = await withOrganisationPeople(personIds[i]);
      otherRows = await db
        .select(COLS)
        .from(tasksTable)
        .where(and(inArray(tasksTable.status, OPEN), or(inArray(tasksTable.personId, ids), inArray(tasksTable.waitingOnPersonId, ids))))
        .orderBy(desc(tasksTable.updatedAt))
        .limit(PEOPLE_ITEMS + sameRows.length);
    }
    const sameIds = new Set(sameRows.map((r) => r.id));
    const rows = [...sameRows.map((r) => ({ r, same: true })), ...otherRows.filter((r) => !sameIds.has(r.id)).slice(0, u.confirmation ? CONFIRMATION_ITEMS : PEOPLE_ITEMS).map((r) => ({ r, same: false }))];
    // Section 25: tasks about the same work from another channel, whoever they are with.
    if (!u.confirmation) {
      const text = [u.subject ?? "", ...u.messages.map((m) => m.text.slice(0, 1500))].join("\n");
      const similar = await similarOpenTasks(text, { exclude: rows.map(({ r }) => r.id), limit: SIMILAR_ITEMS });
      if (similar.length) {
        const found = await db.select(COLS).from(tasksTable).where(inArray(tasksTable.id, similar));
        const byId = new Map(found.map((r) => [r.id, r]));
        for (const id of similar) if (byId.has(id)) rows.push({ r: byId.get(id)!, same: false });
      }
    }
    if (!rows.length) {
      out.push([]);
      continue;
    }
    const visible = await visibleRefs(defaultScope(), rows.map(({ r }) => toRef("task", r.id)));
    const whoIds = [...new Set(rows.flatMap(({ r }) => [r.personId, r.waitingOnPersonId].filter((x): x is number => x != null)))];
    const names = whoIds.length ? new Map((await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, whoIds))).map((p) => [p.id, p.name])) : new Map<number, string>();
    out.push(
      rows
        .filter(({ r }) => visible.has(toRef("task", r.id)))
        .map(({ r, same }) => ({
          ref: toRef("task", r.id),
          taskId: r.id,
          same,
          kind: r.kind,
          status: r.status,
          title: r.title,
          who: names.get((r.status === "waiting" ? r.waitingOnPersonId : r.personId) ?? -1) ?? null,
          since: r.capturedAt ?? r.createdAt,
        })),
    );
  }
  return out;
}

/** The people given, plus everyone at their outside organisations. */
async function withOrganisationPeople(personIds: number[]): Promise<number[]> {
  const orgs = await db
    .select({ id: organisationsTable.id })
    .from(peopleTable)
    .innerJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
    .where(and(inArray(peopleTable.id, personIds), eq(organisationsTable.internal, false)));
  if (!orgs.length) return personIds;
  const colleagues = await db
    .select({ id: peopleTable.id })
    .from(peopleTable)
    .where(and(inArray(peopleTable.organisationId, orgs.map((o) => o.id)), eq(peopleTable.isSelf, false)));
  return [...new Set([...personIds, ...colleagues.map((c) => c.id)])];
}

/** The open items as the AI reads them inside an exchange. */
export function openItemsBlock(items: OpenItem[]): string | null {
  if (!items.length) return null;
  const line = (it: OpenItem) => {
    const what = it.status === "waiting" ? `waiting on ${it.who ?? "someone"}` : it.kind === "promise" ? `promise${it.who ? ` to ${it.who}` : ""}` : `task${it.who ? ` for ${it.who}` : ""}`;
    return `[${it.ref}] ${it.same ? "from this conversation" : "from elsewhere"}, ${what}: ${it.title.replace(/\s+/g, " ")}`;
  };
  return `<open_items>\n${items.map(line).join("\n")}\n</open_items>`;
}

/** The rules every reader shares for reporting progress on open items. */
export function progressRules(): string[] {
  return [
    `Open items:`,
    `- Some exchanges list <open_items>: Ollie's open tasks, promises and things he waits on that the exchange might be about. "progress" lists the ones the messages in the exchange show have moved. Most exchanges have none; then it is [].`,
    `- "shows" is "done" only when: a message FROM Ollie says he has done it ("Done", "signed and sent back", "booked", "approved"); or, for a "waiting on" item, the other person has delivered what Ollie waited for ("signed copy attached", "here are the numbers"); or an automatic confirmation email (confirmation="yes") clearly shows that exact thing is complete (the same document and people).`,
    `- "shows" is "progress" for a clear step towards it that does not finish it ("sent the first draft, final tomorrow").`,
    `- Never "done" or "progress" for "will do", "on it", "looking now", questions, plans, thanks, or the message the item was made from. When unsure, leave it out.`,
    `- "item" is the ref in square brackets, copied exactly; only refs from that exchange's <open_items>. "ref" is the ref of the message that shows it; "quote" is its exact sentence, under 300 characters.`,
  ];
}

/** JSON schema for one progress entry. */
export const PROGRESS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["item", "shows", "ref", "quote"],
  properties: { item: { type: "string" }, shows: { type: "string", enum: ["done", "progress"] }, ref: { type: "string" }, quote: { type: "string" } },
} as const;

/** Keeps entries about offered items, with a known message ref. */
export function cleanProgress(raw: unknown, u: WorkUnit, items: OpenItem[]): SortedProgress[] {
  if (!Array.isArray(raw) || !items.length) return [];
  const offered = new Set(items.map((i) => i.ref));
  const refs = new Set(u.messages.map((m) => m.ref));
  const seen = new Set<string>();
  const out: SortedProgress[] = [];
  for (const p of raw as Partial<SortedProgress>[]) {
    const item = String(p?.item ?? "").trim();
    if (!offered.has(item) || seen.has(item) || (p?.shows !== "done" && p?.shows !== "progress")) continue;
    seen.add(item);
    out.push({ item, shows: p.shows, ref: refs.has(String(p.ref)) ? String(p.ref) : u.messages[u.messages.length - 1].ref, quote: String(p.quote ?? "").trim().slice(0, 300) });
  }
  return out;
}

export interface ProgressCounts {
  closed: number;
  looks_done: number;
  progress: number;
}

/** Records the evidence, closing tasks from their own conversation and marking the rest Looks done. */
export async function applyProgress(u: WorkUnit, items: OpenItem[], progress: SortedProgress[], counts: ProgressCounts): Promise<void> {
  for (const p of progress) {
    const it = items.find((i) => i.ref === p.item);
    if (!it) continue;
    const msg = u.messages.find((m) => m.ref === p.ref) ?? u.messages[u.messages.length - 1];
    // Only messages written after the one the task came from count.
    if (msg.at.getTime() <= it.since.getTime()) continue;
    const waiting = it.status === "waiting";
    const closes = p.shows === "done" && it.same && !u.confirmation && (msg.fromMe ? !waiting : waiting);
    try {
      const [made] = await db
        .insert(taskEvidenceTable)
        .values({
          taskId: it.taskId,
          source: u.source,
          sourceRef: msg.ref,
          url: msg.url || null,
          saidBy: msg.fromMe ? "You" : (msg.fromName ?? msg.fromAddress ?? null),
          saidAt: msg.at,
          place: placeOf(u),
          quote: p.quote || msg.text.slice(0, 300),
          shows: p.shows,
          strength: it.same ? "same" : "other",
          applied: closes,
        })
        .onConflictDoNothing()
        .returning();
      if (!made) continue;
      if (closes) {
        const [now] = await db.select({ status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.id, it.taskId));
        if (now && (OPEN as string[]).includes(now.status)) {
          await updateTask(it.taskId, { status: "done" }, "ollieos");
          counts.closed++;
        }
      } else if (p.shows === "done") counts.looks_done++;
      else counts.progress++;
    } catch (err) {
      logger.warn({ err, task: it.taskId }, "Could not record evidence on a task");
    }
  }
}

export function placeOf(u: WorkUnit): string | null {
  if (u.source === "slack") return u.channel ? `Slack, ${u.channel}` : "Slack";
  if (u.source === "email") return u.subject ? `Email: ${u.subject}` : "Email";
  return u.subject ? `Meeting: ${u.subject}` : "Meeting";
}

/* ---------- For Ollie ---------- */

export interface EvidenceView {
  id: number;
  source: string;
  url: string | null;
  saidBy: string | null;
  saidAt: Date;
  place: string | null;
  quote: string;
  shows: string;
  strength: string;
  applied: boolean;
  dismissed: boolean;
}

const view = (e: TaskEvidence): EvidenceView => ({
  id: e.id,
  source: e.source,
  url: e.url,
  saidBy: e.saidBy,
  saidAt: e.saidAt,
  place: e.place,
  quote: e.quote,
  shows: e.shows,
  strength: e.strength,
  applied: e.applied,
  dismissed: !!e.dismissedAt,
});

/** "What OllieOS has seen" on a task, newest first. */
export async function listEvidence(taskId: number): Promise<EvidenceView[]> {
  const rows = await db.select().from(taskEvidenceTable).where(eq(taskEvidenceTable.taskId, taskId)).orderBy(desc(taskEvidenceTable.saidAt));
  return rows.map(view);
}

/** "Not done" on a Looks done marker: that evidence no longer marks the task. */
export async function dismissEvidence(taskId: number, evidenceId: number): Promise<EvidenceView[]> {
  const r = await db
    .update(taskEvidenceTable)
    .set({ dismissedAt: new Date() })
    .where(and(eq(taskEvidenceTable.id, evidenceId), eq(taskEvidenceTable.taskId, taskId)))
    .returning({ id: taskEvidenceTable.id });
  if (!r.length) throw new NotFoundError("That evidence is not on this task");
  return listEvidence(taskId);
}

/** One line for each open task that looks done: who said it and where. */
export async function looksDoneFor(taskIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!taskIds.length) return out;
  const rows = await db
    .select()
    .from(taskEvidenceTable)
    .where(and(inArray(taskEvidenceTable.taskId, taskIds), eq(taskEvidenceTable.shows, "done"), eq(taskEvidenceTable.applied, false), isNull(taskEvidenceTable.dismissedAt)))
    .orderBy(desc(taskEvidenceTable.saidAt));
  for (const e of rows) if (!out.has(e.taskId)) out.set(e.taskId, `${e.saidBy ?? "Someone"}${e.place ? ` (${e.place})` : ""}: ${e.quote}`);
  return out;
}

/** For the digest: how each task closed by evidence was closed, for example "you told Sam on Slack". */
export async function closedByEvidence(taskIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!taskIds.length) return out;
  const rows = await db
    .select({ taskId: taskEvidenceTable.taskId, source: taskEvidenceTable.source, saidBy: taskEvidenceTable.saidBy, who: peopleTable.name })
    .from(taskEvidenceTable)
    .innerJoin(tasksTable, eq(tasksTable.id, taskEvidenceTable.taskId))
    .leftJoin(peopleTable, sql`${peopleTable.id} = coalesce(${tasksTable.personId}, ${tasksTable.waitingOnPersonId})`)
    .where(and(inArray(taskEvidenceTable.taskId, taskIds), eq(taskEvidenceTable.applied, true), notInArray(tasksTable.status, OPEN)));
  const where = (s: string) => (s === "slack" ? "on Slack" : s === "email" ? "by email" : "in a meeting");
  for (const r of rows) {
    const first = r.who?.split(/\s+/)[0] ?? null;
    out.set(r.taskId, r.saidBy === "You" ? `you told ${first ?? "them"} ${where(r.source)}` : `${r.saidBy ?? first ?? "they"} delivered ${where(r.source)}`);
  }
  return out;
}
