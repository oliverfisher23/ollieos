import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  askThreadsTable,
  db,
  decisionsTable,
  factsTable,
  notesTable,
  peopleTable,
  tasksTable,
  type AskThread,
  type Task as TaskRow,
} from "@workspace/db";
import {
  OPEN_STATUSES,
  SOURCE_LABELS,
  STATUS_LABELS,
  formatDayMonthShort,
  formatShort,
  parseRef,
  toRef,
  type Priority,
  type TaskStatus,
} from "@workspace/shared";
import { loadVisibleDocs, retrieveForAsk, type AiDoc } from "../../lib/ai-data/retrieve";
import { askClient, buildScope, defaultScope, recordReads, visibleRefs, type AiScope } from "../../lib/ai-data/scope";
import type { GrantType } from "../../lib/ai-data/visibility";
import { describeRefs, grantDirect } from "../access";
import { writeAudit } from "../../lib/audit";
import { ConflictError, NotFoundError, UpstreamError, ValidationError, snapshotOf, type LifecycleSnapshot } from "../tasks";
import { toTaskView, type TaskView } from "../taskView";
import { resolveEntities } from "../knowledge/common";
import { ASK_MODEL, answerFromDocs, draftReplyFromDocs, type PriorTurn } from "./model";
import { logger } from "../../lib/logger";

const ACTOR = "ollie";
const OPEN = new Set<TaskStatus>(OPEN_STATUSES);
const PRIOR_TURNS = 4;
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What is stored in ask_threads.answer. Refs only; names are resolved when read, so renames show through. */
interface StoredAnswer {
  status: "answered" | "not_found";
  summary: string;
  items: { text: string; refs: string[] }[];
  related: string[];
  bundleTitle: string | null;
  /** The unfiltered search also matched items AI cannot read */
  hiddenMatches: boolean;
  /** Those hidden items, as refs Ollie can allow for this question. Never shown to the model. */
  hiddenRefs?: string[];
  sourceCount: number;
  retrievedRefs: string[];
  draftTo: { ref: string; name: string } | null;
  draft: { to: string | null; text: string; createdAt: string } | null;
  bundle: {
    taskId: number;
    title: string;
    originals: { id: number; previous: LifecycleSnapshot }[];
    createdAt: string;
    undone: boolean;
  } | null;
}

/* ---------- Views ---------- */

export interface SourceChip {
  ref: string;
  type: string;
  label: string;
  /** App path to open the item */
  path: string | null;
  confidential: boolean;
}

export interface AskItemView {
  text: string;
  sources: SourceChip[];
  badge: { label: string; tone: "high" | "neutral" | "done" } | null;
}

export interface AskTurnView {
  id: number;
  parentId: number | null;
  question: string;
  createdAt: Date;
  model: string | null;
  status: StoredAnswer["status"];
  summary: string;
  items: AskItemView[];
  related: SourceChip[];
  sourceCount: number;
  hiddenMatches: boolean;
  /** Hidden items that matched, named for Ollie so he can allow them for this question */
  hiddenItems: SourceChip[];
  canAllow: boolean;
  usedConfidential: boolean;
  draftTo: string | null;
  draft: { to: string | null; text: string } | null;
  bundleTitle: string | null;
  /** Two or more cited tasks are still open and nothing has been bundled from this answer */
  canBundle: boolean;
  bundle: { task: TaskView | null; title: string; undone: boolean; canUndo: boolean } | null;
}

function entityPath(type: string, slug: string | null, id: number): string | null {
  if (type === "project" && slug) return `/knowledge/projects/${slug}`;
  if (type === "person" && slug) return `/knowledge/people/${slug}`;
  if (type === "organisation" && slug) return `/knowledge/organisations/${slug}`;
  if (type === "decision") return `/knowledge/decisions/${id}`;
  if (type === "note") return `/knowledge/notes/${id}`;
  if (type === "task") return `/tasks?task=${id}`;
  return null;
}

const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Resolves refs to chips and task badges for Ollie. Everything here was visible when the answer was made. */
async function resolveChips(refs: string[]) {
  const parsed = refs.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  const ids = (t: string) => [...new Set(parsed.filter((r) => r.type === t).map((r) => r.id))];
  const [tasks, decisions, notes, facts] = await Promise.all([
    ids("task").length ? db.select().from(tasksTable).where(inArray(tasksTable.id, ids("task"))) : [],
    ids("decision").length ? db.select().from(decisionsTable).where(inArray(decisionsTable.id, ids("decision"))) : [],
    ids("note").length ? db.select().from(notesTable).where(inArray(notesTable.id, ids("note"))) : [],
    ids("fact").length ? db.select().from(factsTable).where(inArray(factsTable.id, ids("fact"))) : [],
  ]);
  const parents = [
    ...parsed.filter((r) => r.type === "project" || r.type === "person" || r.type === "organisation"),
    ...notes.map((n) => ({ type: n.entityType, id: n.entityId })),
    ...facts.map((f) => ({ type: f.entityType, id: f.entityId })),
  ];
  const entities = await resolveEntities(parents);
  const [confidentialEntities] = await Promise.all([
    db.execute(sql`
      select 'project:' || id as ref from projects where confidential
      union all select 'person:' || id from people where confidential
      union all select 'organisation:' || id from organisations where confidential`),
  ]);
  const confidentialSet = new Set((confidentialEntities.rows as { ref: string }[]).map((r) => r.ref));

  const chips = new Map<string, SourceChip>();
  const taskById = new Map<number, TaskRow>(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    const what = t.sourceSubject ?? t.title;
    const label =
      t.source === "manual"
        ? `${t.kind === "promise" ? "Promise" : "Task"} · ${clip(t.title)}`
        : `${SOURCE_LABELS[t.source]} · ${clip(what)} · ${formatDayMonthShort(t.capturedAt ?? t.createdAt)}`;
    chips.set(toRef("task", t.id), { ref: toRef("task", t.id), type: "task", label, path: entityPath("task", null, t.id), confidential: t.confidential === true });
  }
  for (const d of decisions) {
    chips.set(toRef("decision", d.id), {
      ref: toRef("decision", d.id),
      type: "decision",
      label: `Decision · ${formatDayMonthShort(d.decidedAt)}`,
      path: entityPath("decision", null, d.id),
      confidential: d.confidential === true,
    });
  }
  for (const n of notes) {
    const about = entities.get(`${n.entityType}:${n.entityId}`);
    chips.set(toRef("note", n.id), {
      ref: toRef("note", n.id),
      type: "note",
      label: `Note · ${clip(n.title ?? about?.name ?? n.body, 36)}`,
      path: entityPath("note", null, n.id),
      confidential: n.confidential === true,
    });
  }
  for (const f of facts) {
    const about = entities.get(`${f.entityType}:${f.entityId}`);
    chips.set(toRef("fact", f.id), {
      ref: toRef("fact", f.id),
      type: "fact",
      label: `Fact · ${about?.name ?? "Knowledge"}`,
      path: about ? entityPath(about.type, about.slug, about.id) : null,
      confidential: false,
    });
  }
  for (const r of parsed) {
    if (r.type !== "project" && r.type !== "person" && r.type !== "organisation") continue;
    const e = entities.get(`${r.type}:${r.id}`);
    if (!e) continue;
    chips.set(`${r.type}:${r.id}`, { ref: `${r.type}:${r.id}`, type: r.type, label: e.name, path: entityPath(r.type, e.slug, r.id), confidential: confidentialSet.has(`${r.type}:${r.id}`) });
  }
  return { chips, taskById };
}

function badgeFor(refs: string[], taskById: Map<number, TaskRow>): AskItemView["badge"] {
  for (const ref of refs) {
    const r = parseRef(ref);
    if (r?.type !== "task") continue;
    const t = taskById.get(r.id);
    if (!t) continue;
    const kind = t.kind === "promise" ? "Promise" : "Task";
    if (t.status === "done") return { label: `${kind} · done`, tone: "done" };
    if (t.status === "noise") return { label: `${kind} · noise`, tone: "neutral" };
    const tone = t.priority === "high" ? "high" : "neutral";
    if (t.dueDate) return { label: `${kind} · due ${formatShort(t.dueDate).replace(/ \w+$/, "")}`, tone };
    return { label: `${kind} · ${STATUS_LABELS[t.status].toLowerCase()}`, tone };
  }
  return null;
}

function citedTaskIds(answer: StoredAnswer): number[] {
  const ids = new Set<number>();
  for (const i of answer.items) for (const ref of i.refs) {
    const r = parseRef(ref);
    if (r?.type === "task") ids.add(r.id);
  }
  return [...ids];
}

async function toTurnViews(rows: AskThread[]): Promise<AskTurnView[]> {
  const answers = rows.map((r) => r.answer as StoredAnswer);
  const allRefs = answers.flatMap((a) => [...a.items.flatMap((i) => i.refs), ...a.related, ...(a.hiddenRefs ?? [])]);
  const { chips, taskById } = await resolveChips(allRefs);
  const bundleTasks = new Map<number, TaskView>();
  for (const a of answers) {
    if (a.bundle && !a.bundle.undone) {
      const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, a.bundle.taskId));
      if (t) bundleTasks.set(t.id, await toTaskView(t));
    }
  }
  return rows.map((row, idx) => {
    const a = answers[idx];
    const openCited = citedTaskIds(a).filter((id) => {
      const t = taskById.get(id);
      return t && OPEN.has(t.status);
    });
    return {
      id: row.id,
      parentId: row.parentId,
      question: row.question,
      createdAt: row.createdAt,
      model: row.model,
      status: a.status,
      summary: a.summary,
      items: a.items.map((i) => ({
        text: i.text,
        sources: i.refs.map((r) => chips.get(r)).filter((c): c is SourceChip => !!c),
        badge: badgeFor(i.refs, taskById),
      })),
      related: a.related.map((r) => chips.get(r)).filter((c): c is SourceChip => !!c),
      sourceCount: a.sourceCount,
      hiddenMatches: a.hiddenMatches,
      hiddenItems: (a.hiddenRefs ?? [])
        .map((r) => chips.get(r))
        .filter((c): c is SourceChip => !!c)
        .map((c) => ({ ...c, confidential: true })),
      canAllow: (a.hiddenRefs ?? []).length > 0 && !(a.bundle && !a.bundle.undone),
      usedConfidential: row.usedConfidential,
      draftTo: a.draftTo?.name ?? null,
      draft: a.draft ? { to: a.draft.to, text: a.draft.text } : null,
      bundleTitle: a.bundleTitle,
      canBundle: (!a.bundle || a.bundle.undone) && openCited.length >= 2,
      bundle: a.bundle
        ? {
            task: bundleTasks.get(a.bundle.taskId) ?? null,
            title: a.bundle.title,
            undone: a.bundle.undone,
            canUndo: !a.bundle.undone && Date.now() - new Date(a.bundle.createdAt).getTime() < UNDO_WINDOW_MS,
          }
        : null,
    };
  });
}

/* ---------- Threads ---------- */

async function loadRow(id: number): Promise<AskThread> {
  const [row] = await db.select().from(askThreadsTable).where(eq(askThreadsTable.id, id));
  if (!row) throw new NotFoundError("That question does not exist");
  return row;
}

/** The turns before and including this one, oldest first. */
async function ancestors(row: AskThread): Promise<AskThread[]> {
  const chain = [row];
  let cur = row;
  while (cur.parentId && chain.length < 50) {
    const [parent] = await db.select().from(askThreadsTable).where(eq(askThreadsTable.id, cur.parentId));
    if (!parent) break;
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

/** The whole conversation a turn belongs to: up to the first question, then down the latest follow-ups. */
export async function getThread(id: number): Promise<{ turns: AskTurnView[] }> {
  const chain = await ancestors(await loadRow(id));
  let last = chain[chain.length - 1];
  while (chain.length < 50) {
    const [child] = await db
      .select()
      .from(askThreadsTable)
      .where(eq(askThreadsTable.parentId, last.id))
      .orderBy(desc(askThreadsTable.createdAt))
      .limit(1);
    if (!child) break;
    chain.push(child);
    last = child;
  }
  return { turns: await toTurnViews(chain) };
}

export async function listRecentThreads(): Promise<{ id: number; question: string; createdAt: Date }[]> {
  return db
    .select({ id: askThreadsTable.id, question: askThreadsTable.question, createdAt: askThreadsTable.createdAt })
    .from(askThreadsTable)
    .where(isNull(askThreadsTable.parentId))
    .orderBy(desc(askThreadsTable.createdAt))
    .limit(20);
}

const NOT_FOUND_SUMMARY = "OllieOS has nothing on that yet. Try different words, or add it to Knowledge first.";

/** Picks who "Draft a reply" goes to: the first visible person the answer is about. */
async function pickDraftRecipient(scope: AiScope, related: string[], docs: AiDoc[]): Promise<StoredAnswer["draftTo"]> {
  const candidates: number[] = [];
  for (const ref of related) {
    const r = parseRef(ref);
    if (r?.type === "person") candidates.push(r.id);
  }
  if (!candidates.length) {
    for (const d of docs) if (d.type === "person") candidates.push(d.id);
  }
  if (!candidates.length) return null;
  const visible = await visibleRefs(scope, candidates.map((id) => toRef("person", id)));
  const ids = candidates.filter((id) => visible.has(toRef("person", id)));
  const rows = ids.length
    ? await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  const first = candidates.find((id) => byId.has(id));
  return first ? { ref: toRef("person", first), name: byId.get(first)! } : null;
}

/** Retrieves through the filter for this scope and asks the model. Shared by a new question and "Allow for this question". */
async function computeAnswer(scope: AiScope, q: string, prior: PriorTurn[], carry: string[]): Promise<{ answer: StoredAnswer; model: string | null }> {
  const { docs, hiddenMatches, hiddenRefs } = await retrieveForAsk(scope, q, carry);
  if (!docs.length) {
    return {
      model: null,
      answer: {
        status: "not_found",
        summary: NOT_FOUND_SUMMARY,
        items: [],
        related: [],
        bundleTitle: null,
        hiddenMatches,
        hiddenRefs,
        sourceCount: 0,
        retrievedRefs: [],
        draftTo: null,
        draft: null,
        bundle: null,
      },
    };
  }
  let raw;
  try {
    raw = await answerFromDocs(q, docs, prior);
  } catch (err) {
    logger.error({ err }, "Ask OllieOS model call failed");
    throw new UpstreamError("Ask OllieOS could not reach the model just now. Try again in a moment.");
  }
  // Only refs that were actually handed to the model count; anything else is dropped, and an item left without a source goes too.
  const allowed = new Set(docs.map((d) => d.ref));
  const items = raw.items
    .map((i) => ({ text: i.text, refs: [...new Set(i.refs.map((r) => r.trim()))].filter((r) => allowed.has(r)) }))
    .filter((i) => i.text && i.refs.length);
  const related = [...new Set(raw.related.map((r) => r.trim()))].filter((r) => {
    const p = parseRef(r);
    return allowed.has(r) && !!p && (p.type === "person" || p.type === "project" || p.type === "organisation");
  });
  const found = raw.found && items.length > 0;
  const cited = new Set(items.flatMap((i) => i.refs));
  return {
    model: ASK_MODEL,
    answer: {
      status: found ? "answered" : "not_found",
      summary: found ? raw.summary : raw.summary || NOT_FOUND_SUMMARY,
      items: found ? items : [],
      related: found ? related : [],
      bundleTitle: found && raw.bundleTitle ? raw.bundleTitle : null,
      hiddenMatches,
      hiddenRefs,
      sourceCount: cited.size,
      retrievedRefs: docs.map((d) => d.ref),
      draftTo: found ? await pickDraftRecipient(scope, related, docs.filter((d) => cited.has(d.ref) || d.type === "person")) : null,
      draft: null,
      bundle: null,
    },
  };
}

/** True when the answer cites something that AI tools cannot read without an approval. */
async function usesConfidential(answer: StoredAnswer): Promise<boolean> {
  const used = [...new Set([...answer.items.flatMap((i) => i.refs), ...answer.related])];
  if (!used.length) return false;
  const open = await visibleRefs(defaultScope(), used);
  return used.some((r) => !open.has(r));
}

async function priorFor(parentId: number | null | undefined): Promise<{ prior: PriorTurn[]; carry: string[] }> {
  if (!parentId) return { prior: [], carry: [] };
  const chain = (await ancestors(await loadRow(parentId))).slice(-PRIOR_TURNS);
  return {
    prior: chain.map((r) => ({ question: r.question, summary: (r.answer as StoredAnswer).summary })),
    carry: chain[chain.length - 1].citedIds,
  };
}

async function askScope(): Promise<AiScope> {
  return buildScope(await askClient());
}

export async function ask(question: string, parentId?: number | null): Promise<{ id: number; turns: AskTurnView[] }> {
  const q = question.trim();
  if (!q) throw new ValidationError("Ask a question first");

  const { prior, carry } = await priorFor(parentId);
  const scope = await askScope();
  const { answer, model } = await computeAnswer(scope, q, prior, carry);
  const usedConfidential = await usesConfidential(answer);

  const citedIds = [...new Set(answer.items.flatMap((i) => i.refs))];
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(askThreadsTable)
      .values({ parentId: parentId ?? null, question: q, answer, citedIds, usedConfidential, model })
      .returning();
    await writeAudit(tx, {
      actor: ACTOR,
      action: "ask",
      payload: { threadId: created.id, cited: citedIds, retrieved: answer.retrievedRefs.length, hiddenMatches: answer.hiddenMatches, model },
    });
    return created;
  });
  await recordReads(scope, answer.retrievedRefs, { via: "ask", threadId: row.id, question: q });
  return { id: row.id, ...(await getThread(row.id)) };
}

/**
 * "Allow for this question" (build plan question 12): opens the hidden items that matched to
 * Ask OllieOS for one hour, then answers the same question again in place.
 */
export async function allowForTurn(id: number): Promise<{ turns: AskTurnView[] }> {
  const row = await loadRow(id);
  const previous = row.answer as StoredAnswer;
  const refs = previous.hiddenRefs ?? [];
  if (!refs.length) throw new ConflictError("Nothing was held back from this answer");
  if (previous.bundle && !previous.bundle.undone) throw new ConflictError("Undo the bundle before asking again");

  const client = await askClient();
  const labels = await describeRefs(refs);
  const items = refs
    .map((r) => parseRef(r))
    .filter((r): r is NonNullable<typeof r> => !!r && labels.has(`${r.type}:${r.id}`))
    .map((r) => ({ type: r.type as GrantType, id: r.id, name: labels.get(`${r.type}:${r.id}`)!.name }));
  await grantDirect(client, items, `Allowed for the question "${row.question.slice(0, 300)}"`);

  const { prior, carry } = await priorFor(row.parentId);
  const scope = await buildScope(client);
  const { answer, model } = await computeAnswer(scope, row.question, prior, carry);
  const usedConfidential = await usesConfidential(answer);
  const citedIds = [...new Set(answer.items.flatMap((i) => i.refs))];
  await db.transaction(async (tx) => {
    await tx.update(askThreadsTable).set({ answer, citedIds, usedConfidential, model }).where(eq(askThreadsTable.id, id));
    await writeAudit(tx, {
      actor: ACTOR,
      action: "ask",
      payload: { threadId: id, rerun: "allowed", allowed: items.map((i) => `${i.type}:${i.id}`), cited: citedIds, model },
    });
  });
  await recordReads(scope, answer.retrievedRefs, { via: "ask", threadId: id, question: row.question });
  return getThread(id);
}

async function updateAnswer(id: number, answer: StoredAnswer, conn: Pick<typeof db, "update"> = db) {
  await conn.update(askThreadsTable).set({ answer }).where(eq(askThreadsTable.id, id));
}

/* ---------- Draft ---------- */

export async function draftReply(id: number): Promise<{ turns: AskTurnView[] }> {
  const row = await loadRow(id);
  const answer = row.answer as StoredAnswer;
  if (answer.status !== "answered") throw new ConflictError("There is nothing to reply about in this answer");
  // Re-read through the filter: anything hidden since the answer was made is left out of the draft.
  const refs = [...row.citedIds, ...(answer.draftTo ? [answer.draftTo.ref] : [])];
  const scope = await askScope();
  const docs = await loadVisibleDocs(scope, refs);
  if (!docs.length) throw new ConflictError("The items behind this answer are no longer readable by AI");
  await recordReads(scope, docs.map((d) => d.ref), { via: "ask_draft", threadId: id, question: row.question });
  let text: string;
  try {
    text = await draftReplyFromDocs({ to: answer.draftTo?.name ?? null, question: row.question, summary: answer.summary, docs });
  } catch (err) {
    logger.error({ err }, "Ask OllieOS draft failed");
    throw new UpstreamError("The draft could not be written just now. Try again in a moment.");
  }
  answer.draft = { to: answer.draftTo?.name ?? null, text, createdAt: new Date().toISOString() };
  await db.transaction(async (tx) => {
    await updateAnswer(id, answer, tx);
    await writeAudit(tx, { actor: ACTOR, action: "draft", payload: { threadId: id, to: answer.draftTo?.ref ?? null } });
  });
  return getThread(id);
}

/* ---------- Bundle ---------- */

const STATUS_ORDER: TaskStatus[] = ["now", "inbox", "backlog", "waiting"];
const PRIORITY_ORDER: Priority[] = ["high", "medium", "low"];

function common<T>(values: (T | null)[]): T | null {
  const set = new Set(values);
  return set.size === 1 ? ([...set][0] ?? null) : null;
}

/** Turns two or more open tasks cited by an answer into one task. The originals are marked done and point at it. */
export async function bundleTasks(id: number, title?: string): Promise<{ turns: AskTurnView[]; taskId: number }> {
  const row = await loadRow(id);
  const answer = row.answer as StoredAnswer;
  if (answer.bundle && !answer.bundle.undone) throw new ConflictError("These tasks have already been bundled");
  const ids = citedTaskIds(answer);
  const tasks = ids.length ? await db.select().from(tasksTable).where(inArray(tasksTable.id, ids)) : [];
  const open = tasks.filter((t) => OPEN.has(t.status));
  if (open.length < 2) throw new ConflictError("Bundling needs at least two open tasks in the answer");

  const bundleTitle = (title?.trim() || answer.bundleTitle || `Do together: ${open.map((t) => t.title).join("; ")}`).slice(0, 500);
  const status = STATUS_ORDER.find((s) => s !== "waiting" && open.some((t) => t.status === s)) ?? "backlog";
  const priority = PRIORITY_ORDER.find((p) => open.some((t) => t.priority === p)) ?? "medium";
  const dueDate = open.map((t) => t.dueDate).filter((d): d is string => !!d).sort()[0] ?? null;
  const notes = ["Bundled from Ask OllieOS:", ...open.map((t) => `- ${t.title}`)].join("\n");
  const confidential = open.some((t) => t.confidential === true) ? true : null;

  const now = new Date();
  const created = await db.transaction(async (tx) => {
    const [task] = await tx
      .insert(tasksTable)
      .values({
        title: bundleTitle,
        status,
        priority,
        dueDate,
        notes,
        personId: common(open.map((t) => t.personId)),
        projectId: common(open.map((t) => t.projectId)),
        confidential,
        triagedAt: status === "inbox" ? null : now,
        createdBy: ACTOR,
      })
      .returning();
    await writeAudit(tx, {
      actor: ACTOR,
      action: "create",
      entityType: "task",
      entityId: task.id,
      payload: { via: "bundle", threadId: id, from: open.map((t) => t.id) },
    });
    const originals: NonNullable<StoredAnswer["bundle"]>["originals"] = [];
    for (const t of open) {
      const note = `Bundled into “${bundleTitle}”`;
      await tx
        .update(tasksTable)
        .set({ status: "done", completedAt: now, notes: t.notes ? `${t.notes}\n\n${note}` : note })
        .where(eq(tasksTable.id, t.id));
      await writeAudit(tx, {
        actor: ACTOR,
        action: "bundle",
        entityType: "task",
        entityId: t.id,
        payload: {
          into: task.id,
          title: bundleTitle,
          changes: [{ field: "status", from: STATUS_LABELS[t.status], to: STATUS_LABELS.done }],
          previous: snapshotOf(t),
        },
      });
      originals.push({ id: t.id, previous: snapshotOf(t) });
    }
    answer.bundle = { taskId: task.id, title: bundleTitle, originals, createdAt: now.toISOString(), undone: false };
    await updateAnswer(id, answer, tx);
    return task;
  });
  return { ...(await getThread(id)), taskId: created.id };
}

/** Puts the original tasks back as they were and removes the bundled task. */
export async function undoBundle(id: number): Promise<{ turns: AskTurnView[] }> {
  const row = await loadRow(id);
  const answer = row.answer as StoredAnswer;
  const bundle = answer.bundle;
  if (!bundle || bundle.undone) throw new ConflictError("There is no bundle to undo");
  if (Date.now() - new Date(bundle.createdAt).getTime() > UNDO_WINDOW_MS) {
    throw new ConflictError("That bundle is too old to undo. Edit the tasks instead");
  }
  const [bundled] = await db.select().from(tasksTable).where(eq(tasksTable.id, bundle.taskId));
  const ids = bundle.originals.map((o) => o.id);
  const current = await db.select().from(tasksTable).where(inArray(tasksTable.id, ids));
  const byId = new Map(current.map((t) => [t.id, t]));

  await db.transaction(async (tx) => {
    for (const o of bundle.originals) {
      const t = byId.get(o.id);
      if (!t) continue;
      const p = o.previous;
      const suffix = `Bundled into “${bundle.title}”`;
      const notes = t.notes === suffix ? null : t.notes?.endsWith(`\n\n${suffix}`) ? t.notes.slice(0, -(suffix.length + 2)) : t.notes;
      await tx
        .update(tasksTable)
        .set({
          status: p.status,
          waitingOnPersonId: p.waitingOnPersonId,
          waitingSince: p.waitingSince ? new Date(p.waitingSince) : null,
          triagedAt: p.triagedAt ? new Date(p.triagedAt) : null,
          completedAt: p.completedAt ? new Date(p.completedAt) : null,
          snoozedUntil: p.snoozedUntil ? new Date(p.snoozedUntil) : null,
          notes,
        })
        .where(eq(tasksTable.id, o.id));
      await writeAudit(tx, {
        actor: ACTOR,
        action: "undo",
        entityType: "task",
        entityId: o.id,
        payload: { undid: "bundle", changes: [{ field: "status", from: STATUS_LABELS[t.status], to: STATUS_LABELS[p.status] }] },
      });
    }
    if (bundled) {
      await tx.delete(tasksTable).where(eq(tasksTable.id, bundled.id));
      await writeAudit(tx, {
        actor: ACTOR,
        action: "remove",
        entityType: "task",
        entityId: bundled.id,
        payload: { reason: "bundle undone", title: bundled.title, threadId: id },
      });
    }
    answer.bundle = { ...bundle, undone: true };
    await updateAnswer(id, answer, tx);
  });
  return getThread(id);
}
