/**
 * The parts of the business: Delivery, Product, Sales and Marketing (asked for 11th November 2026).
 * Each function has one record in the projects table, marked is_function, so its own documents,
 * facts, decisions, tasks and rules work exactly as a project's do. Every other project can belong to
 * one function, and its clients are the organisations linked to it that are typed customer, client
 * or partner.
 */
import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { BUSINESS_FUNCTIONS, BUSINESS_FUNCTION_LABELS, CLIENT_ORG_TYPES, OPEN_STATUSES, type BusinessFunction, type ProjectLifecycle } from "@workspace/shared";
import { writeAudit } from "../../lib/audit";
import { uniqueSlug } from "./common";

/** Project names that already were a function before functions existed, and become its record. */
const FORMER_NAMES: Record<BusinessFunction, string[]> = {
  delivery: ["delivery"],
  product: ["product"],
  sales: ["sales", "go-to-market", "go to market", "gtm"],
  marketing: ["marketing"],
};

/**
 * Makes sure each function has its record. A missing one takes over an existing project of the same
 * name (Ollie agreed his Delivery, Product and Go-to-market projects become functions, keeping
 * everything on them), or is created. Safe to run any number of times.
 */
export async function ensureFunctions(): Promise<void> {
  const have = await db.select({ fn: projectsTable.function }).from(projectsTable).where(eq(projectsTable.isFunction, true));
  const missing = BUSINESS_FUNCTIONS.filter((f) => !have.some((h) => h.fn === f));
  if (!missing.length) return;
  for (const fn of missing) {
    await db
      .transaction(async (tx) => {
        const label = BUSINESS_FUNCTION_LABELS[fn];
        const [former] = await tx
          .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug })
          .from(projectsTable)
          .where(and(eq(projectsTable.isFunction, false), eq(projectsTable.archived, false), inArray(sql`lower(${projectsTable.name})`, FORMER_NAMES[fn])))
          .orderBy(projectsTable.id)
          .limit(1);
        if (former) {
          const slug = former.name === label ? former.slug : await uniqueSlug(tx, "project", label, former.id);
          await tx.update(projectsTable).set({ isFunction: true, function: fn, name: label, slug, lifecycle: "active" }).where(eq(projectsTable.id, former.id));
          await writeAudit(tx, { actor: "ollie", action: "migrate", entityType: "project", entityId: former.id, payload: { change: "project became a function", function: fn, from: former.name } });
          return;
        }
        const slug = await uniqueSlug(tx, "project", label);
        const [row] = await tx.insert(projectsTable).values({ name: label, slug, isFunction: true, function: fn }).returning({ id: projectsTable.id });
        await writeAudit(tx, { actor: "ollie", action: "create", entityType: "project", entityId: row.id, payload: { name: label, function: fn } });
      })
      // Two requests at once: the unique index stops the second, which is fine.
      .catch((err: { code?: string; cause?: { code?: string } }) => {
        if (err.code !== "23505" && err.cause?.code !== "23505") throw err;
      });
  }
}

/**
 * The projects table's id, always with its table name. Drizzle leaves the table name off columns in a
 * single-table select, so inside a subquery a bare "id" would mean the subquery's own table.
 */
export const PROJECT_ID = sql.raw(`"projects"."id"`);

const clientTypes = sql.raw(CLIENT_ORG_TYPES.map((t) => `'${t}'`).join(", "));

/** SQL for the names of a project's clients, given the column holding its id. */
export const clientNamesSql = (projectId: SQLWrapper) => sql<string[]>`coalesce((
  select array_agg(o.name order by o.name) from organisations o
  where lower(trim(o.type)) in (${clientTypes}) and exists (select 1 from links l where
    (l.from_type = 'project' and l.from_id = ${projectId} and l.to_type = 'organisation' and l.to_id = o.id) or
    (l.to_type = 'project' and l.to_id = ${projectId} and l.from_type = 'organisation' and l.from_id = o.id))
), '{}')`;

/**
 * SQL for a project's kind of work, "client", "internal" or null (not sorted yet): what Ollie set;
 * else a function's own record is internal; else a project linked to a client is client work.
 */
export const workTypeSql = sql<"client" | "internal" | null>`(case
  when "projects"."work_type" is not null then "projects"."work_type"::text
  when "projects"."is_function" then 'internal'
  when cardinality(${clientNamesSql(PROJECT_ID)}) > 0 then 'client'
end)`;

/** The kind of work of each project, as `workTypeSql` works it out. */
export async function workTypesOf(ids: number[]): Promise<Map<number, "client" | "internal" | null>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: projectsTable.id, w: workTypeSql }).from(projectsTable).where(inArray(projectsTable.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.w ?? null]));
}

export interface FunctionProject {
  id: number;
  name: string;
  slug: string;
  confidential: boolean;
  lifecycle: ProjectLifecycle;
  clients: string[];
  documentCount: number;
  openTaskCount: number;
}

const openStatuses = sql.raw(OPEN_STATUSES.map((s) => `'${s}'`).join(", "));

/** The projects in a function, for its page. */
export async function projectsInFunction(fn: BusinessFunction): Promise<FunctionProject[]> {
  const rows = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      slug: projectsTable.slug,
      confidential: projectsTable.confidential,
      lifecycle: projectsTable.lifecycle,
      clients: clientNamesSql(PROJECT_ID),
      documentCount: sql<number>`(select count(distinct case when l.from_type = 'document' then l.from_id else l.to_id end)::int from links l
        where (l.from_type = 'project' and l.from_id = ${PROJECT_ID} and l.to_type = 'document')
           or (l.to_type = 'project' and l.to_id = ${PROJECT_ID} and l.from_type = 'document'))`,
      openTaskCount: sql<number>`(select count(*)::int from tasks t where t.project_id = ${PROJECT_ID} and t.status in (${openStatuses}))`,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.function, fn), eq(projectsTable.isFunction, false), eq(projectsTable.archived, false)))
    .orderBy(projectsTable.name);
  return rows.map((r) => ({ ...r, clients: r.clients ?? [], documentCount: Number(r.documentCount), openTaskCount: Number(r.openTaskCount) }));
}
