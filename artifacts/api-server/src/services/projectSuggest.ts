/**
 * Project suggestions for a task with no project (build plan section 27). Most tasks arrived with
 * no project, because the readers only link one when the message clearly names it. This offers up
 * to three to pick with one tap, worked out without AI from:
 *
 * - other tasks from the same email thread, Slack conversation, meeting or Cowork session;
 * - the projects of the Cowork session it came from;
 * - what the person it is with (or from) is usually about: their other tasks and their links;
 * - a project whose name appears in the task's title, subject or quote.
 */
import { and, desc, eq, inArray, isNotNull, like, ne, or } from "drizzle-orm";
import { coworkSessionsTable, db, linksTable, projectsTable, tasksTable } from "@workspace/db";
import { lexemesOf } from "./duplicates";
import { loadTask } from "./tasks";
import type { EntitySummary } from "./taskView";

const MAX = 3;
/** Section 30, Part H: a project is filled in by itself at this score or more, and only when it is this far ahead of the next. */
const STRONG = 3;
const CLEAR_BY = 2;

export async function projectSuggestionsFor(taskId: number): Promise<EntitySummary[]> {
  return (await scoredProjectsFor(taskId)).slice(0, MAX).map((x) => x.project);
}

/**
 * The one project a task clearly belongs to, or null: other tasks from the same thread, meeting or
 * session are on it, or the session is, or the task names it and the person is usually about it;
 * and no other project comes close. Two candidates of similar weight are left as chips for Ollie.
 */
export async function strongProjectFor(taskId: number): Promise<EntitySummary | null> {
  const [top, next] = await scoredProjectsFor(taskId);
  if (!top || top.score < STRONG) return null;
  if (next && top.score - next.score < CLEAR_BY) return null;
  return top.project;
}

async function scoredProjectsFor(taskId: number): Promise<{ project: EntitySummary; score: number }[]> {
  const t = await loadTask(taskId);
  if (t.projectId != null) return [];
  const score = new Map<number, number>();
  const add = (id: number | null | undefined, n: number) => {
    if (id != null) score.set(id, (score.get(id) ?? 0) + n);
  };

  // The same conversation, thread, meeting or session.
  const slackConv = t.source === "slack" ? /^(slack:[^:]+):/.exec(t.sourceRef ?? "")?.[1] : null;
  const sessionKey = t.source === "session" ? /^(session:\d+)/.exec(t.sourceRef ?? "")?.[1] : null;
  const sameWhere = slackConv
    ? like(tasksTable.sourceRef, `${slackConv}:%`)
    : sessionKey
      ? like(tasksTable.sourceRef, `${sessionKey}#%`)
      : t.sourceUrl
        ? eq(tasksTable.sourceUrl, t.sourceUrl)
        : null;
  if (sameWhere) {
    const rows = await db.select({ projectId: tasksTable.projectId }).from(tasksTable).where(and(sameWhere, ne(tasksTable.id, t.id), isNotNull(tasksTable.projectId))).limit(30);
    for (const r of rows) add(r.projectId, 3);
  }
  if (sessionKey) {
    const [s] = await db.select({ projectIds: coworkSessionsTable.projectIds }).from(coworkSessionsTable).where(eq(coworkSessionsTable.id, Number(sessionKey.split(":")[1])));
    for (const id of s?.projectIds ?? []) add(id, 3);
  }

  // What the person is usually about.
  const people = [t.personId, t.waitingOnPersonId].filter((x): x is number => x != null);
  const from = t.fromAddress ?? (t.fromName && !/^(you|ollie)$/i.test(t.fromName) ? t.fromName : null);
  const withPerson = or(
    people.length ? inArray(tasksTable.personId, people) : undefined,
    people.length ? inArray(tasksTable.waitingOnPersonId, people) : undefined,
    t.fromAddress ? eq(tasksTable.fromAddress, t.fromAddress) : from ? eq(tasksTable.fromName, from) : undefined,
  );
  if (withPerson) {
    const rows = await db
      .select({ projectId: tasksTable.projectId })
      .from(tasksTable)
      .where(and(withPerson, ne(tasksTable.id, t.id), isNotNull(tasksTable.projectId)))
      .orderBy(desc(tasksTable.createdAt))
      .limit(40);
    const seen = new Map<number, number>();
    for (const r of rows) seen.set(r.projectId!, (seen.get(r.projectId!) ?? 0) + 1);
    for (const [id, n] of seen) add(id, Math.min(n, 3));
  }
  if (people.length) {
    const links = await db
      .select({ a: linksTable.fromType, aId: linksTable.fromId, b: linksTable.toType, bId: linksTable.toId })
      .from(linksTable)
      .where(
        or(
          and(eq(linksTable.fromType, "person"), inArray(linksTable.fromId, people), eq(linksTable.toType, "project")),
          and(eq(linksTable.toType, "person"), inArray(linksTable.toId, people), eq(linksTable.fromType, "project")),
        ),
      )
      .limit(40);
    for (const l of links) add(l.a === "project" ? l.aId : l.bId, 2);
  }

  // A project named in the task's own words.
  const projects = await db
    .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, confidential: projectsTable.confidential })
    .from(projectsTable)
    .where(and(eq(projectsTable.archived, false), eq(projectsTable.lifecycle, "active")))
    .limit(300);
  if (!projects.length) return [];
  const text = [t.title, t.sourceSubject ?? "", t.sourceQuote ?? "", (t.snippet ?? "").slice(0, 600)].join("\n");
  const [words, ...names] = await lexemesOf([text, ...projects.map((p) => p.name)]);
  const have = new Set(words);
  for (const [i, p] of projects.entries()) {
    const lex = names[i] ?? [];
    if (lex.length && lex.every((w) => have.has(w))) add(p.id, 2 + Math.min(lex.length, 2));
  }

  const byId = new Map(projects.map((p) => [p.id, p]));
  return [...score.entries()]
    .filter(([id]) => byId.has(id))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([id, score]) => ({ project: byId.get(id)!, score }));
}
