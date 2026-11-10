import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  decisionsTable,
  documentsTable,
  notesTable,
  organisationsTable,
  peopleTable,
  playbooksTable,
  productsTable,
  projectsTable,
  rulesTable,
  tasksTable,
} from "@workspace/db";
import { slugify } from "@workspace/shared";
import type { DbOrTx } from "../../lib/audit";
import { decisionVisible, noteVisible, taskVisible } from "../../lib/ai-data/visibility";
import { NotFoundError, ValidationError } from "../tasks";

export const ACTOR = "ollie";

export type EntityKind = "project" | "person" | "organisation" | "product";
export const ENTITY_KINDS: readonly EntityKind[] = ["project", "person", "organisation", "product"];
export const isEntityKind = (t: string): t is EntityKind => (ENTITY_KINDS as readonly string[]).includes(t);
export type AttachKind = EntityKind | "task" | "decision";

export interface EntitySummary {
  id: number;
  name: string;
  slug: string;
  confidential: boolean;
}

export interface EntityRefView {
  type: string;
  id: number;
  name: string;
  slug: string | null;
}

const ENTITY_TABLES = {
  project: projectsTable,
  person: peopleTable,
  organisation: organisationsTable,
  product: productsTable,
} as const;

/** Library items that can be linked to, named by their title (Part M). */
const TITLED_TABLES = {
  document: documentsTable,
  rule: rulesTable,
  playbook: playbooksTable,
} as const;
type TitledKind = keyof typeof TITLED_TABLES;
const isTitled = (t: string): t is TitledKind => t in TITLED_TABLES;

/** A slug that does not clash with any other row in the same table. */
export async function uniqueSlug(conn: DbOrTx, kind: EntityKind, name: string, exceptId?: number): Promise<string> {
  const table = ENTITY_TABLES[kind];
  const base = slugify(name);
  const rows = await conn
    .select({ id: table.id, slug: table.slug })
    .from(table)
    .where(sql`${table.slug} = ${base} or ${table.slug} like ${base + "-%"}`);
  const taken = new Set(rows.filter((r) => r.id !== exceptId).map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** Marks a project, person, organisation or product as just updated, so "Updated 9th November" reflects child edits. */
export async function touch(conn: DbOrTx, kind: string, id: number): Promise<void> {
  if (isEntityKind(kind)) {
    const table = ENTITY_TABLES[kind];
    await conn.update(table).set({ updatedAt: new Date() }).where(eq(table.id, id));
  }
}

/** Name and slug for something a note or fact hangs off. Throws when it does not exist. */
export async function resolveEntity(type: string, id: number, conn: DbOrTx = db): Promise<EntityRefView> {
  if (isEntityKind(type)) {
    const table = ENTITY_TABLES[type];
    const [row] = await conn.select({ id: table.id, name: table.name, slug: table.slug }).from(table).where(eq(table.id, id));
    if (!row) throw new NotFoundError(`That ${type} does not exist`);
    return { type, ...row };
  }
  if (isTitled(type)) {
    const table = TITLED_TABLES[type];
    const [row] = await conn.select({ id: table.id, name: table.title }).from(table).where(eq(table.id, id));
    if (!row) throw new NotFoundError(`That ${type} does not exist`);
    return { type, ...row, slug: null };
  }
  if (type === "task") {
    const [row] = await conn.select({ id: tasksTable.id, name: tasksTable.title }).from(tasksTable).where(eq(tasksTable.id, id));
    if (!row) throw new NotFoundError("That task does not exist");
    return { type, ...row, slug: null };
  }
  if (type === "decision") {
    const [row] = await conn.select({ id: decisionsTable.id, name: decisionsTable.text }).from(decisionsTable).where(eq(decisionsTable.id, id));
    if (!row) throw new NotFoundError("That decision does not exist");
    return { type, ...row, slug: null };
  }
  throw new ValidationError(`Cannot attach to a ${type}`);
}

/** Names for many refs at once; missing ones are left out. */
export async function resolveEntities(refs: { type: string; id: number }[]): Promise<Map<string, EntityRefView>> {
  const out = new Map<string, EntityRefView>();
  const ids = (t: string) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  await Promise.all(
    ENTITY_KINDS.map(async (t) => {
      const list = ids(t);
      if (!list.length) return;
      const table = ENTITY_TABLES[t];
      const rows = await db.select({ id: table.id, name: table.name, slug: table.slug }).from(table).where(inArray(table.id, list));
      for (const r of rows) out.set(`${t}:${r.id}`, { type: t, ...r });
    }),
  );
  await Promise.all(
    (Object.keys(TITLED_TABLES) as TitledKind[]).map(async (t) => {
      const list = ids(t);
      if (!list.length) return;
      const table = TITLED_TABLES[t];
      const rows = await db.select({ id: table.id, name: table.title }).from(table).where(inArray(table.id, list));
      for (const r of rows) out.set(`${t}:${r.id}`, { type: t, ...r, slug: null });
    }),
  );
  if (ids("task").length) {
    const rows = await db.select({ id: tasksTable.id, name: tasksTable.title }).from(tasksTable).where(inArray(tasksTable.id, ids("task")));
    for (const r of rows) out.set(`task:${r.id}`, { type: "task", ...r, slug: null });
  }
  if (ids("decision").length) {
    const rows = await db
      .select({ id: decisionsTable.id, name: decisionsTable.text })
      .from(decisionsTable)
      .where(inArray(decisionsTable.id, ids("decision")));
    for (const r of rows) out.set(`decision:${r.id}`, { type: "decision", ...r, slug: null });
  }
  return out;
}

/** Ids among the given ones that AI clients cannot read, using the same rules as the filter. */
export async function hiddenIds(kind: "task" | "decision" | "note", ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows =
    kind === "task"
      ? await db.select({ id: tasksTable.id }).from(tasksTable).where(and(inArray(tasksTable.id, ids), sql.raw(`not ${taskVisible("tasks")}`)))
      : kind === "decision"
        ? await db
            .select({ id: decisionsTable.id })
            .from(decisionsTable)
            .where(and(inArray(decisionsTable.id, ids), sql.raw(`not ${decisionVisible("decisions")}`)))
        : await db.select({ id: notesTable.id }).from(notesTable).where(and(inArray(notesTable.id, ids), sql.raw(`not ${noteVisible("notes")}`)));
  return new Set(rows.map((r) => r.id));
}

export function cleanText(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t ? t : null;
}
