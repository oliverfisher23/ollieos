/**
 * One task across channels (build plan section 25).
 *
 * The same piece of work can come in from a meeting, an email follow-up, a Slack message and a
 * Cowork session. Three things stop it becoming four tasks:
 *
 * 1. The Gmail, Slack and Granola readers are offered open tasks whose title words appear in the
 *    exchange (as well as tasks with the same people). An item the reader says is the same as one
 *    of them is added to that task as "Also came up" instead of becoming a new task.
 * 2. Cowork sessions and Claude's create_task check open task titles first. A close match is linked
 *    (sessions) or returned for Claude to decide (create_task).
 * 3. For tasks already doubled up: pairs of open tasks with similar titles are confirmed by the
 *    duplicate judge and shown on the Duplicates page, where Ollie merges them or says they are not
 *    the same.
 *
 * Matching uses Postgres's English stemming (to_tsvector), leaving out words common to most tasks
 * ("send", "check", "follow up"), so nothing extra is sent to a model to find candidates.
 */
import { and, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { appSettingsTable, captureLogTable, db, peopleTable, taskDuplicatesTable, taskEvidenceTable, tasksTable, type Task as TaskRow } from "@workspace/db";
import { OPEN_STATUSES, PRIORITIES, toRef, type Priority, type TaskStatus } from "@workspace/shared";
import { defaultScope, visibleRefs } from "../lib/ai-data/scope";
import { logger } from "../lib/logger";
import { judgeDuplicates, type DuplicateCandidate, type DuplicateSide } from "./duplicateJudge";
import { NotFoundError, ValidationError, getTask, updateTask } from "./tasks";
import type { TaskView } from "./taskView";

const OPEN = [...OPEN_STATUSES] as TaskStatus[];

/** Stems so common in task titles that sharing them says nothing. */
const GENERIC = new Set([
  "send", "check", "review", "follow", "updat", "call", "email", "meet", "share", "book", "ask", "repli", "get", "make", "set",
  "add", "confirm", "draft", "chase", "sort", "look", "take", "need", "work", "new", "next", "week", "today", "tomorrow", "back",
  "find", "write", "read", "talk", "discuss", "prepar", "plan", "give", "let", "know", "can", "will", "also", "via", "re", "fwd",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "ollie", "oliv", "fisher", "springpod", "pleas", "thank",
  "task", "item", "note", "messag", "slack", "chat", "quick", "time",
]);

const meaningful = (lex: readonly string[]) => [...new Set(lex.filter((l) => l.length > 1 && !GENERIC.has(l) && !/^\d+$/.test(l)))];

/** The stemmed words of each text, in order, through Postgres's English dictionary. */
export async function lexemesOf(texts: readonly string[]): Promise<string[][]> {
  if (!texts.length) return [];
  const res = await db.execute(
    sql`select x.i, coalesce(tsvector_to_array(to_tsvector('english', x.t)), '{}') as lex from jsonb_array_elements_text(${JSON.stringify(texts.map((t) => t.slice(0, 20_000)))}::jsonb) with ordinality as x(t, i) order by x.i`,
  );
  return (res.rows as { lex: string[] }[]).map((r) => meaningful(r.lex ?? []));
}

export interface TitleMatch {
  shared: number;
  /** Shared words over all words in either */
  jaccard: number;
  /** Shared words over the words in the shorter */
  containment: number;
  shorter: number;
}

export function titleMatch(a: readonly string[], b: readonly string[]): TitleMatch {
  const A = new Set(a);
  const B = new Set(b);
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  const union = A.size + B.size - shared;
  const shorter = Math.min(A.size, B.size);
  return { shared, jaccard: union ? shared / union : 0, containment: shorter ? shared / shorter : 0, shorter };
}

/** Close enough to treat as the same task without asking a model. */
export const isStrongMatch = (m: TitleMatch) => m.shared >= 2 && (m.jaccard >= 0.5 || (m.containment >= 0.75 && m.shorter >= 3));
/** Worth asking the duplicate judge about. */
export const isCandidateMatch = (m: TitleMatch) => m.shared >= 2 && (m.jaccard >= 0.3 || m.containment >= 0.6);

interface OpenTitle {
  id: number;
  title: string;
  lex: string[];
}

/** Open tasks sharing at least one meaningful word with `lex`, with their own words. */
async function openTitlesSharing(lex: string[], exclude: number[] = []): Promise<OpenTitle[]> {
  if (!lex.length) return [];
  const rows = await db
    .select({ id: tasksTable.id, title: tasksTable.title, lex: sql<string[]>`tsvector_to_array(to_tsvector('english', ${tasksTable.title}))` })
    .from(tasksTable)
    .where(
      and(
        inArray(tasksTable.status, OPEN),
        sql`tsvector_to_array(to_tsvector('english', ${tasksTable.title})) && array(select jsonb_array_elements_text(${JSON.stringify(lex)}::jsonb))`,
        exclude.length ? notInArray(tasksTable.id, exclude) : undefined,
      ),
    )
    .orderBy(desc(tasksTable.updatedAt))
    .limit(200);
  return rows.map((r) => ({ id: r.id, title: r.title, lex: meaningful(r.lex ?? []) }));
}

/**
 * For the readers: open tasks whose title words mostly appear in the exchange, best first. Most of
 * a task's own words must be there, so a long meeting note does not match everything.
 */
export async function similarOpenTasks(text: string, opts: { exclude?: number[]; limit: number }): Promise<number[]> {
  const [lex] = await lexemesOf([text]);
  const words = new Set(lex);
  const hits = (await openTitlesSharing(lex ?? [], opts.exclude))
    .map((t) => {
      const shared = t.lex.filter((w) => words.has(w)).length;
      return { id: t.id, shared, cover: t.lex.length ? shared / t.lex.length : 0 };
    })
    .filter((h) => h.shared >= 2 && h.cover >= 0.5)
    .sort((a, b) => b.shared - a.shared || b.cover - a.cover);
  return hits.slice(0, opts.limit).map((h) => h.id);
}

/** For Cowork and Claude: open tasks whose title is close to this one, closest first. */
export async function closeOpenTasks(title: string, limit = 3): Promise<{ id: number; title: string; match: TitleMatch }[]> {
  const [lex] = await lexemesOf([title]);
  return (await openTitlesSharing(lex ?? []))
    .map((t) => ({ id: t.id, title: t.title, match: titleMatch(lex ?? [], t.lex) }))
    .filter((t) => isStrongMatch(t.match))
    .sort((a, b) => b.match.jaccard - a.match.jaccard || b.match.shared - a.match.shared)
    .slice(0, limit);
}

/* ---------- Also came up ---------- */

export interface Mention {
  /** slack, email, meeting, session, manual... */
  source: string;
  /** The capture ref of what it came from, so it is only added once */
  sourceRef: string;
  url: string | null;
  saidBy: string | null;
  saidAt: Date;
  place: string | null;
  quote: string;
  /** same: from the task's own conversation; other: anywhere else */
  strength: "same" | "other";
}

/**
 * Adds "Also came up" to an existing task instead of making a new one. The source ref is logged as
 * captured against that task, so the same message never makes a task later either. False when the
 * ref was already captured (as a task or a mention).
 */
export async function recordMention(taskId: number, m: Mention): Promise<boolean> {
  const source = (["email", "slack", "meeting", "quarterly", "manual", "session", "voice"] as const).find((s) => s === m.source) ?? "manual";
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .insert(captureLogTable)
      .values({ source, sourceRef: m.sourceRef, outcome: "duplicate", taskId, capturedAt: m.saidAt })
      .onConflictDoNothing()
      .returning({ id: captureLogTable.id });
    if (!claimed) return false;
    await tx
      .insert(taskEvidenceTable)
      .values({
        taskId,
        source: m.source,
        sourceRef: m.sourceRef,
        url: m.url,
        saidBy: m.saidBy,
        saidAt: m.saidAt,
        place: m.place,
        quote: m.quote.slice(0, 300),
        shows: "same",
        strength: m.strength,
      })
      .onConflictDoNothing();
    return true;
  });
}

/** True when this source and ref already made a task or a mention. */
export async function alreadyCaptured(source: string, sourceRef: string | null | undefined): Promise<boolean> {
  if (!sourceRef?.trim()) return false;
  const [hit] = await db
    .select({ id: captureLogTable.id })
    .from(captureLogTable)
    .where(and(sql`${captureLogTable.source}::text = ${source}`, eq(captureLogTable.sourceRef, sourceRef.trim())))
    .limit(1);
  return !!hit;
}

/* ---------- Possible duplicates ---------- */

const CHECK_KEY = "duplicates_last";
const DAY = 86_400_000;
/** Pairs sent to the judge in one check */
const MAX_PAIRS = 20;
/** Open tasks compared in one check, most recently touched first */
const MAX_TASKS = 500;

export interface DuplicatePairView {
  id: number;
  reason: string | null;
  a: TaskView;
  b: TaskView;
}

const SOURCE_WORDS: Record<string, string> = { email: "email", slack: "Slack", meeting: "a meeting", session: "a Cowork session", manual: "added by hand", quarterly: "quarterly planning", voice: "a voice note" };

async function sideOf(t: TaskRow, names: Map<number, string>): Promise<DuplicateSide> {
  const who = t.status === "waiting" ? t.waitingOnPersonId : t.personId;
  return {
    title: t.title,
    source: SOURCE_WORDS[t.source] ?? t.source,
    status: t.status === "waiting" ? "waiting on" : t.status,
    who: (who != null ? names.get(who) : null) ?? t.fromName ?? null,
    where: t.sourceSubject ?? t.sourceChannel ?? null,
    quote: (t.sourceQuote ?? t.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || null,
    due: t.dueDate,
  };
}

/**
 * Finds pairs of open tasks that are probably the same work: similar titles first (no AI), then the
 * duplicate judge on up to 20 new pairs. Only tasks AI may see are compared. Each pair is judged
 * once; pairs it says are the same wait on the Duplicates page.
 */
export async function findDuplicates(): Promise<{ checked: number; found: number }> {
  const rows = await db
    .select({ id: tasksTable.id, title: tasksTable.title })
    .from(tasksTable)
    .where(inArray(tasksTable.status, OPEN))
    .orderBy(desc(tasksTable.updatedAt))
    .limit(MAX_TASKS);
  const visible = await visibleRefs(defaultScope(), rows.map((r) => toRef("task", r.id)));
  const tasks = rows.filter((r) => visible.has(toRef("task", r.id)));
  if (tasks.length < 2) return { checked: 0, found: 0 };
  const lex = await lexemesOf(tasks.map((t) => t.title));

  const known = new Set(
    (await db.select({ a: taskDuplicatesTable.taskA, b: taskDuplicatesTable.taskB }).from(taskDuplicatesTable).where(inArray(taskDuplicatesTable.taskA, tasks.map((t) => t.id)))).map(
      (p) => `${p.a}:${p.b}`,
    ),
  );
  const candidates: { a: number; b: number; score: number }[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const m = titleMatch(lex[i], lex[j]);
      if (!isCandidateMatch(m)) continue;
      const [a, b] = tasks[i].id < tasks[j].id ? [tasks[i].id, tasks[j].id] : [tasks[j].id, tasks[i].id];
      if (known.has(`${a}:${b}`)) continue;
      candidates.push({ a, b, score: m.jaccard + m.containment / 2 });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  const pick = candidates.slice(0, MAX_PAIRS);
  if (!pick.length) return { checked: 0, found: 0 };

  const ids = [...new Set(pick.flatMap((p) => [p.a, p.b]))];
  const full = new Map((await db.select().from(tasksTable).where(inArray(tasksTable.id, ids))).map((t) => [t.id, t]));
  const personIds = [...new Set([...full.values()].flatMap((t) => [t.personId, t.waitingOnPersonId]).filter((x): x is number => x != null))];
  const names = personIds.length ? new Map((await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, personIds))).map((p) => [p.id, p.name])) : new Map<number, string>();
  const asked: DuplicateCandidate[] = [];
  for (const [n, p] of pick.entries()) asked.push({ pair: n + 1, a: await sideOf(full.get(p.a)!, names), b: await sideOf(full.get(p.b)!, names) });

  const verdicts = new Map((await judgeDuplicates(asked)).map((v) => [v.pair, v]));
  let found = 0;
  for (const [n, p] of pick.entries()) {
    const v = verdicts.get(n + 1);
    if (!v) continue;
    const [row] = await db
      .insert(taskDuplicatesTable)
      .values({ taskA: p.a, taskB: p.b, state: v.same ? "suggested" : "not_same", reason: v.same ? v.reason || null : null })
      .onConflictDoNothing()
      .returning({ id: taskDuplicatesTable.id });
    if (row && v.same) found++;
  }
  return { checked: pick.length, found };
}

/** Once a day, after the scheduled checks. */
export async function findDuplicatesIfDue(now = new Date()): Promise<{ ran: boolean; checked: number; found: number }> {
  const [last] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, CHECK_KEY));
  const at = (last?.value as { at?: string } | undefined)?.at;
  if (at && now.getTime() - Date.parse(at) < DAY - 3_600_000) return { ran: false, checked: 0, found: 0 };
  const r = await findDuplicates();
  const value = { at: now.toISOString(), ...r };
  await db.insert(appSettingsTable).values({ key: CHECK_KEY, value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  return { ran: true, ...r };
}

/** Pairs waiting for Ollie where both tasks are still open, newest first. */
export async function listDuplicates(): Promise<DuplicatePairView[]> {
  const rows = await db
    .select({ id: taskDuplicatesTable.id, reason: taskDuplicatesTable.reason, a: taskDuplicatesTable.taskA, b: taskDuplicatesTable.taskB })
    .from(taskDuplicatesTable)
    .innerJoin(tasksTable, or(eq(tasksTable.id, taskDuplicatesTable.taskA), eq(tasksTable.id, taskDuplicatesTable.taskB)))
    .where(and(eq(taskDuplicatesTable.state, "suggested"), inArray(tasksTable.status, OPEN)))
    .groupBy(taskDuplicatesTable.id)
    .having(sql`count(*) = 2`)
    .orderBy(desc(taskDuplicatesTable.createdAt))
    .limit(50);
  const out: DuplicatePairView[] = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, reason: r.reason, a: await getTask(r.a), b: await getTask(r.b) });
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
  }
  return out;
}

async function loadPair(id: number) {
  const [p] = await db.select().from(taskDuplicatesTable).where(eq(taskDuplicatesTable.id, id));
  if (!p) throw new NotFoundError("Those tasks are not on the Duplicates list");
  return p;
}

/** "Not the same": the pair is never suggested again. */
export async function dismissDuplicate(id: number): Promise<void> {
  const p = await loadPair(id);
  if (p.state !== "suggested") return;
  await db.update(taskDuplicatesTable).set({ state: "dismissed", decidedAt: new Date() }).where(eq(taskDuplicatesTable.id, id));
}

const higher = (a: Priority, b: Priority): Priority => (PRIORITIES.indexOf(a) <= PRIORITIES.indexOf(b) ? a : b);
const placeOfTask = (t: TaskRow) => {
  const what = { email: "Email", slack: "Slack", meeting: "Meeting", session: "Cowork session", manual: "Added by hand", quarterly: "Quarterly", voice: "Voice note" }[t.source] ?? t.source;
  const where = t.sourceSubject ?? t.sourceChannel;
  return where ? `${what}: ${where}` : what;
};

/**
 * Merges a pair into the task Ollie keeps. The other task is dropped with a note, and where it came
 * from shows on the kept task as "Also came up", with anything OllieOS had seen on it. The kept task
 * takes the sooner due date, the higher priority, a person and project when it has none, and the
 * other's notes. Restore on the dropped task brings it back.
 */
export async function mergeDuplicate(id: number, keepId: number, actor: string): Promise<TaskView> {
  const p = await loadPair(id);
  if (p.state !== "suggested") throw new ValidationError("Those tasks were already merged or kept apart");
  if (keepId !== p.taskA && keepId !== p.taskB) throw new ValidationError("Keep one of the two tasks");
  const dropId = keepId === p.taskA ? p.taskB : p.taskA;
  const [keep] = await db.select().from(tasksTable).where(eq(tasksTable.id, keepId));
  const [drop] = await db.select().from(tasksTable).where(eq(tasksTable.id, dropId));
  if (!keep || !drop) throw new NotFoundError("One of those tasks no longer exists");
  if (!OPEN.includes(keep.status) || !OPEN.includes(drop.status)) throw new ValidationError("Both tasks need to be open to merge them");

  // Where the dropped task came from, and what OllieOS had seen on it, now show on the kept one.
  await db
    .insert(taskEvidenceTable)
    .values({
      taskId: keepId,
      source: drop.source,
      sourceRef: drop.sourceRef ?? `task:${drop.id}`,
      url: drop.sourceUrl,
      saidBy: drop.fromName,
      saidAt: drop.capturedAt ?? drop.createdAt,
      place: placeOfTask(drop),
      quote: (drop.sourceQuote ?? drop.title).slice(0, 300),
      shows: "same",
      strength: "other",
    })
    .onConflictDoNothing();
  const seen = await db.select().from(taskEvidenceTable).where(eq(taskEvidenceTable.taskId, dropId));
  for (const e of seen) {
    const { id: _id, taskId: _t, createdAt: _c, ...rest } = e;
    await db.insert(taskEvidenceTable).values({ ...rest, taskId: keepId }).onConflictDoNothing();
  }
  // A later capture of anything the dropped task came from lands on the kept task.
  await db.update(captureLogTable).set({ taskId: keepId }).where(eq(captureLogTable.taskId, dropId));

  const due = [keep.dueDate, drop.dueDate].filter((d): d is string => !!d).sort()[0] ?? null;
  const priority = higher(keep.priority, drop.priority);
  const notes = [keep.notes, drop.notes ? `From "${drop.title}":\n${drop.notes}` : null].filter(Boolean).join("\n\n") || null;
  await updateTask(
    keepId,
    {
      ...(due !== keep.dueDate ? { dueDate: due } : {}),
      ...(priority !== keep.priority ? { priority } : {}),
      ...(keep.personId == null && drop.personId != null ? { personId: drop.personId } : {}),
      ...(keep.projectId == null && drop.projectId != null ? { projectId: drop.projectId } : {}),
      ...(notes !== keep.notes ? { notes } : {}),
      ...(!keep.steps.length && drop.steps.length ? { steps: drop.steps } : {}),
    },
    actor,
  );
  await updateTask(dropId, { status: "dropped", notes: [drop.notes, `Merged into "${keep.title}".`].filter(Boolean).join("\n\n") }, actor);
  await db.update(taskDuplicatesTable).set({ state: "merged", keptTaskId: keepId, decidedAt: new Date() }).where(eq(taskDuplicatesTable.id, id));
  logger.info({ kept: keepId, dropped: dropId }, "Merged duplicate tasks");
  return getTask(keepId);
}
