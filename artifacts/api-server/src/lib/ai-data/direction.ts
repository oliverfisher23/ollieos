/**
 * AI reads for milestone 7: goals, overdue contacts, documents and rules (features 04 to 07).
 * Same rules as context.ts: the visibility filter in every WHERE clause, a second check with
 * sanitiseRefs, and every item handed out logged with recordReads.
 * A confidential goal's target text is never sent; its name and statement are.
 */
import { and, asc, desc, inArray, sql } from "drizzle-orm";
import { db, documentsTable, goalsTable, linksTable, organisationsTable, peopleTable, productsTable, rulesTable, projectsTable } from "@workspace/db";
import { CADENCE_LABELS, OPEN_STATUSES, addDays, todayLondon, toRef, weekStartOf, type Cadence, type DocLocation } from "@workspace/shared";
import { documentVisible, organisationVisible, personVisible, productVisible, ruleVisible, projectVisible, taskVisible } from "./visibility";
import { productsLinkedToRefs } from "./playbooks";
import { recordReads, sanitiseRefs, type AiScope } from "./scope";
import { applicableRuleRefs } from "./retrieve";
import { buildTsQuery } from "./search";
import type { NamedRef } from "./context";
import { projectsForPeople, stateFor } from "../../services/cadence";

/* ---------- Goals ---------- */

export interface GoalOut {
  ref: string;
  name: string;
  statement: string | null;
  /** Left out when the goal is confidential */
  target_text?: string | null;
  confidential: boolean;
  period_start: string | null;
  period_end: string | null;
  sub_goals: { ref: string; name: string; statement: string | null; target_text?: string | null }[];
  projects: NamedRef[];
  open_tasks: number;
  due_this_week: number;
}

/** list_goals: Ollie's goals with their visible projects and counts of visible open work. */
export async function goalsForAi(scope: AiScope): Promise<{ goals: GoalOut[] }> {
  const g = scope.grants;
  const weekEnd = addDays(weekStartOf(todayLondon()), 6);
  const [goals, projects, counts] = await Promise.all([
    db.select().from(goalsTable).orderBy(asc(goalsTable.sortOrder), asc(goalsTable.id)),
    db
      .select({ id: projectsTable.id, name: projectsTable.name, goalId: projectsTable.goalId })
      .from(projectsTable)
      .where(and(sql`${projectsTable.goalId} is not null and not ${projectsTable.archived}`, sql.raw(projectVisible("projects", g))))
      .orderBy(asc(projectsTable.name)),
    db.execute(sql`
      select coalesce(g.parent_id, g.id) as goal_id, count(*)::int as open,
             count(*) filter (where t.due_date <= ${weekEnd})::int as due
      from tasks t
      join goals g on g.id = coalesce(t.goal_id, (select p.goal_id from projects p where p.id = t.project_id))
      where t.status in (${sql.join([...OPEN_STATUSES].map((s) => sql`${s}`), sql`, `)}) and ${sql.raw(taskVisible("t", g))}
      group by 1`),
  ]);
  const countBy = new Map((counts.rows as { goal_id: number; open: number; due: number }[]).map((r) => [Number(r.goal_id), r]));
  const target = (x: { confidential: boolean; targetText: string | null }) => (x.confidential ? {} : { target_text: x.targetText });
  const out = goals
    .filter((x) => x.parentId == null)
    .map((x): GoalOut => {
      const subs = goals.filter((s) => s.parentId === x.id);
      const ids = new Set([x.id, ...subs.map((s) => s.id)]);
      const c = countBy.get(x.id);
      return {
        ref: toRef("goal", x.id),
        name: x.name,
        statement: x.statement,
        ...target(x),
        confidential: x.confidential,
        period_start: x.periodStart,
        period_end: x.periodEnd,
        // A sub-goal's target is withheld when it or its parent is confidential.
        sub_goals: subs.map((s) => ({ ref: toRef("goal", s.id), name: s.name, statement: s.statement, ...target({ ...s, confidential: s.confidential || x.confidential }) })),
        projects: projects.filter((p) => ids.has(p.goalId!)).map((p) => ({ ref: toRef("project", p.id), name: p.name })),
        open_tasks: c?.open ?? 0,
        due_this_week: c?.due ?? 0,
      };
    });
  await recordReads(scope, [...out.map((x) => x.ref), ...out.flatMap((x) => x.sub_goals.map((s) => s.ref))], { via: "list_goals" });
  return { goals: out };
}

/** The goal a project is linked to, by name. */
export async function goalForProject(goalId: number | null): Promise<NamedRef | null> {
  if (!goalId) return null;
  const [x] = await db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(sql`${goalsTable.id} = ${goalId}`);
  return x ? { ref: toRef("goal", x.id), name: x.name } : null;
}

/* ---------- Overdue contacts ---------- */

export interface OverdueContactOut {
  ref: string;
  name: string;
  organisation: string | null;
  role: string | null;
  cadence: string;
  status: "overdue" | "due_soon";
  last_contact_at: string | null;
  /** Null when there is no contact on file */
  days_overdue: number | null;
  days_left?: number | null;
  project: NamedRef | null;
}

/** list_overdue_contacts: visible people past their cadence, most overdue first. Paused cadences are left out. */
export async function overdueContactsForAi(scope: AiScope, opts: { includeDueSoon?: boolean; limit?: number } = {}): Promise<{ people: OverdueContactOut[] }> {
  const g = scope.grants;
  const people = await db
    .select()
    .from(peopleTable)
    .where(and(sql`${peopleTable.cadence} <> 'none' and not ${peopleTable.isSelf} and not ${peopleTable.cadencePaused}`, sql.raw(personVisible("people", g))))
    .orderBy(asc(peopleTable.name));
  const projects = await projectsForPeople(people.map((p) => p.id));
  const overdue = people
    .map((p) => ({ p, state: stateFor(p, projects.get(p.id)) }))
    .filter((x) => x.state.status === "overdue" || (opts.includeDueSoon && x.state.status === "due_soon"))
    .sort(
      (a, b) =>
        (a.state.status === "overdue" ? 0 : 1) - (b.state.status === "overdue" ? 0 : 1) ||
        (b.state.daysOverdue ?? Infinity) - (a.state.daysOverdue ?? Infinity) ||
        (a.state.daysLeft ?? 0) - (b.state.daysLeft ?? 0),
    )
    .slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 200));

  const orgIds = [...new Set(overdue.map((x) => x.p.organisationId).filter((x): x is number => x != null))];
  const projectIds = [...new Set(overdue.flatMap((x) => (projects.get(x.p.id) ?? []).map((pr) => pr.id)))];
  const [orgs, visibleProjects] = await Promise.all([
    orgIds.length
      ? db.select({ id: organisationsTable.id, name: organisationsTable.name }).from(organisationsTable).where(and(inArray(organisationsTable.id, orgIds), sql.raw(organisationVisible("organisations", g))))
      : [],
    projectIds.length
      ? db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(and(inArray(projectsTable.id, projectIds), sql.raw(projectVisible("projects", g))))
      : [],
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const projectName = new Map(visibleProjects.map((p) => [p.id, p.name]));

  const contacts = overdue.map(({ p, state }): OverdueContactOut => {
    const shared = (projects.get(p.id) ?? []).find((pr) => pr.lifecycle === "active" && projectName.has(pr.id));
    return {
      ref: toRef("person", p.id),
      name: p.name,
      organisation: p.organisationId != null ? (orgName.get(p.organisationId) ?? null) : null,
      role: p.role,
      cadence: CADENCE_LABELS[p.cadence],
      status: state.status as "overdue" | "due_soon",
      last_contact_at: p.lastContactAt?.toISOString() ?? null,
      days_overdue: state.daysOverdue,
      ...(state.status === "due_soon" ? { days_left: state.daysLeft } : {}),
      project: shared ? { ref: toRef("project", shared.id), name: projectName.get(shared.id)! } : null,
    };
  });
  const ok = new Set(await sanitiseRefs(scope, contacts.map((c) => c.ref)));
  const out = contacts.filter((c) => ok.has(c.ref));
  await recordReads(scope, out.map((c) => c.ref), { via: "list_overdue_contacts" });
  return { people: out };
}

/** get_context for a person: their cadence and where it stands. */
export async function cadenceForAi(person: { id: number; cadence: Cadence; cadencePaused: boolean; lastContactAt: Date | null; isSelf: boolean }) {
  if (person.isSelf) return null;
  const projects = (await projectsForPeople([person.id])).get(person.id);
  const state = stateFor(person, projects);
  return {
    cadence: CADENCE_LABELS[person.cadence],
    cadence_status: state.status,
    ...(state.daysOverdue != null ? { days_overdue: state.daysOverdue } : {}),
    ...(state.daysLeft != null ? { days_left: state.daysLeft } : {}),
  };
}

/* ---------- Documents ---------- */

export interface DocumentOut {
  ref: string;
  title: string;
  url: string | null;
  location: DocLocation;
  summary: string | null;
  /** When Ollie or the sweep last confirmed it, not the file's own date */
  updated_at: string;
  projects: NamedRef[];
}

async function linkedProjectNames(scope: AiScope, type: "document" | "rule", ids: number[]): Promise<Map<number, NamedRef[]>> {
  // Projects, organisations and (Part M) products the item is linked to, where the client may see them.
  const out = new Map<number, NamedRef[]>();
  if (!ids.length) return out;
  const rows = await db
    .select({ fromType: linksTable.fromType, fromId: linksTable.fromId, toType: linksTable.toType, toId: linksTable.toId })
    .from(linksTable)
    .where(
      sql`(${linksTable.fromType} = ${type} and ${inArray(linksTable.fromId, ids)} and ${linksTable.toType} in ('project', 'organisation', 'product'))
        or (${linksTable.toType} = ${type} and ${inArray(linksTable.toId, ids)} and ${linksTable.fromType} in ('project', 'organisation', 'product'))`,
    );
  const pairs = rows.map((r) => (r.fromType === type ? { item: r.fromId, type: r.toType, id: r.toId } : { item: r.toId, type: r.fromType, id: r.fromId }));
  const pIds = [...new Set(pairs.filter((x) => x.type === "project").map((x) => x.id))];
  const oIds = [...new Set(pairs.filter((x) => x.type === "organisation").map((x) => x.id))];
  const prIds = [...new Set(pairs.filter((x) => x.type === "product").map((x) => x.id))];
  const g = scope.grants;
  const [ps, os, prs] = await Promise.all([
    pIds.length ? db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(and(inArray(projectsTable.id, pIds), sql.raw(projectVisible("projects", g)))) : [],
    oIds.length
      ? db.select({ id: organisationsTable.id, name: organisationsTable.name }).from(organisationsTable).where(and(inArray(organisationsTable.id, oIds), sql.raw(organisationVisible("organisations", g))))
      : [],
    prIds.length ? db.select({ id: productsTable.id, name: productsTable.name }).from(productsTable).where(and(inArray(productsTable.id, prIds), sql.raw(productVisible("products")))) : [],
  ]);
  const names = new Map<string, string>([
    ...ps.map((p) => [`project:${p.id}`, p.name] as [string, string]),
    ...os.map((o) => [`organisation:${o.id}`, o.name] as [string, string]),
    ...prs.map((p) => [`product:${p.id}`, p.name] as [string, string]),
  ]);
  for (const x of pairs) {
    const ref = `${x.type}:${x.id}`;
    const name = names.get(ref);
    if (!name) continue;
    if (!out.has(x.item)) out.set(x.item, []);
    out.get(x.item)!.push({ ref, name });
  }
  return out;
}

/** Documents through the filter: optionally only those matching a query or linked to one project. */
export async function documentsForAi(scope: AiScope, opts: { query?: string; projectId?: number; limit?: number; via: string }): Promise<DocumentOut[]> {
  const conds = [sql.raw(documentVisible("documents", scope.grants))];
  if (opts.projectId != null) {
    conds.push(sql`${documentsTable.id} in (
      select to_id from links where to_type = 'document' and from_type = 'project' and from_id = ${opts.projectId}
      union select from_id from links where from_type = 'document' and to_type = 'project' and to_id = ${opts.projectId})`);
  }
  const q = opts.query?.trim();
  if (q) {
    const tsq = buildTsQuery(q, "ask");
    const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    conds.push(tsq ? sql`(${documentsTable.search} @@ to_tsquery('english', ${tsq}) or ${documentsTable.title} ilike ${like})` : sql`${documentsTable.title} ilike ${like}`);
  }
  const rows = await db
    .select({
      id: documentsTable.id,
      title: documentsTable.title,
      url: documentsTable.url,
      location: documentsTable.location,
      summary: documentsTable.summary,
      lastConfirmedAt: documentsTable.lastConfirmedAt,
    })
    .from(documentsTable)
    .where(and(...conds))
    .orderBy(desc(documentsTable.lastConfirmedAt))
    .limit(Math.min(Math.max(opts.limit ?? 20, 1), 50));
  const ok = new Set(await sanitiseRefs(scope, rows.map((r) => toRef("document", r.id))));
  const kept = rows.filter((r) => ok.has(toRef("document", r.id)));
  const projects = await linkedProjectNames(scope, "document", kept.map((r) => r.id));
  return kept.map((r) => ({
    ref: toRef("document", r.id),
    title: r.title,
    url: r.url,
    location: r.location,
    summary: r.summary,
    updated_at: r.lastConfirmedAt.toISOString(),
    projects: (projects.get(r.id) ?? []).filter((p) => p.ref.startsWith("project:")),
  }));
}

/** find_documents */
export async function findDocumentsForAi(scope: AiScope, query: string | undefined, projectId: number | undefined, limit = 20): Promise<{ documents: DocumentOut[] }> {
  const documents = await documentsForAi(scope, { query, projectId, limit, via: "find_documents" });
  await recordReads(scope, documents.map((d) => d.ref), { via: "find_documents", ...(query ? { query: query.slice(0, 200) } : {}) }, query ? "search" : "read");
  return { documents };
}

/* ---------- Rules ---------- */

export interface RuleOut {
  ref: string;
  title: string;
  applies_when: string;
  rule: string;
  /** Empty when the rule applies everywhere */
  applies_to: NamedRef[];
}

async function ruleOuts(scope: AiScope, refs: string[]): Promise<RuleOut[]> {
  const ids = refs.map((r) => Number(r.split(":")[1]));
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(rulesTable)
    .where(and(inArray(rulesTable.id, ids), sql.raw(ruleVisible("rules", scope.grants))))
    .orderBy(asc(rulesTable.id));
  const ok = new Set(await sanitiseRefs(scope, rows.map((r) => toRef("rule", r.id))));
  const kept = rows.filter((r) => ok.has(toRef("rule", r.id)));
  const links = await linkedProjectNames(scope, "rule", kept.map((r) => r.id));
  return kept.map((r) => ({ ref: toRef("rule", r.id), title: r.title, applies_when: r.appliesWhen, rule: r.rule, applies_to: links.get(r.id) ?? [] }));
}

/**
 * Rules that apply in a context: global ones plus those linked to the given projects and
 * organisations. Without a context, every enabled visible rule.
 */
export async function rulesFor(scope: AiScope, contextRefs: string[] | null): Promise<RuleOut[]> {
  if (contextRefs) return ruleOuts(scope, await applicableRuleRefs(scope, contextRefs));
  const all = await db.select({ id: rulesTable.id }).from(rulesTable).where(sql.raw(ruleVisible("rules", scope.grants)));
  return ruleOuts(scope, all.map((r) => toRef("rule", r.id)));
}

/**
 * The projects, organisations and products whose rules apply to an item: a project and its linked
 * organisations; a person's organisation and their projects; an organisation itself; a product
 * itself. Products linked to those projects and organisations are added (Part M), so a product's
 * rules apply wherever it comes up.
 */
export async function ruleContextFor(type: "project" | "person" | "organisation" | "product", id: number): Promise<string[]> {
  if (type === "product") return [toRef("product", id)];
  const base = await baseRuleContext(type, id);
  const products = await productsLinkedToRefs(base);
  return [...base, ...products.map((p) => toRef("product", p.id))];
}

async function baseRuleContext(type: "project" | "person" | "organisation", id: number): Promise<string[]> {
  if (type === "organisation") return [toRef("organisation", id)];
  if (type === "project") {
    const res = await db.execute(sql`
      select to_id as id from links where from_type = 'project' and from_id = ${id} and to_type = 'organisation'
      union select from_id from links where to_type = 'project' and to_id = ${id} and from_type = 'organisation'`);
    return [toRef("project", id), ...(res.rows as { id: number }[]).map((r) => toRef("organisation", Number(r.id)))];
  }
  const [person] = await db.select({ organisationId: peopleTable.organisationId }).from(peopleTable).where(sql`${peopleTable.id} = ${id}`);
  const projects = (await projectsForPeople([id])).get(id) ?? [];
  return [...projects.map((p) => toRef("project", p.id)), ...(person?.organisationId ? [toRef("organisation", person.organisationId)] : [])];
}

/** get_playbooks: everything, global only ("general", given as []), or what applies to one item. Logged. */
export async function getRulesForAi(
  scope: AiScope,
  context: { type: "project" | "person" | "organisation" | "product"; id: number } | "general" | null,
  via = "get_rules",
): Promise<RuleOut[]> {
  const refs = context === null ? null : context === "general" ? [] : await ruleContextFor(context.type, context.id);
  const out = await rulesFor(scope, refs);
  await recordReads(scope, out.map((x) => x.ref), { via });
  return out;
}
