import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import {
  activityTable,
  coworkSessionsTable,
  db,
  decisionsTable,
  documentContentsTable,
  documentsTable,
  factsTable,
  goalsTable,
  ideasTable,
  linksTable,
  notesTable,
  organisationsTable,
  peopleTable,
  playbooksTable,
  projectsTable,
  strategySectionsTable,
  tasksTable,
} from "@workspace/db";
import { DOC_LOCATION_LABELS, PRIORITY_LABELS, SOURCE_LABELS, STATUS_LABELS, formatLong, parseRef, toRef, type RefType } from "@workspace/shared";
import {
  activityVisible,
  decisionVisible,
  documentVisible,
  factVisible,
  ideaVisible,
  noteVisible,
  organisationVisible,
  personVisible,
  playbookVisible,
  projectVisible,
  sessionArchived,
  sessionVisible,
  strategyVisible,
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

const ACTIVITY_LABELS: Record<string, string> = { email: "Email", meeting: "Meeting", slack: "Slack message", note: "Note", task: "Task update" };

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
    document: sql.raw(documentVisible("documents", g)),
    playbook: sql.raw(playbookVisible("playbooks", g)),
    activity: sql.raw(activityVisible("activity", g)),
    session: sql.raw(sessionVisible("cowork_sessions", g)),
    strategy: sql.raw(strategyVisible("strategy_sections", g)),
    idea: sql.raw(ideaVisible("ideas", g)),
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

const IDEA_STATUS_WORDS: Record<string, string> = { new: "New", come_back: "Come back to", taken_forward: "Taken forward", dropped: "Dropped" };

/** Goal names by id. Goals are always visible by name. */
async function goalNamesFor(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const day = (d: Date | string | null | undefined) => (d ? formatLong(d) : null);
const line = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" | ");
/** How much of a document's text goes to the AI with it */
const DOC_CONTENT_CHARS = 4000;
const clip = (s: string | null | undefined, n = 1200) => (s ? (s.length > n ? s.slice(0, n) + "…" : s) : null);

/** Loads model-ready text for the given refs. Hidden refs are silently dropped. */
export async function loadVisibleDocs(scope: AiScope, refList: string[]): Promise<AiDoc[]> {
  const v = filters(scope.grants);
  const refs = refList.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  const ids = (t: RefType) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];

  const [tasks, projects, people, orgs, decisions, notes, facts, goals, documents, playbooks, activity, sessions, sections, ideas] = await Promise.all([
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
    ids("goal").length ? db.select().from(goalsTable).where(inArray(goalsTable.id, ids("goal"))) : [],
    ids("document").length
      ? db
          .select({
            id: documentsTable.id,
            title: documentsTable.title,
            url: documentsTable.url,
            location: documentsTable.location,
            summary: documentsTable.summary,
            lastConfirmedAt: documentsTable.lastConfirmedAt,
            contents: documentContentsTable.text,
            contentsTruncated: documentContentsTable.truncated,
            contentsReadAt: documentContentsTable.readAt,
          })
          .from(documentsTable)
          .leftJoin(documentContentsTable, eq(documentContentsTable.documentId, documentsTable.id))
          .where(and(inArray(documentsTable.id, ids("document")), v.document))
      : [],
    ids("playbook").length ? db.select().from(playbooksTable).where(and(inArray(playbooksTable.id, ids("playbook")), v.playbook)) : [],
    ids("activity").length ? db.select().from(activityTable).where(and(inArray(activityTable.id, ids("activity")), v.activity)) : [],
    ids("session").length ? db.select().from(coworkSessionsTable).where(and(inArray(coworkSessionsTable.id, ids("session")), v.session)) : [],
    ids("strategy").length ? db.select().from(strategySectionsTable).where(and(inArray(strategySectionsTable.id, ids("strategy")), v.strategy)) : [],
    ids("idea").length ? db.select().from(ideasTable).where(and(inArray(ideasTable.id, ids("idea")), v.idea)) : [],
  ]);

  const nameRefs: { type: RefType; id: number }[] = [];
  for (const t of tasks) {
    if (t.projectId) nameRefs.push({ type: "project", id: t.projectId });
    if (t.personId) nameRefs.push({ type: "person", id: t.personId });
    if (t.waitingOnPersonId) nameRefs.push({ type: "person", id: t.waitingOnPersonId });
  }
  for (const p of people) if (p.organisationId) nameRefs.push({ type: "organisation", id: p.organisationId });
  for (const d of decisions) if (d.projectId != null) nameRefs.push({ type: "project", id: d.projectId });
  for (const s of sections) for (const id of s.projectIds) nameRefs.push({ type: "project", id });
  for (const i of ideas) {
    if (i.projectId) nameRefs.push({ type: "project", id: i.projectId });
    if (i.takenProjectId) nameRefs.push({ type: "project", id: i.takenProjectId });
    if (i.takenTaskId) nameRefs.push({ type: "task", id: i.takenTaskId });
  }
  for (const s of sessions) {
    for (const id of s.projectIds) nameRefs.push({ type: "project", id });
    for (const id of s.personIds) nameRefs.push({ type: "person", id });
  }
  for (const n of [...notes, ...facts, ...activity]) {
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
      text: [`[${ref}] Organisation: ${o.name}`, o.internal ? "Internal: Ollie's own company; people here are his colleagues" : "External", o.type && `Type: ${o.type}`, o.summary && `Summary: ${clip(o.summary)}`].filter(Boolean).join("\n"),
    });
  }
  for (const d of decisions) {
    const ref = toRef("decision", d.id);
    const project = d.projectId != null ? name("project", d.projectId) : null;
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
    docs.push({
      ref,
      type: "fact",
      id: f.id,
      text: `[${ref}] Fact${about ? ` about ${about}` : ""}${f.needsCheck ? " (NEEDS A CHECK: may be out of date)" : ""}: ${f.text}`,
    });
  }

  for (const a of activity) {
    const ref = toRef("activity", a.id);
    const about = a.entityType ? names.get(`${a.entityType}:${a.entityId}`) : undefined;
    docs.push({
      ref,
      type: "activity",
      id: a.id,
      text: `[${ref}] ${ACTIVITY_LABELS[a.kind] ?? "Activity"}${about ? ` with ${about}` : ""}, ${day(a.occurredAt)}: ${clip(a.summary, 800)}`,
    });
  }

  for (const s of sessions) {
    const ref = toRef("session", s.id);
    const touched = [...s.projectIds.map((id) => name("project", id)), ...s.personIds.map((id) => name("person", id))].filter(Boolean);
    docs.push({
      ref,
      type: "session",
      id: s.id,
      text: [
        `[${ref}] Cowork session with Claude, ${day(s.happenedAt)}: ${s.title}`,
        touched.length && `About: ${touched.join(", ")}`,
        `Summary: ${clip(s.summary, 800)}`,
        s.outcomes.length && `What was done:\n${s.outcomes.slice(0, 12).map((o) => `- ${clip(o, 200)}`).join("\n")}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const goalNames = await goalNamesFor([...sections.flatMap((s) => s.goalIds), ...ideas.map((i) => i.goalId).filter((x): x is number => x != null)]);
  for (const s of sections) {
    const ref = toRef("strategy", s.id);
    const drives = [...s.goalIds.map((id) => goalNames.get(id)), ...s.projectIds.map((id) => name("project", id))].filter(Boolean);
    docs.push({
      ref,
      type: "strategy",
      id: s.id,
      text: [`[${ref}] Ollie's strategy, section "${s.name}" (updated ${day(s.updatedAt)})`, drives.length && `Drives: ${drives.join(", ")}`, s.body.trim() ? clip(s.body, 4000) : "(empty)"]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const i of ideas) {
    const ref = toRef("idea", i.id);
    const linked = [i.goalId != null && goalNames.get(i.goalId), name("project", i.projectId)].filter(Boolean);
    const became = i.takenTaskId ? name("task", i.takenTaskId) : i.takenProjectId ? name("project", i.takenProjectId) : null;
    docs.push({
      ref,
      type: "idea",
      id: i.id,
      text: [
        `[${ref}] Idea${i.source === "ollie" ? "" : " (added by Claude)"}, ${day(i.createdAt)}: ${i.title}`,
        line([`Status: ${IDEA_STATUS_WORDS[i.status]}`, i.status === "come_back" && i.comeBackOn && `Come back on ${day(i.comeBackOn)}`, became && `Became ${became}`, linked.length > 0 && `Linked to: ${linked.join(", ")}`]),
        i.notes && `Notes: ${clip(i.notes, 2000)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  const parentNames = new Map(goals.map((g) => [g.id, g.name]));
  const missingParents = goals.map((g) => g.parentId).filter((p): p is number => p != null && !parentNames.has(p));
  if (missingParents.length) {
    for (const p of await db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, missingParents))) parentNames.set(p.id, p.name);
  }
  for (const g of goals) {
    const ref = toRef("goal", g.id);
    docs.push({
      ref,
      type: "goal",
      id: g.id,
      // A confidential goal's target text is never sent (feature 04 rule 2).
      text: [
        `[${ref}] ${g.parentId ? `Sub-goal of ${parentNames.get(g.parentId) ?? "a goal"}` : "Goal"}: ${g.name}`,
        g.statement && `Statement: ${clip(g.statement, 600)}`,
        !g.confidential && g.targetText && `Target: ${clip(g.targetText, 600)}`,
        (g.periodStart || g.periodEnd) && line([g.periodStart && `From ${day(g.periodStart)}`, g.periodEnd && `to ${day(g.periodEnd)}`]),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const d of documents) {
    const ref = toRef("document", d.id);
    docs.push({
      ref,
      type: "document",
      id: d.id,
      text: [
        `[${ref}] Document: ${d.title}`,
        line([`Location: ${DOC_LOCATION_LABELS[d.location]}`, `Link: ${d.url}`, `Updated ${day(d.lastConfirmedAt)}`]),
        d.summary && `Summary: ${clip(d.summary, 800)}`,
        d.contents &&
          `Contents (read from Google Drive ${day(d.contentsReadAt!)}${d.contentsTruncated || d.contents.length > DOC_CONTENT_CHARS ? ", start only" : ""}):\n${clip(d.contents, DOC_CONTENT_CHARS)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }
  for (const p of playbooks) {
    const ref = toRef("playbook", p.id);
    docs.push({ ref, type: "playbook", id: p.id, text: `[${ref}] Playbook (Ollie's standing rule): ${p.title}. Applies when: ${p.appliesWhen}. Rule: ${p.rule}` });
  }

  const order = new Map(refList.map((r, i) => [r, i]));
  return docs.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));
}

/** The latest sessions that touched a project or person, not archived. Visibility is applied when loading. */
async function recentSessions(type: "project" | "person", id: number, limit = 3): Promise<string[]> {
  const rows = await db
    .select({ id: coworkSessionsTable.id })
    .from(coworkSessionsTable)
    .where(and(sql`${id} = any(${type === "project" ? coworkSessionsTable.projectIds : coworkSessionsTable.personIds})`, sql.raw(`not ${sessionArchived("cowork_sessions")}`)))
    .orderBy(desc(coworkSessionsTable.happenedAt))
    .limit(limit);
  return rows.map((r) => toRef("session", r.id));
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
    out.push(...tasks.map((t) => toRef("task", t.id)), ...decisions.map((d) => toRef("decision", d.id)), ...(await recentSessions("project", id)));
    await entityItems("project");
  } else if (type === "person") {
    const tasks = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(or(eq(tasksTable.personId, id), eq(tasksTable.waitingOnPersonId, id)), openOrRecent))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(20);
    out.push(...tasks.map((t) => toRef("task", t.id)), ...(await recentSessions("person", id)));
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
  // Documents and sessions have no grants of their own; they unlock through their project.
  if (h.type === "document" || h.type === "session" || h.type === "strategy" || h.type === "idea") return null;
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

  const unique = [...new Set(refs)].filter((r) => !r.startsWith("playbook:")).slice(0, MAX_DOCS * 2);
  const docs = (await loadVisibleDocs(scope, unique)).slice(0, MAX_DOCS);
  // Playbooks that apply are always included, outside the item cap (feature 07 rule 2). With no items
  // there is nothing to answer from, so none are added.
  if (!docs.length) return { docs, hiddenMatches, hiddenRefs };
  const playbooks = await loadVisibleDocs(scope, await applicablePlaybookRefs(scope, docs.map((d) => d.ref)));
  return { docs: [...playbooks, ...docs], hiddenMatches, hiddenRefs };
}

/**
 * Enabled, visible playbooks that apply given the items in play: global ones, plus those linked to
 * any project or organisation among the refs.
 */
export async function applicablePlaybookRefs(scope: AiScope, refList: readonly string[]): Promise<string[]> {
  const refs = refList.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  const projects = [...new Set(refs.filter((r) => r.type === "project").map((r) => r.id))];
  const orgs = [...new Set(refs.filter((r) => r.type === "organisation").map((r) => r.id))];
  const idList = (xs: number[]) => (xs.length ? sql.join(xs.map((x) => sql`${x}`), sql`, `) : sql`null`);
  const res = await db.execute(sql`
    select pb.id from playbooks pb
    where ${sql.raw(playbookVisible("pb", scope.grants))} and (
      not exists (select 1 from links l where (l.from_type = 'playbook' and l.from_id = pb.id and l.to_type in ('project', 'organisation'))
                                        or (l.to_type = 'playbook' and l.to_id = pb.id and l.from_type in ('project', 'organisation')))
      or exists (select 1 from links l where (l.from_type = 'playbook' and l.from_id = pb.id and l.to_type = 'project' and l.to_id in (${idList(projects)}))
                                        or (l.to_type = 'playbook' and l.to_id = pb.id and l.from_type = 'project' and l.from_id in (${idList(projects)})))
      or exists (select 1 from links l where (l.from_type = 'playbook' and l.from_id = pb.id and l.to_type = 'organisation' and l.to_id in (${idList(orgs)}))
                                        or (l.to_type = 'playbook' and l.to_id = pb.id and l.from_type = 'organisation' and l.from_id in (${idList(orgs)})))
    )
    order by pb.id`);
  return (res.rows as { id: number }[]).map((r) => toRef("playbook", Number(r.id)));
}
