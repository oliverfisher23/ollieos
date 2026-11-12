/**
 * Cowork sessions (build plan 13, Part F). Claude saves each Cowork session at the end with
 * `save_session`: the session itself goes in directly (it is a record of work, like activity), the
 * tasks and promises from it go to the Inbox, documents it produced are proposed for the Library,
 * and the session is read for knowledge in the background, which only ever proposes.
 *
 * A session older than 90 days with no open task or promise from it is archived: it stays on the
 * Sessions page and in search, but no longer goes into get_context or meeting briefs.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  coworkSessionsTable,
  db,
  knowledgeSourcesTable,
  peopleTable,
  projectsTable,
  suggestionsTable,
  tasksTable,
} from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { SESSION_ARCHIVE_DAYS, sessionArchived, sessionVisible } from "../lib/ai-data/visibility";
import { buildTsQuery } from "../lib/ai-data/search";
import { captureTask, type Writer } from "./aiWrites";
import { describeCounts } from "./documents/counts";
import { enqueueSession, sessionKey } from "./documents/enqueue";
import { kickKnowledgeReader } from "./documents/reader";
import { ACTOR, cleanText } from "./knowledge/common";
import { propose, type ProposeResult } from "./suggestions";
import { NotFoundError, ValidationError } from "./tasks";
import { alreadyCaptured, closeOpenTasks, recordMention } from "./duplicates";
import { defaultScope, visibleRefs } from "../lib/ai-data/scope";
import { toRef } from "@workspace/shared";

export { SESSION_ARCHIVE_DAYS };
export const SESSION_LIMITS = { outcomes: 30, actions: 20, artifacts: 10, questions: 20 } as const;

/**
 * Section 27: an action that is really a question the session left open ("Decide whether…",
 * "Confirm if…"). These were most of what Ollie dropped from Cowork, so they are kept on the
 * session as open questions instead of going to his Inbox.
 */
export const isOpenQuestion = (title: string): boolean =>
  /^(decide|confirm|check|clarify|settle|work out|agree|determine|find out|consider|explore)\b.{0,40}\b(whether|if)\b/i.test(title.trim()) || /\?\s*$/.test(title.trim());

const sessionArchivedSql = (alias: string, now: Date) => sql.raw(sessionArchived(alias, now));

/* ---------- Saving (Claude) ---------- */

export interface SessionAction {
  title: string;
  kind: "task" | "promise";
  personId: number | null;
  projectId: number | null;
  dueDate: string | null;
  quote: string | null;
}

export interface SessionArtifact {
  title: string;
  content: string;
  kind: string | null;
  summary: string | null;
}

export interface SaveSessionInput {
  title: string;
  summary: string;
  outcomes: string[];
  transcript: string | null;
  happenedAt: Date | null;
  /** Claude's own id for the session: saving the same one again updates it */
  externalRef: string | null;
  projectIds: number[];
  personIds: number[];
  /** Tasks Claude already logged during the session */
  taskIds: number[];
  confidential: boolean | null;
  /** Section 27: questions still open at the end; kept on the session, not made into tasks */
  openQuestions?: string[];
  actions: SessionAction[];
  artifacts: SessionArtifact[];
}

export interface SaveSessionResult {
  id: number;
  updated: boolean;
  /** False when the session is hidden from AI, so it is not read for knowledge */
  visible: boolean;
  /** linked: section 26, added to an open task with nearly the same title instead of a new one */
  tasks: { id: number | null; outcome: "created" | "duplicate" | "noise" | "linked" }[];
  /** Section 27: actions that were really open questions, kept on the session instead */
  questions: string[];
  artifacts: ProposeResult[];
}

const uniq = (xs: number[]) => [...new Set(xs.filter((x) => Number.isSafeInteger(x) && x > 0))];

export async function saveSession(writer: Writer, input: SaveSessionInput, now = new Date()): Promise<SaveSessionResult> {
  const title = cleanText(input.title);
  const summary = cleanText(input.summary);
  if (!title) throw new ValidationError("A session needs a title");
  if (!summary) throw new ValidationError("A session needs a summary");
  const outcomes = input.outcomes.map((o) => cleanText(o)).filter((o): o is string => !!o).slice(0, SESSION_LIMITS.outcomes);
  const transcript = input.transcript?.trim() || null;
  const externalRef = cleanText(input.externalRef);
  // Section 27: open questions stay on the session; only real actions go to the Inbox.
  const moved = input.actions.filter((a) => a.kind === "task" && isOpenQuestion(a.title)).map((a) => a.title);
  const actions = input.actions.filter((a) => !(a.kind === "task" && isOpenQuestion(a.title)));
  const questions = [...new Set([...(input.openQuestions ?? []), ...moved].map((q) => cleanText(q)).filter((q): q is string => !!q))].slice(0, SESSION_LIMITS.questions);

  const { id, updated } = await db.transaction(async (tx) => {
    const [have] = externalRef ? await tx.select().from(coworkSessionsTable).where(eq(coworkSessionsTable.externalRef, externalRef)) : [];
    if (have) {
      await tx
        .update(coworkSessionsTable)
        .set({
          title,
          summary,
          outcomes,
          // Questions Ollie already dealt with are gone from the list and are not put back.
          openQuestions: have.openQuestions.length || have.taskIds.length ? have.openQuestions : questions,
          transcript: transcript ?? have.transcript,
          ...(input.happenedAt ? { happenedAt: input.happenedAt } : {}),
          projectIds: uniq([...have.projectIds, ...input.projectIds]),
          personIds: uniq([...have.personIds, ...input.personIds]),
          taskIds: uniq([...have.taskIds, ...input.taskIds]),
          ...(input.confidential != null ? { confidential: input.confidential } : {}),
          updatedAt: now,
        })
        .where(eq(coworkSessionsTable.id, have.id));
      await writeAudit(tx, { actor: writer.actor, clientId: writer.clientId, action: "update", entityType: "session", entityId: have.id });
      return { id: have.id, updated: true };
    }
    const [row] = await tx
      .insert(coworkSessionsTable)
      .values({
        title,
        summary,
        outcomes,
        openQuestions: questions,
        transcript,
        happenedAt: input.happenedAt ?? now,
        projectIds: uniq(input.projectIds),
        personIds: uniq(input.personIds),
        taskIds: uniq(input.taskIds),
        confidential: input.confidential,
        externalRef,
        clientId: writer.clientId,
        createdBy: writer.actor,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: coworkSessionsTable.id });
    await writeAudit(tx, { actor: writer.actor, clientId: writer.clientId, action: "create", entityType: "session", entityId: row.id });
    return { id: row.id, updated: false };
  });

  // Tasks and promises go straight to the Inbox, once each however often the session is saved.
  const tasks: SaveSessionResult["tasks"] = [];
  for (const [i, a] of actions.slice(0, SESSION_LIMITS.actions).entries()) {
    const sourceRef = `${sessionKey(id)}#${i + 1}`;
    // Section 26: an open task with nearly the same title (and visible to AI) gets this as Also came up.
    if (!(await alreadyCaptured("session", sourceRef))) {
      const close = await closeOpenTasks(a.title);
      const visible = await visibleRefs(defaultScope(), close.map((c) => toRef("task", c.id)));
      const match = close.find((c) => visible.has(toRef("task", c.id)));
      if (
        match &&
        (await recordMention(match.id, { source: "session", sourceRef, url: null, saidBy: writer.actor, saidAt: now, place: `Cowork session: ${title}`, quote: a.quote || a.title, strength: "other" }))
      ) {
        tasks.push({ id: match.id, outcome: "linked" });
        continue;
      }
    }
    const r = await captureTask(
      writer,
      {
        title: a.title,
        kind: a.kind,
        dueDate: a.dueDate,
        source: "session",
        sourceRef,
        sourceSubject: title,
        sourceQuote: a.quote,
        personId: a.personId,
        projectId: a.projectId,
        confidential: input.confidential === true ? true : null,
        capturedAt: now,
      },
      { applyNoise: false, via: "mcp" },
    );
    tasks.push({ id: r.taskId, outcome: r.outcome });
  }
  const newTaskIds = tasks.map((t) => t.id).filter((x): x is number => x != null);
  if (newTaskIds.length) {
    await db
      .update(coworkSessionsTable)
      .set({ taskIds: sql`array(select distinct unnest(${coworkSessionsTable.taskIds} || ${sql.raw(`array[${newTaskIds.map(Number).join(",")}]::integer[]`)}))` })
      .where(eq(coworkSessionsTable.id, id));
  }

  // Documents it produced are proposed for the Library, citing the session (Part E does the rest).
  const [session] = await db.select().from(coworkSessionsTable).where(eq(coworkSessionsTable.id, id));
  const projectNames = session.projectIds.length
    ? await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(inArray(projectsTable.id, session.projectIds))
    : [];
  const artifacts: ProposeResult[] = [];
  for (const a of input.artifacts.slice(0, SESSION_LIMITS.artifacts)) {
    const docTitle = cleanText(a.title);
    if (!docTitle || !a.content.trim()) continue;
    artifacts.push(
      await propose(
        { proposedBy: writer.actor, clientId: writer.clientId, sourceType: "chat", sourceRef: sessionKey(id), sourceUrl: null, sourceLabel: `Cowork session: ${title}`, saidBy: { at: session.happenedAt } },
        {
          kind: "document",
          payload: {
            title: docTitle,
            content: a.content,
            doc_kind: cleanText(a.kind),
            summary: cleanText(a.summary),
            url: null,
            project_ids: projectNames.map((p) => p.id),
            project_names: projectNames.map((p) => p.name),
          },
        },
        now,
      ),
    );
  }

  const visible = await isVisible(id);
  if (visible) {
    await enqueueSession(db, session, now);
    kickKnowledgeReader();
  }
  return { id, updated, visible, tasks, artifacts, questions: updated ? [] : questions };
}

async function isVisible(id: number): Promise<boolean> {
  const [r] = await db
    .select({ v: sql<boolean>`${sql.raw(sessionVisible("cowork_sessions"))}` })
    .from(coworkSessionsTable)
    .where(eq(coworkSessionsTable.id, id));
  return !!r?.v;
}

/* ---------- Ollie's views ---------- */

export interface NamedLink {
  id: number;
  name: string;
  slug: string;
}

export interface SessionListItem {
  id: number;
  title: string;
  summary: string;
  outcomes: string[];
  /** Section 27: questions it left open */
  openQuestions: string[];
  happenedAt: string;
  archived: boolean;
  confidential: boolean | null;
  hiddenFromAi: boolean;
  projects: NamedLink[];
  people: NamedLink[];
  taskCount: number;
  decisionCount: number;
  documentCount: number;
  /** Suggestions from it still waiting in the Knowledge Inbox */
  waitingCount: number;
}

export interface SessionDetail extends SessionListItem {
  transcript: string | null;
  createdBy: string;
  tasks: { id: number; title: string; kind: string; status: string }[];
  decisions: { id: number; text: string }[];
  documents: { id: number; title: string }[];
  knowledge: { state: "none" | "waiting" | "reading" | "read" | "failed"; lastReadAt: string | null; found: string | null; error: string | null };
}

interface Row {
  id: number;
  title: string;
  summary: string;
  outcomes: string[];
  open_questions: string[];
  happened_at: string | Date;
  archived: boolean;
  confidential: boolean | null;
  visible: boolean;
  project_ids: number[];
  person_ids: number[];
  task_count: number;
  decision_count: number;
  document_count: number;
  waiting_count: number;
}

async function loadRows(where: SQL, now: Date, limit = 300): Promise<Row[]> {
  const res = await db.execute(sql`
    with page as materialized (
      select s.* from cowork_sessions s where ${where}
      order by s.happened_at desc, s.id desc limit ${limit}
    ), counts as (
      select g.source_ref,
        count(*) filter (where g.status = 'approved' and g.result_type = 'decision')::int as decision_count,
        count(*) filter (where g.status = 'approved' and g.result_type = 'document')::int as document_count,
        count(*) filter (where g.status = 'pending')::int as waiting_count
      from suggestions g join page p on g.source_ref = 'session:' || p.id
      group by g.source_ref
    )
    select s.id, s.title, s.summary, s.outcomes, s.open_questions, s.happened_at, s.confidential, s.project_ids, s.person_ids,
      ${sessionArchivedSql("s", now)} as archived,
      ${sql.raw(sessionVisible("s"))} as visible,
      cardinality(s.task_ids)::int as task_count,
      coalesce(c.decision_count, 0) as decision_count,
      coalesce(c.document_count, 0) as document_count,
      coalesce(c.waiting_count, 0) as waiting_count
    from page s left join counts c on c.source_ref = 'session:' || s.id
    order by s.happened_at desc, s.id desc`);
  return res.rows as unknown as Row[];
}

async function names(rows: Row[]) {
  const pIds = uniq(rows.flatMap((r) => r.project_ids ?? []));
  const peIds = uniq(rows.flatMap((r) => r.person_ids ?? []));
  const [projects, people] = await Promise.all([
    pIds.length ? db.select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug }).from(projectsTable).where(inArray(projectsTable.id, pIds)) : [],
    peIds.length ? db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug }).from(peopleTable).where(inArray(peopleTable.id, peIds)) : [],
  ]);
  return { projects: new Map(projects.map((p) => [p.id, p])), people: new Map(people.map((p) => [p.id, p])) };
}

function toItem(r: Row, n: Awaited<ReturnType<typeof names>>): SessionListItem {
  const pick = (ids: number[], m: Map<number, NamedLink>) => (ids ?? []).map((id) => m.get(id)).filter((x): x is NamedLink => !!x).sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: Number(r.id),
    title: r.title,
    summary: r.summary,
    outcomes: r.outcomes ?? [],
    openQuestions: r.open_questions ?? [],
    happenedAt: new Date(r.happened_at).toISOString(),
    archived: !!r.archived,
    confidential: r.confidential,
    hiddenFromAi: !r.visible,
    projects: pick(r.project_ids, n.projects),
    people: pick(r.person_ids, n.people),
    taskCount: Number(r.task_count),
    decisionCount: Number(r.decision_count),
    documentCount: Number(r.document_count),
    waitingCount: Number(r.waiting_count),
  };
}

export async function listSessions(opts: { q?: string } = {}, now = new Date()): Promise<SessionListItem[]> {
  const q = opts.q?.trim().slice(0, 300) ?? "";
  let where: SQL = sql`true`;
  if (q.length >= 2) {
    const tsq = buildTsQuery(q, "user");
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    where = tsq ? sql`(s.search @@ to_tsquery('english', ${tsq}) or s.title ilike ${like})` : sql`s.title ilike ${like}`;
  }
  const rows = await loadRows(where, now);
  const n = await names(rows);
  return rows.map((r) => toItem(r, n));
}

export async function sessionDetail(id: number, now = new Date()): Promise<SessionDetail> {
  const [r] = await loadRows(sql`s.id = ${id}`, now, 1);
  if (!r) throw new NotFoundError("That session does not exist");
  const [full] = await db.select().from(coworkSessionsTable).where(eq(coworkSessionsTable.id, id));
  const [tasks, results, [src]] = await Promise.all([
    full.taskIds.length
      ? db
          .select({ id: tasksTable.id, title: tasksTable.title, kind: tasksTable.kind, status: tasksTable.status })
          .from(tasksTable)
          .where(inArray(tasksTable.id, full.taskIds))
          .orderBy(tasksTable.id)
      : [],
    db.execute(sql`
      select g.result_type as type, g.result_id as id, coalesce(d.text, dc.title) as label
      from suggestions g
      left join decisions d on g.result_type = 'decision' and d.id = g.result_id
      left join documents dc on g.result_type = 'document' and dc.id = g.result_id
      where g.source_ref = ${sessionKey(id)} and g.status = 'approved' and g.result_type in ('decision', 'document') and g.result_id is not null
      order by g.decided_at`),
    db.select().from(knowledgeSourcesTable).where(eq(knowledgeSourcesTable.key, sessionKey(id))),
  ]);
  const found = (results.rows as { type: string; id: number; label: string | null }[]).filter((x) => x.label);
  const docs = new Map<number, string>();
  for (const x of found) if (x.type === "document") docs.set(Number(x.id), x.label!);
  return {
    ...toItem(r, await names([r])),
    transcript: full.transcript,
    createdBy: full.createdBy,
    tasks: tasks.map((t) => ({ ...t, status: String(t.status) })),
    decisions: found.filter((x) => x.type === "decision").map((x) => ({ id: Number(x.id), text: x.label! })),
    documents: [...docs].map(([docId, title]) => ({ id: docId, title })),
    knowledge: knowledgeState(src),
  };
}

function knowledgeState(src: typeof knowledgeSourcesTable.$inferSelect | undefined): SessionDetail["knowledge"] {
  if (!src) return { state: "none", lastReadAt: null, found: null, error: null };
  const state = src.status === "queued" ? "waiting" : src.status === "reading" ? "reading" : src.status === "failed" ? "failed" : src.lastReadAt ? "read" : "none";
  return {
    state,
    lastReadAt: src.lastReadAt?.toISOString() ?? null,
    found: src.lastCounts ? describeCounts(src.lastCounts) : null,
    error: src.status === "failed" ? src.lastError : null,
  };
}

/** Ollie changes whether AI can see it. Hiding it stops a waiting read. */
export async function updateSession(id: number, input: { confidential?: boolean | null }): Promise<SessionDetail> {
  const [have] = await db.select({ id: coworkSessionsTable.id }).from(coworkSessionsTable).where(eq(coworkSessionsTable.id, id));
  if (!have) throw new NotFoundError("That session does not exist");
  if (input.confidential !== undefined) {
    await db.transaction(async (tx) => {
      await tx.update(coworkSessionsTable).set({ confidential: input.confidential, updatedAt: new Date() }).where(eq(coworkSessionsTable.id, id));
      await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "session", entityId: id, payload: { confidential: input.confidential } });
    });
    if (!(await isVisible(id))) {
      await db
        .update(knowledgeSourcesTable)
        .set({ status: "idle" })
        .where(and(eq(knowledgeSourcesTable.key, sessionKey(id)), eq(knowledgeSourcesTable.status, "queued")));
    }
  }
  return sessionDetail(id);
}

/**
 * Section 27: deals with one open question on a session. "task" puts it in Ollie's Inbox, linked to
 * the session; "dismiss" just takes it off the list.
 */
export async function decideSessionQuestion(id: number, question: string, action: "task" | "dismiss"): Promise<SessionDetail> {
  const [have] = await db.select().from(coworkSessionsTable).where(eq(coworkSessionsTable.id, id));
  if (!have) throw new NotFoundError("That session does not exist");
  const q = question.trim();
  if (!have.openQuestions.includes(q)) throw new NotFoundError("That question is not on this session");
  let taskId: number | null = null;
  if (action === "task") {
    const r = await captureTask(
      { actor: ACTOR, clientId: null },
      { title: q, source: "session", sourceRef: `${sessionKey(id)}#q:${q.slice(0, 200)}`, sourceSubject: have.title, confidential: have.confidential === true ? true : null, capturedAt: new Date() },
      { applyNoise: false, via: "app" },
    );
    taskId = r.taskId;
  }
  await db
    .update(coworkSessionsTable)
    .set({ openQuestions: have.openQuestions.filter((x) => x !== q), taskIds: taskId != null ? uniq([...have.taskIds, taskId]) : have.taskIds, updatedAt: new Date() })
    .where(eq(coworkSessionsTable.id, id));
  return sessionDetail(id);
}

/** Reads the session for knowledge again, for one that failed or that Ollie wants checked again. */
export async function readSessionAgain(id: number): Promise<SessionDetail> {
  const [s] = await db.select().from(coworkSessionsTable).where(eq(coworkSessionsTable.id, id));
  if (!s) throw new NotFoundError("That session does not exist");
  if (!(await isVisible(id))) throw new ValidationError("This session is hidden from AI, so OllieOS does not read it for knowledge.");
  await enqueueSession(db, s);
  kickKnowledgeReader();
  return sessionDetail(id);
}

/** Deletes the session. Tasks, decisions and documents that came from it stay. */
export async function deleteSession(id: number): Promise<void> {
  const rows = await db.transaction(async (tx) => {
    const out = await tx.delete(coworkSessionsTable).where(eq(coworkSessionsTable.id, id)).returning({ id: coworkSessionsTable.id });
    if (out.length) await writeAudit(tx, { actor: ACTOR, action: "delete", entityType: "session", entityId: id });
    return out;
  });
  if (!rows.length) throw new NotFoundError("That session does not exist");
}
