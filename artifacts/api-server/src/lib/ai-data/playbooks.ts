/**
 * AI reads for Part M: playbooks (get_playbook) and finding a product by name. Same rules as the
 * other ai-data readers: the visibility filter in every WHERE clause, a second check with
 * sanitiseRefs, and every item handed out logged with recordReads. Only In use playbooks reach AI.
 */
import { and, asc, inArray, sql } from "drizzle-orm";
import { db, linksTable, organisationsTable, peopleTable, playbooksTable, productsTable, projectsTable, type Playbook } from "@workspace/db";
import { parseRef, toRef } from "@workspace/shared";
import { organisationVisible, personVisible, playbookVisible, productVisible, projectVisible } from "./visibility";
import { recordReads, sanitiseRefs, type AiScope } from "./scope";
import type { NamedRef } from "./context";

export interface PlaybookStepOut {
  /** Keep the id when proposing a change, so the change shows against the right step */
  id: string;
  n: number;
  text: string;
  person: NamedRef | null;
  after_days: number | null;
}

export interface PlaybookSummaryOut {
  ref: string;
  title: string;
  when_to_use: string;
  purpose: string | null;
  steps: number;
  /** Projects, organisations and products it is for; empty when it is general */
  applies_to: NamedRef[];
}

export interface PlaybookOut extends Omit<PlaybookSummaryOut, "steps"> {
  owner: NamedRef | null;
  steps: PlaybookStepOut[];
  notes: string | null;
  documents: NamedRef[];
  last_checked_at: string;
}

async function visiblePeople(scope: AiScope, ids: number[]): Promise<Map<number, NamedRef>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = await db
    .select({ id: peopleTable.id, name: peopleTable.name })
    .from(peopleTable)
    .where(and(inArray(peopleTable.id, list), sql.raw(personVisible("people", scope.grants))));
  return new Map(rows.map((r) => [r.id, { ref: toRef("person", r.id), name: r.name }]));
}

/** What each playbook links to that the client may see: projects, organisations, products and documents. */
async function linksFor(scope: AiScope, ids: number[]): Promise<Map<number, { appliesTo: NamedRef[]; documents: NamedRef[] }>> {
  const out = new Map<number, { appliesTo: NamedRef[]; documents: NamedRef[] }>();
  if (!ids.length) return out;
  const rows = await db
    .select({ fromType: linksTable.fromType, fromId: linksTable.fromId, toType: linksTable.toType, toId: linksTable.toId })
    .from(linksTable)
    .where(
      sql`(${linksTable.fromType} = 'playbook' and ${inArray(linksTable.fromId, ids)}) or (${linksTable.toType} = 'playbook' and ${inArray(linksTable.toId, ids)})`,
    );
  const pairs = rows.map((r) => (r.fromType === "playbook" ? { item: r.fromId, type: r.toType as string, id: r.toId } : { item: r.toId, type: r.fromType as string, id: r.fromId }));
  const idsOf = (t: string) => [...new Set(pairs.filter((x) => x.type === t).map((x) => x.id))];
  const g = scope.grants;
  const [ps, os, prs, ds] = await Promise.all([
    idsOf("project").length
      ? db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(and(inArray(projectsTable.id, idsOf("project")), sql.raw(projectVisible("projects", g))))
      : [],
    idsOf("organisation").length
      ? db
          .select({ id: organisationsTable.id, name: organisationsTable.name })
          .from(organisationsTable)
          .where(and(inArray(organisationsTable.id, idsOf("organisation")), sql.raw(organisationVisible("organisations", g))))
      : [],
    idsOf("product").length
      ? db.select({ id: productsTable.id, name: productsTable.name }).from(productsTable).where(and(inArray(productsTable.id, idsOf("product")), sql.raw(productVisible("products"))))
      : [],
    idsOf("document").length ? sanitiseRefs(scope, idsOf("document").map((d) => toRef("document", d))) : [],
  ]);
  const names = new Map<string, string>([
    ...ps.map((p) => [toRef("project", p.id), p.name] as [string, string]),
    ...os.map((o) => [toRef("organisation", o.id), o.name] as [string, string]),
    ...prs.map((p) => [toRef("product", p.id), p.name] as [string, string]),
  ]);
  const docIds = ds.map((r) => parseRef(r)!.id);
  const docTitles = docIds.length
    ? new Map(
        ((await db.execute(sql`select id, title from documents where id in (${sql.join(docIds.map((d) => sql`${d}`), sql`, `)})`)).rows as { id: number; title: string }[]).map((r) => [
          Number(r.id),
          r.title,
        ]),
      )
    : new Map<number, string>();
  for (const x of pairs) {
    const ref = `${x.type}:${x.id}`;
    if (!out.has(x.item)) out.set(x.item, { appliesTo: [], documents: [] });
    const entry = out.get(x.item)!;
    if (x.type === "document") {
      const title = docTitles.get(x.id);
      if (title) entry.documents.push({ ref, name: title });
    } else {
      const name = names.get(ref);
      if (name) entry.appliesTo.push({ ref, name });
    }
  }
  return out;
}

async function visibleRows(scope: AiScope, where?: ReturnType<typeof sql>): Promise<Playbook[]> {
  const rows = await db
    .select()
    .from(playbooksTable)
    .where(and(sql.raw(playbookVisible("process_playbooks", scope.grants)), where))
    .orderBy(asc(playbooksTable.title));
  const ok = new Set(await sanitiseRefs(scope, rows.map((r) => toRef("playbook", r.id))));
  return rows.filter((r) => ok.has(toRef("playbook", r.id)));
}

/** get_playbook with nothing named: every In use playbook the client may see, in brief. Logged. */
export async function listPlaybooksForAi(scope: AiScope): Promise<PlaybookSummaryOut[]> {
  const rows = await visibleRows(scope);
  const links = await linksFor(scope, rows.map((r) => r.id));
  await recordReads(scope, rows.map((r) => toRef("playbook", r.id)), { via: "get_playbook" });
  return rows.map((r) => ({
    ref: toRef("playbook", r.id),
    title: r.title,
    when_to_use: r.whenToUse,
    purpose: r.purpose,
    steps: r.steps.length,
    applies_to: links.get(r.id)?.appliesTo ?? [],
  }));
}

/**
 * Finds one visible In use playbook by ref ("playbook:3"), exact title, or a single partial title
 * match. Hidden and missing ones both come back as null.
 */
export async function resolvePlaybookForAi(scope: AiScope, value: string): Promise<number | null> {
  const v = value.trim();
  const ref = parseRef(v);
  if (ref) {
    if (ref.type !== "playbook") return null;
    return (await visibleRows(scope, sql`${playbooksTable.id} = ${ref.id}`))[0]?.id ?? null;
  }
  const lower = v.toLowerCase();
  const exact = await visibleRows(scope, sql`lower(${playbooksTable.title}) = ${lower}`);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1 || lower.length < 3) return null;
  const partial = await visibleRows(scope, sql`${playbooksTable.title} ilike ${"%" + lower.replace(/[%_\\]/g, "\\$&") + "%"}`);
  return partial.length === 1 ? partial[0].id : null;
}

/** get_playbook: one playbook in full, with step ids for proposing a change. Logged. */
export async function playbookForAi(scope: AiScope, id: number): Promise<PlaybookOut | null> {
  const [row] = await visibleRows(scope, sql`${playbooksTable.id} = ${id}`);
  if (!row) return null;
  const [people, links] = await Promise.all([
    visiblePeople(scope, [row.ownerId, ...row.steps.map((s) => s.personId)].filter((x): x is number => x != null)),
    linksFor(scope, [row.id]),
  ]);
  const ref = toRef("playbook", row.id);
  const l = links.get(row.id) ?? { appliesTo: [], documents: [] };
  await recordReads(scope, [ref], { via: "get_playbook" });
  return {
    ref,
    title: row.title,
    when_to_use: row.whenToUse,
    purpose: row.purpose,
    owner: row.ownerId ? (people.get(row.ownerId) ?? null) : null,
    steps: row.steps.map((s, i) => ({ id: s.id, n: i + 1, text: s.text, person: s.personId ? (people.get(s.personId) ?? null) : null, after_days: s.afterDays })),
    notes: row.notes,
    applies_to: l.appliesTo,
    documents: l.documents,
    last_checked_at: row.lastCheckedAt.toISOString(),
  };
}

/** Finds a visible product by ref ("product:2"), slug or exact name, then a single partial name match. */
export async function resolveProductForAi(_scope: AiScope, value: string): Promise<{ id: number; name: string } | null> {
  const v = value.trim();
  const vis = sql.raw(productVisible("products"));
  const find = async (where: ReturnType<typeof sql>, limit = 2) =>
    db.select({ id: productsTable.id, name: productsTable.name }).from(productsTable).where(and(where, vis)).limit(limit);
  const ref = parseRef(v);
  if (ref) return ref.type === "product" ? ((await find(sql`${productsTable.id} = ${ref.id}`))[0] ?? null) : null;
  const lower = v.toLowerCase();
  const [bySlug] = await find(sql`${productsTable.slug} = ${lower}`, 1);
  if (bySlug) return bySlug;
  const exact = await find(sql`lower(${productsTable.name}) = ${lower}`);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || lower.length < 3) return null;
  const partial = await find(sql`${productsTable.name} ilike ${"%" + lower.replace(/[%_\\]/g, "\\$&") + "%"}`);
  return partial.length === 1 ? partial[0] : null;
}

/** Visible products linked to any of the given projects and organisations, for rules and briefs. */
export async function productsLinkedToRefs(refs: readonly string[]): Promise<{ id: number; name: string }[]> {
  const parsed = refs.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r && (r.type === "project" || r.type === "organisation"));
  if (!parsed.length) return [];
  const conds = parsed.map(
    (r) => sql`((l.from_type = ${r.type} and l.from_id = ${r.id} and l.to_type = 'product') or (l.to_type = ${r.type} and l.to_id = ${r.id} and l.from_type = 'product'))`,
  );
  const res = await db.execute(sql`
    select distinct case when l.to_type = 'product' then l.to_id else l.from_id end as id from links l where ${sql.join(conds, sql` or `)}`);
  const ids = (res.rows as { id: number }[]).map((r) => Number(r.id));
  if (!ids.length) return [];
  return db
    .select({ id: productsTable.id, name: productsTable.name })
    .from(productsTable)
    .where(and(inArray(productsTable.id, ids), sql.raw(productVisible("products"))))
    .orderBy(asc(productsTable.name));
}
