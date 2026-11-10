/**
 * The knowledge graph (build plan 13, Part G): everything in OllieOS as points joined by labelled
 * links. Most links are worked out from what OllieOS already holds (a person's organisation, a
 * task's project, a meeting's people); stated relationships live on the links table.
 *
 * One builder serves Ollie and AI tools. For an AI scope, hidden points are dropped and never
 * followed, so nothing reachable only through a hidden point is returned either. For Ollie
 * everything comes back with hidden points marked.
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  calendarEventsTable,
  coworkSessionsTable,
  db,
  decisionsTable,
  documentsTable,
  goalsTable,
  linksTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  tasksTable,
} from "@workspace/db";
import {
  OPEN_STATUSES,
  RELATIONSHIPS,
  RELATIONSHIP_INVERSE,
  RELATIONSHIP_LABELS,
  formatDayMonth,
  type Relationship,
} from "@workspace/shared";
import { visibleCalendarRows } from "./context";
import { loadVisibleDocs } from "./retrieve";
import { defaultScope, recordReads, visibleRefs, type AiScope } from "./scope";

export const GRAPH_TYPES = ["person", "organisation", "project", "goal", "decision", "document", "task", "session", "meeting"] as const;
export type GraphType = (typeof GRAPH_TYPES)[number];

/** Links worked out from what OllieOS holds, with how they read from each end. */
export const DERIVED_LINKS = {
  works_at: ["works at", "employs"],
  task_for: ["is a task for", "has the task"],
  about: ["is about", "is the subject of"],
  waiting_on: ["is waiting on", "is holding up"],
  decided_in: ["was decided in", "has the decision"],
  met: ["was a meeting with", "was in"],
  meeting_about: ["was a meeting about", "was discussed in"],
  touched: ["worked on", "was worked on in"],
  created: ["created", "was created in"],
  towards: ["works towards", "is supported by"],
  linked: ["is linked to", "is linked to"],
} as const satisfies Record<string, readonly [string, string]>;
export type DerivedLink = keyof typeof DERIVED_LINKS;
export type LinkKind = DerivedLink | Relationship;
export const LINK_KINDS: readonly LinkKind[] = [...(Object.keys(DERIVED_LINKS) as DerivedLink[]), ...RELATIONSHIPS];

export interface GraphNode {
  ref: string;
  type: GraphType;
  id: number;
  name: string;
  /** A short line under the name: a role, a status, a date */
  detail: string | null;
  slug: string | null;
  /** Hidden from AI. Only ever true in Ollie's own views. */
  hidden: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: LinkKind;
  /** Read from the "from" end */
  label: string;
  /** Read from the "to" end */
  inverse: string;
  /** Ollie stated it (or approved it), rather than OllieOS working it out */
  stated: boolean;
  note: string | null;
  source: string | null;
}

export interface GraphResult {
  centre: GraphNode | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Points left out because they are hidden from this AI tool */
  hiddenCount: number;
  /** True when the node cap cut the picture short */
  truncated: boolean;
}

interface Pt {
  type: GraphType;
  id: number;
}

export const gref = (type: GraphType, id: number) => `${type}:${id}`;

/** "person:3"; "calendar_event:4" is accepted for a meeting, as get_context names them. */
export function parseGraphRef(value: string): Pt | null {
  const m = /^([a-z_]+):(\d+)$/.exec(value.trim());
  if (!m) return null;
  const type = (m[1] === "calendar_event" ? "meeting" : m[1]) as GraphType;
  if (!(GRAPH_TYPES as readonly string[]).includes(type)) return null;
  const id = Number(m[2]);
  return Number.isSafeInteger(id) && id > 0 ? { type, id } : null;
}

const ptOf = (ref: string) => parseGraphRef(ref)!;
const intArray = (ids: number[]) => sql.raw(`array[${ids.filter((n) => Number.isSafeInteger(n)).join(",")}]::integer[]`);
const MEETING_PAST_DAYS = 90;
const MEETING_AHEAD_DAYS = 14;
const DONE_TASK_DAYS = 30;
/** Most points one picture holds; what is cut is reported as truncated. */
export const MAX_NODES = 150;
export const OVERVIEW_MAX = 300;

function derived(kind: DerivedLink, from: string, to: string): GraphEdge {
  const [label, inverse] = DERIVED_LINKS[kind];
  return { from, to, kind, label, inverse, stated: false, note: null, source: null };
}

/* ---------- Following links ---------- */

/** Every link touching any of the given points, in one round of queries. Ends may be anything. */
export async function expand(points: Pt[], now = new Date()): Promise<GraphEdge[]> {
  const ids = (t: GraphType) => [...new Set(points.filter((p) => p.type === t).map((p) => p.id))];
  const P = ids("person");
  const O = ids("organisation");
  const J = ids("project");
  const G = ids("goal");
  const D = ids("decision");
  const T = ids("task");
  const S = ids("session");
  const M = ids("meeting");
  const any = (conds: (SQL | undefined | false)[]) => {
    const list = conds.filter((c): c is SQL => !!c);
    return list.length ? or(...list) : undefined;
  };
  const edges: GraphEdge[] = [];
  const doneSince = new Date(now.getTime() - DONE_TASK_DAYS * 86_400_000);

  const peopleWhere = any([P.length > 0 && inArray(peopleTable.id, P), O.length > 0 && inArray(peopleTable.organisationId, O)]);
  const taskWhere = any([
    T.length > 0 && inArray(tasksTable.id, T),
    J.length > 0 && inArray(tasksTable.projectId, J),
    P.length > 0 && inArray(tasksTable.personId, P),
    P.length > 0 && inArray(tasksTable.waitingOnPersonId, P),
    G.length > 0 && inArray(tasksTable.goalId, G),
  ]);
  const decisionWhere = any([D.length > 0 && inArray(decisionsTable.id, D), J.length > 0 && inArray(decisionsTable.projectId, J)]);
  const projectWhere = any([J.length > 0 && inArray(projectsTable.id, J), G.length > 0 && inArray(projectsTable.goalId, G)]);
  const meetingWhere = any([
    M.length > 0 && inArray(calendarEventsTable.id, M),
    P.length > 0 && sql`${calendarEventsTable.personIds} && ${intArray(P)}`,
    J.length > 0 && inArray(calendarEventsTable.projectId, J),
  ]);
  const sessionWhere = any([
    S.length > 0 && inArray(coworkSessionsTable.id, S),
    J.length > 0 && sql`${coworkSessionsTable.projectIds} && ${intArray(J)}`,
    P.length > 0 && sql`${coworkSessionsTable.personIds} && ${intArray(P)}`,
    T.length > 0 && sql`${coworkSessionsTable.taskIds} && ${intArray(T)}`,
  ]);
  const linkTypes = (["person", "organisation", "project", "decision", "document", "task"] as const).filter((t) => ids(t).length);
  const linkWhere = any(
    linkTypes.flatMap((t) => [
      and(eq(linksTable.fromType, t), inArray(linksTable.fromId, ids(t))),
      and(eq(linksTable.toType, t), inArray(linksTable.toId, ids(t))),
    ]),
  );

  const [people, tasks, decisions, projects, meetings, sessions, links] = await Promise.all([
    peopleWhere
      ? db.select({ id: peopleTable.id, org: peopleTable.organisationId }).from(peopleTable).where(and(peopleWhere, isNotNull(peopleTable.organisationId)))
      : [],
    taskWhere
      ? db
          .select({ id: tasksTable.id, projectId: tasksTable.projectId, personId: tasksTable.personId, waitingOn: tasksTable.waitingOnPersonId, goalId: tasksTable.goalId })
          .from(tasksTable)
          .where(
            and(
              taskWhere,
              or(
                T.length ? inArray(tasksTable.id, T) : undefined,
                inArray(tasksTable.status, [...OPEN_STATUSES]),
                and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, doneSince)),
              ),
            ),
          )
          .orderBy(desc(tasksTable.updatedAt))
          .limit(400)
      : [],
    decisionWhere
      ? db.select({ id: decisionsTable.id, projectId: decisionsTable.projectId }).from(decisionsTable).where(and(decisionWhere, isNotNull(decisionsTable.projectId))).orderBy(desc(decisionsTable.decidedAt)).limit(300)
      : [],
    projectWhere ? db.select({ id: projectsTable.id, goalId: projectsTable.goalId }).from(projectsTable).where(and(projectWhere, isNotNull(projectsTable.goalId))) : [],
    meetingWhere
      ? db
          .select({ id: calendarEventsTable.id, personIds: calendarEventsTable.personIds, projectId: calendarEventsTable.projectId })
          .from(calendarEventsTable)
          .where(
            and(
              meetingWhere,
              eq(calendarEventsTable.personal, false),
              or(
                M.length ? inArray(calendarEventsTable.id, M) : undefined,
                and(
                  gte(calendarEventsTable.startsAt, new Date(now.getTime() - MEETING_PAST_DAYS * 86_400_000)),
                  lte(calendarEventsTable.startsAt, new Date(now.getTime() + MEETING_AHEAD_DAYS * 86_400_000)),
                ),
              ),
            ),
          )
          .orderBy(desc(calendarEventsTable.startsAt))
          .limit(200)
      : [],
    sessionWhere
      ? db
          .select({ id: coworkSessionsTable.id, projectIds: coworkSessionsTable.projectIds, personIds: coworkSessionsTable.personIds, taskIds: coworkSessionsTable.taskIds })
          .from(coworkSessionsTable)
          .where(sessionWhere)
          .orderBy(desc(coworkSessionsTable.happenedAt))
          .limit(200)
      : [],
    linkWhere ? db.select().from(linksTable).where(linkWhere) : [],
  ]);

  for (const p of people) edges.push(derived("works_at", gref("person", p.id), gref("organisation", p.org!)));
  for (const t of tasks) {
    const me = gref("task", t.id);
    if (t.projectId != null) edges.push(derived("task_for", me, gref("project", t.projectId)));
    if (t.personId != null) edges.push(derived("about", me, gref("person", t.personId)));
    if (t.waitingOn != null) edges.push(derived("waiting_on", me, gref("person", t.waitingOn)));
    if (t.goalId != null) edges.push(derived("towards", me, gref("goal", t.goalId)));
  }
  for (const d of decisions) edges.push(derived("decided_in", gref("decision", d.id), gref("project", d.projectId!)));
  for (const p of projects) edges.push(derived("towards", gref("project", p.id), gref("goal", p.goalId!)));
  for (const m of meetings) {
    const me = gref("meeting", m.id);
    for (const p of m.personIds) edges.push(derived("met", me, gref("person", p)));
    if (m.projectId != null) edges.push(derived("meeting_about", me, gref("project", m.projectId)));
  }
  for (const s of sessions) {
    const me = gref("session", s.id);
    for (const p of s.projectIds) edges.push(derived("touched", me, gref("project", p)));
    for (const p of s.personIds) edges.push(derived("touched", me, gref("person", p)));
    for (const t of s.taskIds) edges.push(derived("created", me, gref("task", t)));
  }
  for (const l of links) {
    if (!(GRAPH_TYPES as readonly string[]).includes(l.fromType) || !(GRAPH_TYPES as readonly string[]).includes(l.toType)) continue;
    const from = gref(l.fromType as GraphType, l.fromId);
    const to = gref(l.toType as GraphType, l.toId);
    if (l.relationship) {
      edges.push({ from, to, kind: l.relationship, label: RELATIONSHIP_LABELS[l.relationship], inverse: RELATIONSHIP_INVERSE[l.relationship], stated: true, note: l.note, source: l.source });
    } else if (l.fromType === "document" || l.toType === "document") {
      // A document linked to a project is about it; keep the document at the "from" end.
      const [doc, other] = l.fromType === "document" ? [from, to] : [to, from];
      edges.push(derived("about", doc, other));
    } else edges.push(derived("linked", from, to));
  }
  return edges;
}

/* ---------- Describing points ---------- */

export async function describePoints(refs: string[]): Promise<Map<string, GraphNode>> {
  const pts = refs.map(parseGraphRef).filter((p): p is Pt => !!p);
  const ids = (t: GraphType) => [...new Set(pts.filter((p) => p.type === t).map((p) => p.id))];
  const out = new Map<string, GraphNode>();
  const put = (type: GraphType, id: number, name: string, detail: string | null, slug: string | null = null) =>
    out.set(gref(type, id), { ref: gref(type, id), type, id, name, detail: detail || null, slug, hidden: false });
  const run = async <T>(t: GraphType, q: (ids: number[]) => Promise<T[]>, each: (r: T) => void) => {
    const list = ids(t);
    if (list.length) for (const r of await q(list)) each(r);
  };
  const short = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
  await Promise.all([
    run(
      "person",
      (i) =>
        db
          .select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, role: peopleTable.role, org: organisationsTable.name, isSelf: peopleTable.isSelf })
          .from(peopleTable)
          .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
          .where(inArray(peopleTable.id, i)),
      (r) => put("person", r.id, r.name, r.isSelf ? "You" : [r.role, r.org].filter(Boolean).join(", "), r.slug),
    ),
    run(
      "organisation",
      (i) => db.select({ id: organisationsTable.id, name: organisationsTable.name, slug: organisationsTable.slug, type: organisationsTable.type }).from(organisationsTable).where(inArray(organisationsTable.id, i)),
      (r) => put("organisation", r.id, r.name, r.type, r.slug),
    ),
    run(
      "project",
      (i) => db.select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, status: projectsTable.status, archived: projectsTable.archived }).from(projectsTable).where(inArray(projectsTable.id, i)),
      (r) => put("project", r.id, r.name, r.archived ? "Archived" : r.status ? short(r.status, 80) : null, r.slug),
    ),
    run(
      "goal",
      (i) => db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, i)),
      (r) => put("goal", r.id, r.name, "Goal"),
    ),
    run(
      "decision",
      (i) => db.select({ id: decisionsTable.id, text: decisionsTable.text, at: decisionsTable.decidedAt }).from(decisionsTable).where(inArray(decisionsTable.id, i)),
      (r) => put("decision", r.id, short(r.text), r.at ? `Decided ${formatDayMonth(r.at)}` : null),
    ),
    run(
      "document",
      (i) => db.select({ id: documentsTable.id, title: documentsTable.title }).from(documentsTable).where(inArray(documentsTable.id, i)),
      (r) => put("document", r.id, r.title, "Document"),
    ),
    run(
      "task",
      (i) => db.select({ id: tasksTable.id, title: tasksTable.title, kind: tasksTable.kind, status: tasksTable.status, due: tasksTable.dueDate }).from(tasksTable).where(inArray(tasksTable.id, i)),
      (r) =>
        put(
          "task",
          r.id,
          short(r.title),
          [r.kind === "promise" ? "Promise" : "Task", r.status === "done" ? "done" : r.status === "dropped" ? "dropped" : "open", r.due ? `due ${formatDayMonth(r.due)}` : null].filter(Boolean).join(", "),
        ),
    ),
    run(
      "session",
      (i) => db.select({ id: coworkSessionsTable.id, title: coworkSessionsTable.title, at: coworkSessionsTable.happenedAt }).from(coworkSessionsTable).where(inArray(coworkSessionsTable.id, i)),
      (r) => put("session", r.id, r.title, `Cowork session, ${formatDayMonth(r.at)}`),
    ),
    run(
      "meeting",
      (i) => db.select({ id: calendarEventsTable.id, title: calendarEventsTable.title, at: calendarEventsTable.startsAt }).from(calendarEventsTable).where(inArray(calendarEventsTable.id, i)),
      (r) => put("meeting", r.id, r.title, `Meeting, ${formatDayMonth(r.at)}`),
    ),
  ]);
  return out;
}

/* ---------- Visibility ---------- */

/** The refs among those given that this scope cannot see (or that no longer exist). */
export async function hiddenRefs(scope: AiScope, refs: string[]): Promise<Set<string>> {
  if (!refs.length) return new Set();
  const plain = refs.filter((r) => !r.startsWith("meeting:"));
  const meetingIds = refs.filter((r) => r.startsWith("meeting:")).map((r) => ptOf(r).id);
  const [visible, meetingRows] = await Promise.all([
    visibleRefs(scope, plain),
    meetingIds.length ? db.select().from(calendarEventsTable).where(and(inArray(calendarEventsTable.id, meetingIds), eq(calendarEventsTable.personal, false))) : [],
  ]);
  const okMeetings = new Set((await visibleCalendarRows(scope, meetingRows)).rows.map((r) => gref("meeting", r.id)));
  return new Set(refs.filter((r) => (r.startsWith("meeting:") ? !okMeetings.has(r) : !visible.has(r))));
}

/* ---------- Pictures ---------- */

/** Which points to keep first when a picture is too big: the ones that join things up. */
const TYPE_ORDER: Record<GraphType, number> = { person: 0, organisation: 1, project: 2, goal: 3, decision: 4, document: 5, session: 6, meeting: 7, task: 8 };

export interface ExploreOptions {
  depth?: 1 | 2;
  /** Only these kinds of point around the centre */
  types?: readonly GraphType[];
  /** Only these links */
  kinds?: readonly LinkKind[];
  /** null means Ollie: everything, hidden points marked */
  scope: AiScope | null;
  now?: Date;
}

/** One point and what is connected to it, one or two steps out. Null when it is missing or hidden. */
export async function explore(start: string, opts: ExploreOptions): Promise<GraphResult | null> {
  const pt = parseGraphRef(start);
  if (!pt) return null;
  const centreRef = gref(pt.type, pt.id);
  const forAi = opts.scope != null;
  const scope = opts.scope ?? defaultScope();
  const centreHidden = (await hiddenRefs(scope, [centreRef])).has(centreRef);
  if (forAi && centreHidden) return null;
  const described = await describePoints([centreRef]);
  const centre = described.get(centreRef);
  if (!centre) return null;
  centre.hidden = centreHidden;

  const nodes = new Map<string, GraphNode>([[centreRef, centre]]);
  const edges = new Map<string, GraphEdge>();
  const hiddenSeen = new Set<string>();
  let frontier: string[] = [centreRef];
  let truncated = false;
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
  const types = opts.types?.length ? new Set(opts.types) : null;

  for (let step = 0; step < (opts.depth ?? 1) && frontier.length; step++) {
    const raw = (await expand(frontier.map(ptOf), opts.now)).filter((e) => !kinds || kinds.has(e.kind));
    const fresh = [...new Set(raw.flatMap((e) => [e.from, e.to]).filter((r) => !nodes.has(r) && !hiddenSeen.has(r)))].filter(
      (r) => !types || types.has(ptOf(r).type),
    );
    const hidden = await hiddenRefs(scope, fresh);
    const info = await describePoints(fresh);
    const keep: GraphNode[] = [];
    for (const r of fresh) {
      const n = info.get(r);
      if (!n) continue;
      if (hidden.has(r)) {
        if (forAi) {
          hiddenSeen.add(r);
          continue;
        }
        n.hidden = true;
      }
      keep.push(n);
    }
    keep.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
    const room = MAX_NODES - nodes.size;
    if (keep.length > room) truncated = true;
    const added = keep.slice(0, Math.max(room, 0));
    for (const n of added) nodes.set(n.ref, n);
    for (const e of raw) {
      if (nodes.has(e.from) && nodes.has(e.to) && e.from !== e.to) edges.set(`${e.from}|${e.to}|${e.kind}`, e);
    }
    // Hidden points are never followed, even in Ollie's view, so his map matches what AI can reach.
    frontier = added.filter((n) => !n.hidden).map((n) => n.ref);
  }
  return { centre, nodes: [...nodes.values()], edges: [...edges.values()], hiddenCount: forAi ? hiddenSeen.size : 0, truncated };
}

export interface Path {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** How two points are connected, up to three steps, through visible points only. Shortest first. */
export async function findConnection(fromRef: string, toRef: string, scope: AiScope | null, maxSteps = 3, now = new Date()): Promise<{ from: GraphNode; to: GraphNode; paths: Path[] } | null> {
  const a = parseGraphRef(fromRef);
  const b = parseGraphRef(toRef);
  if (!a || !b) return null;
  const A = gref(a.type, a.id);
  const B = gref(b.type, b.id);
  const s = scope ?? defaultScope();
  const ends = await describePoints([A, B]);
  if (!ends.get(A) || !ends.get(B)) return null;
  if (scope) {
    const hidden = await hiddenRefs(s, [A, B]);
    if (hidden.size) return null;
  }
  const parents = new Map<string, { prev: string; edge: GraphEdge }[]>();
  const depthOf = new Map<string, number>([[A, 0]]);
  let frontier = [A];
  let found = A === B;
  for (let step = 1; step <= maxSteps && frontier.length && !found; step++) {
    const raw = await expand(frontier.map(ptOf), now);
    const fresh = [...new Set(raw.flatMap((e) => [e.from, e.to]).filter((r) => !depthOf.has(r)))];
    const hidden = scope ? await hiddenRefs(s, fresh) : new Set<string>();
    const next = new Set<string>();
    const inFrontier = new Set(frontier);
    for (const e of raw) {
      for (const [here, there] of [[e.from, e.to], [e.to, e.from]] as const) {
        if (!inFrontier.has(here) || hidden.has(there)) continue;
        const d = depthOf.get(there);
        if (d != null && d < step) continue;
        depthOf.set(there, step);
        const list = parents.get(there) ?? [];
        if (!list.some((p) => p.prev === here && p.edge.kind === e.kind)) list.push({ prev: here, edge: e });
        parents.set(there, list);
        next.add(there);
      }
    }
    if (next.has(B)) found = true;
    // Tasks rarely join two things up and multiply fast, so they are not followed further.
    frontier = [...next].filter((r) => !r.startsWith("task:") || r === B).slice(0, 300);
  }
  if (!found || A === B) return { from: ends.get(A)!, to: ends.get(B)!, paths: [] };

  const routes: { refs: string[]; edges: GraphEdge[] }[] = [];
  const walk = (at: string, refs: string[], es: GraphEdge[]) => {
    if (routes.length >= 3) return;
    if (at === A) {
      routes.push({ refs: [A, ...refs], edges: es });
      return;
    }
    for (const p of parents.get(at) ?? []) walk(p.prev, [at, ...refs], [p.edge, ...es]);
  };
  walk(B, [], []);
  const info = await describePoints([...new Set(routes.flatMap((r) => r.refs))]);
  return {
    from: ends.get(A)!,
    to: ends.get(B)!,
    paths: routes.map((r) => ({ nodes: r.refs.map((x) => info.get(x)!).filter(Boolean), edges: r.edges })),
  };
}

/**
 * The whole picture for Ollie's map: people, organisations, projects and goals, joined by where
 * people work, what projects work towards and every link between them. Capped at the most
 * connected points.
 */
export async function overview(scope: AiScope | null): Promise<GraphResult> {
  const [people, orgs, projects, goals] = await Promise.all([
    db.select({ id: peopleTable.id }).from(peopleTable),
    db.select({ id: organisationsTable.id }).from(organisationsTable),
    db.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.archived, false)),
    db.select({ id: goalsTable.id }).from(goalsTable),
  ]);
  const all = [
    ...people.map((r) => gref("person", r.id)),
    ...orgs.map((r) => gref("organisation", r.id)),
    ...projects.map((r) => gref("project", r.id)),
    ...goals.map((r) => gref("goal", r.id)),
  ];
  const s = scope ?? defaultScope();
  const hidden = await hiddenRefs(s, all);
  const inPicture = new Set(scope ? all.filter((r) => !hidden.has(r)) : all);
  const raw = all.length ? await expand([...inPicture].map(ptOf)) : [];
  const edges = new Map<string, GraphEdge>();
  for (const e of raw) if (inPicture.has(e.from) && inPicture.has(e.to) && e.from !== e.to) edges.set(`${e.from}|${e.to}|${e.kind}`, e);
  const degree = new Map<string, number>();
  for (const e of edges.values()) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const ranked = [...inPicture].sort((x, y) => (degree.get(y) ?? 0) - (degree.get(x) ?? 0) || TYPE_ORDER[ptOf(x).type] - TYPE_ORDER[ptOf(y).type]);
  const kept = new Set(ranked.slice(0, OVERVIEW_MAX));
  const info = await describePoints([...kept]);
  const nodes = [...kept].map((r) => info.get(r)).filter((n): n is GraphNode => !!n);
  for (const n of nodes) n.hidden = hidden.has(n.ref);
  return {
    centre: null,
    nodes,
    edges: [...edges.values()].filter((e) => kept.has(e.from) && kept.has(e.to)),
    hiddenCount: scope ? hidden.size : 0,
    truncated: inPicture.size > OVERVIEW_MAX,
  };
}

/* ---------- For AI tools ---------- */

/** A link as one sentence an AI can quote: "Sam Lee reports to Alex Kerr". */
export function sentence(e: GraphEdge, names: Map<string, GraphNode>): string {
  const a = names.get(e.from)?.name ?? e.from;
  const b = names.get(e.to)?.name ?? e.to;
  return `${a} ${e.label} ${b}`;
}

export function graphForAi(r: GraphResult) {
  const names = new Map(r.nodes.map((n) => [n.ref, n]));
  return {
    item: r.centre ? { ref: r.centre.ref, type: r.centre.type, name: r.centre.name, detail: r.centre.detail } : null,
    items: r.nodes.filter((n) => n.ref !== r.centre?.ref).map((n) => ({ ref: n.ref, type: n.type, name: n.name, detail: n.detail })),
    links: r.edges.map((e) => ({
      from: e.from,
      to: e.to,
      relationship: e.kind,
      says: sentence(e, names),
      stated_by_ollie: e.stated,
      ...(e.note ? { note: e.note } : {}),
      ...(e.source ? { source: e.source } : {}),
    })),
    ...(r.hiddenCount ? { hidden_items: r.hiddenCount, hidden_note: "Some connected items are hidden from AI tools. Use request_access if you need one." } : {}),
    ...(r.truncated ? { truncated: true } : {}),
  };
}

/** explore for an AI tool: visible points only, every one logged as read. */
export async function exploreForAi(scope: AiScope, ref: string, opts: Omit<ExploreOptions, "scope">) {
  const r = await explore(ref, { ...opts, scope });
  if (!r) return null;
  await recordReads(scope, r.nodes.map((n) => n.ref), { via: "explore" });
  return graphForAi(r);
}

/** find_connection for an AI tool: each path as the sentences that make it up. */
export async function connectionForAi(scope: AiScope, from: string, to: string) {
  const r = await findConnection(from, to, scope);
  if (!r) return null;
  const refs = [r.from.ref, r.to.ref, ...r.paths.flatMap((p) => p.nodes.map((n) => n.ref))];
  await recordReads(scope, refs, { via: "find_connection" });
  const brief = (n: GraphNode) => ({ ref: n.ref, type: n.type, name: n.name, detail: n.detail });
  return {
    from: brief(r.from),
    to: brief(r.to),
    paths: r.paths.map((p) => {
      const names = new Map(p.nodes.map((n) => [n.ref, n]));
      return { steps: p.edges.map((e) => sentence(e, names)), items: p.nodes.map(brief) };
    }),
    ...(r.paths.length ? {} : { message: "No connection within three steps through items you can see." }),
  };
}

/** fetch for an AI tool: the full text of one item, the shape ChatGPT expects. */
export async function fetchForAi(scope: AiScope, ref: string) {
  // Strategy sections and ideas are not on the map, so they are fetched as plain items.
  const plain = /^(strategy|idea):(\d+)$/.exec(ref.trim());
  if (plain) {
    const key = `${plain[1]}:${Number(plain[2])}`;
    const [doc] = await loadVisibleDocs(scope, [key]);
    if (!doc) return null;
    await recordReads(scope, [key], { via: "fetch" });
    const title = doc.text.split("\n")[0].replace(/^\[[^\]]+\]\s*/, "");
    return { id: key, title, text: doc.text, url: null, metadata: { type: plain[1], detail: null } };
  }
  const pt = parseGraphRef(ref);
  if (!pt) return null;
  const key = gref(pt.type, pt.id);
  if ((await hiddenRefs(scope, [key])).has(key)) return null;
  const info = (await describePoints([key])).get(key);
  if (!info) return null;
  let text = [info.name, info.detail].filter(Boolean).join("\n");
  if (pt.type !== "meeting") {
    const [doc] = await loadVisibleDocs(scope, [key]);
    if (!doc) return null;
    text = doc.text;
  }
  await recordReads(scope, [key], { via: "fetch" });
  return { id: key, title: info.name, text, url: null, metadata: { type: info.type, detail: info.detail } };
}
