/**
 * Look back at Granola (Assist Part C): a one-off read of Ollie's older meeting notes.
 *
 * Ollie chooses how far back to look for decisions and for actions. The run lists the notes in
 * range, then reads them one at a time in the background, saving where it got to after each, so
 * it can be stopped and resumed. Only meetings Ollie was in are used.
 *
 * - Decisions go to the Knowledge Inbox as suggestions from "Granola look back". A decision that
 *   matches no project still goes; Ollie can file it under a project when he approves it, or not.
 * - Actions go to the Review page (review_items), not the Inbox.
 * - Anything OllieOS already has is left out: the same source, or close wording to an existing
 *   decision, suggestion, task or review item. Every note read is remembered, so a rerun over the
 *   same range reads nothing again.
 */
import { and, eq, gte, inArray, like, ne, or, sql } from "drizzle-orm";
import { appSettingsTable, db, decisionsTable, reviewItemsTable, suggestionsTable, tasksTable } from "@workspace/db";
import { todayLondon } from "@workspace/shared";
import { logger } from "../../lib/logger";
import { closeMatch, wordsOf } from "../similar";
import { LOOK_BACK_PROPOSER, propose, type DecisionPayload } from "../suggestions";
import { ValidationError } from "../tasks";
import { loadPeople, projectChoices } from "./capture";
import { meetingUnit, sortMeeting, toMeetingNote, wasInMeeting, type GranolaNote, type MeetingNote, type SortedMeeting } from "./granola";
import { ConnectorError, proxyJson, proxyJsonOrNull } from "./http";

const CONNECTOR = "granola";
const NAME = "Granola";
const STATE_KEY = "granola_look_back";
/** Every note a look back has read, so a rerun skips it */
const SEEN_KEY = "granola_look_back_seen";
/** A run that has not saved for this long is not running any more (the server restarted) */
const STALE_MS = 3 * 60_000;
/** Stop the run when this many notes in a row could not be sorted */
const MAX_FAILS_IN_A_ROW = 5;

export const DECISION_RANGES = [30, 91, 183, 365] as const;
export const ACTION_RANGES = [0, 14, 30, 61] as const;
export const DEFAULT_DECISIONS_DAYS = 183;
export const DEFAULT_ACTIONS_DAYS = 30;

export interface LookBackCounts {
  /** Notes in range */
  listed: number;
  /** Notes an earlier look back already read */
  already: number;
  /** Meetings Ollie was in, read */
  meetings: number;
  /** Notes from meetings he was not in */
  left_out: number;
  decisions: number;
  actions: number;
  /** Decisions and actions OllieOS already had */
  duplicates: number;
  /** Notes that could not be read or sorted; a rerun tries them again */
  failed: number;
}

interface Saved {
  status: "running" | "stopped" | "done" | "failed";
  decisionsDays: number;
  actionsDays: number;
  decisionsFrom: string;
  actionsFrom: string;
  startedAt: string;
  finishedAt: string | null;
  /** Last save while running */
  heartbeat: string;
  listed: boolean;
  cursor: string | null;
  /** Note ids still to read, newest first, and how far through */
  queue: string[];
  position: number;
  counts: LookBackCounts;
  error: string | null;
}

export type LookBackStatus = "idle" | "running" | "stopped" | "done" | "failed";

export interface LookBackView {
  status: LookBackStatus;
  /** True while the notes in range are still being listed */
  listing: boolean;
  decisionsDays: number;
  actionsDays: number;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  counts: LookBackCounts;
  error: string | null;
  /** Actions waiting on the Review page */
  reviewPending: number;
}

const emptyCounts = (): LookBackCounts => ({ listed: 0, already: 0, meetings: 0, left_out: 0, decisions: 0, actions: 0, duplicates: 0, failed: 0 });

/* ---------- Saved state ---------- */

async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return (row?.value as T | undefined) ?? null;
}

async function putSetting(key: string, value: unknown) {
  await db
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

const save = (s: Saved) => putSetting(STATE_KEY, s);

/* ---------- The run in this server ---------- */

let active: { stop: boolean; done: Promise<void> } | null = null;

/** Resolves when the run in this server has finished or stopped. For tests. */
export async function waitForLookBack(): Promise<void> {
  await active?.done;
}

async function pendingReviewCount(): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewItemsTable)
    .where(and(eq(reviewItemsTable.kind, "action"), eq(reviewItemsTable.state, "pending")));
  return r?.n ?? 0;
}

export async function getLookBack(now = new Date()): Promise<LookBackView> {
  const s = await getSetting<Saved>(STATE_KEY);
  const reviewPending = await pendingReviewCount();
  if (!s) {
    return {
      status: "idle",
      listing: false,
      decisionsDays: DEFAULT_DECISIONS_DAYS,
      actionsDays: DEFAULT_ACTIONS_DAYS,
      startedAt: null,
      finishedAt: null,
      total: 0,
      done: 0,
      counts: emptyCounts(),
      error: null,
      reviewPending,
    };
  }
  let status: LookBackStatus = s.status;
  let error = s.error;
  // Saved as running but not running here and not saved lately: the server restarted mid-run.
  if (status === "running" && !active && now.getTime() - new Date(s.heartbeat).getTime() > STALE_MS) {
    status = "stopped";
    error = "The look back stopped when OllieOS restarted. Resume to carry on from where it got to.";
  }
  return {
    status,
    listing: status === "running" && !s.listed,
    decisionsDays: s.decisionsDays,
    actionsDays: s.actionsDays,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    total: s.queue.length,
    done: s.position,
    counts: s.counts,
    error,
    reviewPending,
  };
}

function busy(): never {
  throw new ValidationError("A look back is already running.");
}

export async function startLookBack(input: { decisionsDays: number; actionsDays: number }, now = new Date()): Promise<LookBackView> {
  if (active) busy();
  if (!(DECISION_RANGES as readonly number[]).includes(input.decisionsDays)) throw new ValidationError("Choose 1, 3, 6 or 12 months for decisions.");
  if (!(ACTION_RANGES as readonly number[]).includes(input.actionsDays)) throw new ValidationError("Choose none, 2 weeks, 1 month or 2 months for actions.");
  const from = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const s: Saved = {
    status: "running",
    decisionsDays: input.decisionsDays,
    actionsDays: input.actionsDays,
    decisionsFrom: from(input.decisionsDays),
    actionsFrom: from(input.actionsDays),
    startedAt: now.toISOString(),
    finishedAt: null,
    heartbeat: now.toISOString(),
    listed: false,
    cursor: null,
    queue: [],
    position: 0,
    counts: emptyCounts(),
    error: null,
  };
  await save(s);
  launch(s);
  return getLookBack(now);
}

export async function resumeLookBack(now = new Date()): Promise<LookBackView> {
  if (active) busy();
  const s = await getSetting<Saved>(STATE_KEY);
  if (!s || s.status === "done") throw new ValidationError("There is no look back to resume. Start a new one.");
  s.status = "running";
  s.error = null;
  s.finishedAt = null;
  s.heartbeat = now.toISOString();
  await save(s);
  launch(s);
  return getLookBack(now);
}

export async function stopLookBack(now = new Date()): Promise<LookBackView> {
  if (active) {
    active.stop = true;
    await active.done;
  } else {
    const s = await getSetting<Saved>(STATE_KEY);
    if (s && s.status === "running") {
      s.status = "stopped";
      await save(s);
    }
  }
  return getLookBack(now);
}

function launch(s: Saved) {
  const handle = { stop: false, done: Promise.resolve() };
  handle.done = work(s, handle)
    .catch((err) => logger.error({ err }, "Look back failed"))
    .finally(() => {
      if (active === handle) active = null;
    });
  active = handle;
}

async function work(s: Saved, handle: { stop: boolean }) {
  const { myAddresses } = await import("./index");
  try {
    const me = await myAddresses();
    if (!me.size) throw new ConnectorError("OllieOS does not know your email address yet. Check Google Calendar first.");
    const seen = (await getSetting<Record<string, string>>(SEEN_KEY)) ?? {};

    while (!s.listed) {
      if (handle.stop) return await halt(s);
      const q = new URLSearchParams({ created_after: s.decisionsFrom, page_size: "30" });
      if (s.cursor) q.set("cursor", s.cursor);
      const j = await proxyJson(CONNECTOR, NAME, `/v1/notes?${q}`);
      const notes = (j.notes as { id: string }[] | undefined) ?? [];
      for (const n of notes) {
        if (s.queue.includes(n.id)) continue;
        s.counts.listed++;
        if (seen[n.id]) s.counts.already++;
        else s.queue.push(n.id);
      }
      s.cursor = typeof j.cursor === "string" ? j.cursor : null;
      s.listed = j.hasMore !== true || !s.cursor;
      await beat(s);
    }

    const ctx = await loadContext();
    let failsInARow = 0;
    while (s.position < s.queue.length) {
      if (handle.stop) return await halt(s);
      const id = s.queue[s.position];
      const ok = await readOne(id, s, ctx, me);
      if (ok) {
        seen[id] = new Date().toISOString();
        await putSetting(SEEN_KEY, seen);
        failsInARow = 0;
      } else if (++failsInARow >= MAX_FAILS_IN_A_ROW) {
        throw new ConnectorError("Several meetings in a row could not be read. Try resuming in a few minutes.");
      }
      s.position++;
      await beat(s);
    }
    s.status = "done";
    s.finishedAt = new Date().toISOString();
    await save(s);
  } catch (err) {
    if (!(err instanceof ConnectorError)) logger.error({ err }, "Look back stopped on an error");
    s.status = "failed";
    s.error = err instanceof ConnectorError ? err.message : "Something went wrong reading Granola. Resume to try again.";
    await save(s);
  }
}

async function halt(s: Saved) {
  s.status = "stopped";
  await save(s);
}

async function beat(s: Saved) {
  s.heartbeat = new Date().toISOString();
  await save(s);
}

/* ---------- Reading one note ---------- */

interface Known {
  words: Set<string>;
}

interface Context {
  choices: { id: number; name: string }[];
  projectByName: Map<string, number>;
  decisions: Known[];
  actions: Known[];
}

/** What OllieOS already has, for the close-wording check. */
async function loadContext(): Promise<Context> {
  const choices = await projectChoices();
  const since = new Date(Date.now() - 400 * 86_400_000);
  const [decisions, decisionSuggestions, tasks, items] = await Promise.all([
    db.select({ text: decisionsTable.text }).from(decisionsTable),
    db.select({ payload: suggestionsTable.payload }).from(suggestionsTable).where(eq(suggestionsTable.kind, "decision")),
    db
      .select({ title: tasksTable.title })
      .from(tasksTable)
      .where(and(ne(tasksTable.status, "noise"), gte(tasksTable.createdAt, since))),
    db.select({ text: reviewItemsTable.text }).from(reviewItemsTable),
  ]);
  return {
    choices,
    projectByName: new Map(choices.map((p) => [p.name.toLowerCase(), p.id])),
    decisions: [...decisions.map((d) => d.text), ...decisionSuggestions.map((d) => (d.payload as DecisionPayload).text ?? "")].map((t) => ({ words: wordsOf(t) })),
    actions: [...tasks.map((t) => t.title), ...items.map((i) => i.text)].map((t) => ({ words: wordsOf(t) })),
  };
}

const already = (list: Known[], text: string) => {
  const w = wordsOf(text);
  return list.some((k) => closeMatch(k.words, w));
};

/** Reads and sorts one note. False when it could not be sorted, so a later run tries it again. */
async function readOne(id: string, s: Saved, ctx: Context, me: Set<string>): Promise<boolean> {
  const raw = (await proxyJsonOrNull(CONNECTOR, NAME, `/v1/notes/${encodeURIComponent(id)}`)) as GranolaNote | null;
  if (!raw) return true;
  if (!wasInMeeting(raw, me)) {
    s.counts.left_out++;
    return true;
  }
  const note = toMeetingNote(raw, me);
  const wantActions = s.actionsDays > 0 && note.at.getTime() >= new Date(s.actionsFrom).getTime();
  let sorted: SortedMeeting;
  try {
    sorted = await sortMeeting(note, { me: `His email address is ${[...me][0]}.`, projects: ctx.choices.map((p) => p.name), now: note.at });
  } catch (err) {
    logger.warn({ err, note: id }, "Look back could not sort a meeting");
    s.counts.failed++;
    return false;
  }
  s.counts.meetings++;
  await addDecisions(note, sorted, s, ctx);
  if (wantActions) await addActions(note, sorted, s, ctx);
  return true;
}

async function addDecisions(n: MeetingNote, sorted: SortedMeeting, s: Saved, ctx: Context) {
  for (const d of sorted.decisions) {
    if (already(ctx.decisions, d.text)) {
      s.counts.duplicates++;
      continue;
    }
    const projectId = ctx.projectByName.get(d.project.toLowerCase()) ?? ctx.projectByName.get(sorted.project.toLowerCase().trim()) ?? null;
    const r = await propose(
      { proposedBy: LOOK_BACK_PROPOSER, clientId: null, sourceType: "meeting", sourceRef: `granola:${n.noteId}`, sourceUrl: n.url, sourceLabel: `Granola: ${n.title}`, saidBy: { at: n.at } },
      {
        kind: "decision",
        entityType: projectId == null ? null : "project",
        entityId: projectId,
        payload: {
          text: d.text,
          decided_at: todayLondon(n.at),
          decided_by: null,
          source: `Granola: ${n.title}`,
          confidential: d.confidential ? true : null,
          project_hint: projectId == null ? d.topic || null : null,
        },
      },
    );
    ctx.decisions.push({ words: wordsOf(d.text) });
    if (r.status === "suggested" || r.status === "conflict") s.counts.decisions++;
    else s.counts.duplicates++;
  }
}

async function addActions(n: MeetingNote, sorted: SortedMeeting, s: Saved, ctx: Context) {
  if (!sorted.items.length) return;
  const base = `granola:${n.noteId}`;
  // The regular Granola check already put this meeting's actions in the Inbox.
  const [captured] = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(and(eq(tasksTable.source, "meeting"), or(eq(tasksTable.sourceRef, base), like(tasksTable.sourceRef, `${base}#%`))))
    .limit(1);
  if (captured) {
    s.counts.duplicates += sorted.items.length;
    return;
  }
  const people = await loadPeople([meetingUnit(n)], [sorted]);
  const refs = sorted.items.map((_, i) => (i === 0 ? base : `${base}#${i + 1}`));
  const taken = new Set(
    (await db.select({ ref: reviewItemsTable.sourceRef }).from(reviewItemsTable).where(inArray(reviewItemsTable.sourceRef, refs))).map((r) => r.ref),
  );
  for (const [i, it] of sorted.items.entries()) {
    const ref = refs[i];
    if (taken.has(ref) || already(ctx.actions, it.title)) {
      s.counts.duplicates++;
      continue;
    }
    const hint = it.person.toLowerCase().trim();
    const person = hint ? ((hint.includes("@") ? people.byEmail.get(hint) : people.byName.get(hint)) ?? null) : null;
    const personName = person?.name ?? (it.person.trim() || null);
    const owner = it.type === "waiting" ? (personName ?? "Someone else") : "You";
    const inserted = await db
      .insert(reviewItemsTable)
      .values({
        kind: "action",
        sourceRef: ref,
        sourceUrl: n.url,
        meetingTitle: n.title,
        meetingAt: n.at,
        text: it.title,
        action: it.action || null,
        quote: it.quote || null,
        suggestedType: it.type,
        owner,
        personId: person?.id ?? null,
        projectId: ctx.projectByName.get(it.project.toLowerCase().trim()) ?? ctx.projectByName.get(sorted.project.toLowerCase().trim()) ?? null,
        dueDate: it.due || null,
        priority: it.priority,
        confidential: it.confidential || person?.confidential ? true : null,
      })
      .onConflictDoNothing()
      .returning({ id: reviewItemsTable.id });
    ctx.actions.push({ words: wordsOf(it.title) });
    if (inserted.length) s.counts.actions++;
    else s.counts.duplicates++;
  }
}
