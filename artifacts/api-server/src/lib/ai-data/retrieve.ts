import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  decisionsTable,
  factsTable,
  linksTable,
  notesTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  tasksTable,
} from "@workspace/db";
import { PRIORITY_LABELS, SOURCE_LABELS, STATUS_LABELS, formatLong, parseRef, toRef, type RefType } from "@workspace/shared";
import {
  decisionVisible,
  factVisible,
  noteVisible,
  organisationVisible,
  personVisible,
  projectVisible,
  taskVisible,
  type Grants,
} from "./visibility";
import { searchItems, type SearchHit, type SearchType } from "./search";
import type { AiScope } from "./scope";

/** One item handed to the model, already filtered for visibility. */
export interface AiDoc {
  ref: string;
  type: RefType;
  id: number;
  text: string;
}

const MAX_DOCS = 60;
const EXPAND_ENTITIES = 4;
const RECENT_DONE_DAYS = 60;

function filters(g: Grants) {
  return {
    task: sql.raw(taskVisible("tasks", g)),
    project: sql.raw(projectVisible("projects", g)),
    person: sql.raw(personVisible("people", g)),
    organisation: sql.raw(organisationVisible("organisations", g)),
    decision: sql.raw(decisionVisible("decisions", g)),
    note: sql.raw(noteVisible("notes", g)),
    fact: sql.raw(factVisible("facts", g)),
  };
}

type Names = Map<string, string>;

/** Visible names for entity refs, so a visible task never leaks the name of a hidden project or person. */
async function visibleNames(refs: { type: RefType; id: number }[], g: Grants): Promise<Names> {
  const v = filters(g);
  const ids = (t: RefType) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const out: Names = new Map();
  const [pr, pe, or_, ta, de] = await Promise.all([
    ids("project").length
      ? db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(and(inArray(projectsTable.id, ids("project")), v.project))
      : [],
    ids("person").length
      ? db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(and(inArray(peopleTable.id, ids("person")), v.person))
      : [],
    ids("organisation").length
      ? db
          .select({ id: organisationsTable.id, name: organisationsTable.name })
          .from(organisationsTable)
          .where(and(inArray(organisationsTable.id, ids("organisation")), v.organisation))
      : [],
    ids("task").length
      ? db.select({ id: tasksTable.id, name: tasksTable.title }).from(tasksTable).where(and(inArray(tasksTable.id, ids("task")), v.task))
      : [],
    ids("decision").length
      ? db.select({ id: decisionsTable.id, name: decisionsTable.text }).from(decisionsTable).where(and(inArray(decisionsTable.id, ids("decision")), v.decision))
      : [],
  ]);
  for (const r of pr) out.set(toRef("project", r.id), r.name);
  for (const r of pe) out.set(toRef("person", r.id), r.name);
  for (const r of or_) out.set(toRef("organisation", r.id), r.name);
  for (const r of ta) out.set(toRef("task", r.id), `the task "${r.name}"`);
  for (const r of de) out.set(toRef("decision", r.id), `the decision "${r.name}"`);
  return out;
}

const day = (d: Date | string | null | undefined) => (d ? formatLong(d) : null);
const line = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" | ");
const clip = (s: string | null | undefined, n = 1200) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : null);

/** Loads model-ready text for the given refs. Hidden refs are silently dropped. */
export async function loadVisibleDocs(scope: AiScope, refList: string[]): Promise<AiDoc[]> {
  const v = filters(scope.grants);
  const refs = refList.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  const ids = (t: RefType) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];

  const [tasks, projects, people, orgs, decisions, notes, facts] = await Promise.all([
    ids("task").length ? db.select().from(tasksTable).where(and(inArray(tasksTable.id, ids("task")), v.task)) : [],
    ids("project").length ? db.select().from(projectsTable).where(and(inArray(projectsTable.id, ids("project")), v.project)) : [],
    ids("person").length ? db.select().from(peopleTable).where(and(inArray(peopleTable.id, ids("person")), v.person)) : [],
    ids("organisation").length
      ? db.select().from(organisationsTable).where(and(inArray(organisationsTable.id, ids("organisation")), v.organisation))
      : [],
    ids("decision").length ? db.select().from(decisionsTable).where(and(inArray(decisionsTable.id, ids("decision")), v.decision)) : [],
    ids("note").length ? db.select().from(notesTable).where(and(inArray(notesTable.id, ids("note")), v.note)) : [],
    ids("fact").length
      ? db.select().from(factsTable).where(and(inArray(factsTable.id, ids("fact")), isNull(factsTable.supersededBy), v.fact))
      : [],
  ]);

  const nameRefs: { type: RefType; id: number }[] = [];
  for (const t of tasks) {
    if (t.projectId) nameRefs.push({ type: "project", id: t.projectId });
    if (t.personId) nameRefs.push({ type: "person", id: t.personId });
    if (t.waitingOnPersonId) nameRefs.push({ type: "person", id: t.waitingOnPersonId });
  }
  for (const p of people) if (p.organisationId) nameRefs.push({ type: "organisation", id: p.organisationId });
  for (const d of decisions) nameRefs.push({ type: "project", id: d.projectId });
  for (const n of [...notes, ...facts]) {
    const r = parseRef(`${n.entityType}:${n.entityId}`);
    if (r) nameRefs.push(r);
  }
  const names = await visibleNames(nameRefs, scope.grants);
  const name = (t: RefType, id: number | null) => (id ? (names.get(toRef(t, id)) ?? null) : null);

  const docs: AiDoc[] = [];
  for (const t of tasks) {
    const project = name("project", t.projectId);
    const person = name("person", t.personId);
    const waitingOn = name("person", t.waitingOnPersonId);
    const ref = toRef("task", t.id);
    docs.push({
      ref,
      type: "task",
      id: t.id,
      text: [
        `[${ref}] ${t.kind === "promise" ? "Promise Ollie made" : "Task"}: ${t.title}`,
        line([
          `Status: ${STATUS_LABELS[t.status]}`,
          `Priority: ${PRIORITY_LABELS[t.priority]}`,
          t.dueDate && `Due: ${day(t.dueDate)}`,
          person && `For: ${person}`,
          waitingOn && `Waiting on: ${waitingOn}${t.waitingSince ? ` since ${day(t.waitingSince)}` : ""}`,
          project && `Project: ${project}`,
          t.completedAt && `Completed: ${day(t.completedAt)}`,
        ]),
        line([
          `Source: ${SOURCE_LABELS[t.source]}`,
          t.sourceSubject && `"${t.sourceSubject}"`,
          t.fromName && `from ${t.fromName}`,
          `captured ${day(t.capturedAt ?? t.createdAt)}`,
        ]),
        t.sourceQuote && `Quote: ${clip(t.sourceQuote, 600)}`,
        t.notes && `Notes: ${clip(t.notes)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const p of projects) {
    const ref = toRef("project", p.id);
    docs.push({
      ref,
      type: "project",
      id: p.id,
      text: [`[${ref}] Project: ${p.name}`, line([p.area && `Area: ${p.area}`, p.status && `Status: ${p.status}`, `Updated ${day(p.updatedAt)}`]), p.summary && `Summary: ${clip(p.summary)}`]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const p of people) {
    const ref = toRef("person", p.id);
    docs.push({
      ref,
      type: "person",
      id: p.id,
      text: [
        `[${ref}] Person: ${p.name}`,
        line([name("organisation", p.organisationId) && `Organisation: ${name("organisation", p.organisationId)}`, p.role && `Role: ${p.role}`, p.email && `Email: ${p.email}`, p.lastContactAt && `Last contact: ${day(p.lastContactAt)}`]),
        p.relationshipSummary && `Relationship: ${clip(p.relationshipSummary)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const o of orgs) {
    const ref = toRef("organisation", o.id);
    docs.push({
      ref,
      type: "organisation",
      id: o.id,
      text: [`[${ref}] Organisation: ${o.name}`, o.type && `Type: ${o.type}`, o.summary && `Summary: ${clip(o.summary)}`].filter(Boolean).join("\n"),
    });
  }
  for (const d of decisions) {
    const ref = toRef("decision", d.id);
    const project = name("project", d.projectId);
    docs.push({
      ref,
      type: "decision",
      id: d.id,
      text: `[${ref}] Decision${project ? ` on ${project}` : ""}, ${day(d.decidedAt)}${d.decidedBy ? `, by ${d.decidedBy}` : ""}: ${d.text}`,
    });
  }
  for (const n of notes) {
    const ref = toRef("note", n.id);
    const about = names.get(`${n.entityType}:${n.entityId}`);
    docs.push({
      ref,
      type: "note",
      id: n.id,
      text: `[${ref}] Note${about ? ` about ${about}` : ""}, ${day(n.updatedAt)}${n.title ? `: ${n.title}` : ""}\n${clip(n.body)}`,
    });
  }
  for (const f of facts) {
    const ref = toRef("fact", f.id);
    const about = names.get(`${f.entityType}:${f.entityId}`);
    docs.push({ ref, type: "fact", id: f.id, text: `[${ref}] Fact${about ? ` about ${about}` : ""}: ${f.text}` });
  }

  const order = new Map(refList.map((r, i) => [r, i]));
  return docs.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));
}

/** Refs of everything that hangs off a project, person or organisation, newest first. Visibility is applied when loading. */
async function expandEntity(type: SearchType, id: number): Promise<string[]> {
  const since = new Date(Date.now() - RECENT_DONE_DAYS * 24 * 60 * 60 * 1000);
  const openOrRecent = or(
    inArray(tasksTable.status, ["inbox", "now", "backlog", "waiting"]),
    and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, since)),
  );
  const out: string[] = [];
  const entityItems = async (et: "project" | "person" | "organisation") => {
    const [facts, notes, links] = await Promise.all([
      db
        .select({ id: factsTable.id })
        .from(factsTable)
        .where(and(eq(factsTable.entityType, et), eq(factsTable.entityId, id), isNull(factsTable.supersededBy))),
      db
        .select({ id: notesTable.id })
        .from(notesTable)
        .where(and(eq(notesTable.entityType, et), eq(notesTable.entityId, id)))
        .orderBy(desc(notesTable.updatedAt))
        .limit(8),
      db
        .select()
        .from(linksTable)
        .where(or(and(eq(linksTable.fromType, et), eq(linksTable.fromId, id)), and(eq(linksTable.toType, et), eq(linksTable.toId, id)))),
    ]);
    out.push(...facts.map((f) => toRef("fact", f.id)), ...notes.map((n) => toRef("note", n.id)));
    for (const l of links) {
      const other = l.fromType === et && l.fromId === id ? `${l.toType}:${l.toId}` : `${l.fromType}:${l.fromId}`;
      if (parseRef(other)) out.push(other);
    }
  };

  if (type === "project") {
    const [tasks, decisions] = await Promise.all([
      db.select({ id: tasksTable.id }).from(tasksTable).where(and(eq(tasksTable.projectId, id), openOrRecent)).orderBy(desc(tasksTable.updatedAt)).limit(20),
      db.select({ id: decisionsTable.id }).from(decisionsTable).where(eq(decisionsTable.projectId, id)).orderBy(desc(decisionsTable.decidedAt)).limit(10),
    ]);
    out.push(...tasks.map((t) => toRef("task", t.id)), ...decisions.map((d) => toRef("decision", d.id)));
    await entityItems("project");
  } else if (type === "person") {
    const tasks = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(or(eq(tasksTable.personId, id), eq(tasksTable.waitingOnPersonId, id)), openOrRecent))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(20);
    out.push(...tasks.map((t) => toRef("task", t.id)));
    const [p] = await db.select({ org: peopleTable.organisationId }).from(peopleTable).where(eq(peopleTable.id, id));
    if (p?.org) out.push(toRef("organisation", p.org));
    await entityItems("person");
  } else if (type === "organisation") {
    const people = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.organisationId, id)).limit(15);
    out.push(...people.map((p) => toRef("person", p.id)));
    await entityItems("organisation");
  }
  return out;
}

export interface Retrieval {
  docs: AiDoc[];
  /** True when the same search, run without the filter, would also have matched hidden items. Shown only to Ollie. */
  hiddenMatches: boolean;
  /**
   * The hidden items that matched, as the refs a grant would name (a fact maps to the item it hangs off).
   * Used only by Ollie's "Allow for this question"; never passed to the model.
   */
  hiddenRefs: string[];
}

/** The ref a grant would name to unlock a hidden search hit. Facts have no flag of their own, so their entity is granted. */
function grantRefFor(h: SearchHit): string | null {
  if (h.type === "fact") {
    return h.entityType && h.entityId != null && ["project", "person", "organisation", "task", "decision"].includes(h.entityType)
      ? `${h.entityType}:${h.entityId}`
      : null;
  }
  return toRef(h.type, h.id);
}

/** Ask OllieOS retrieval: search through the filter, expand the strongest matching entities, and load the visible items. */
export async function retrieveForAsk(scope: AiScope, question: string, carryRefs: string[] = []): Promise<Retrieval> {
  const [visible, all] = await Promise.all([
    searchItems({ q: question, mode: "ask", visibleOnly: true, scope, limitPerType: 12 }),
    searchItems({ q: question, mode: "ask", visibleOnly: false, scope, limitPerType: 12 }),
  ]);
  const hiddenHits = all.filter((h) => h.hiddenFromAi);
  const hiddenMatches = hiddenHits.length > 0;
  const hiddenRefs = [...new Set(hiddenHits.map(grantRefFor).filter((r): r is string => !!r))].slice(0, 10);

  const refs: string[] = [...carryRefs];
  const entities = visible.filter((h) => h.type === "project" || h.type === "person" || h.type === "organisation").slice(0, EXPAND_ENTITIES);
  for (const h of visible) refs.push(toRef(h.type, h.id));
  for (const e of entities) refs.push(...(await expandEntity(e.type, e.id)));

  const unique = [...new Set(refs)].slice(0, MAX_DOCS * 2);
  const docs = (await loadVisibleDocs(scope, unique)).slice(0, MAX_DOCS);
  return { docs, hiddenMatches, hiddenRefs };
}
