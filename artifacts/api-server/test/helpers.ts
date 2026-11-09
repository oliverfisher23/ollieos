import { sql } from "drizzle-orm";
import {
  aiClientsTable,
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
import { slugify } from "@workspace/shared";
import { buildScope, resetAskClientCache, type AiScope } from "../src/lib/ai-data/scope";

if (!process.env.DATABASE_URL?.includes("/ollieos_test")) throw new Error("Tests must run against ollieos_test");

/** Empties every table and resets ids. */
export async function resetDb() {
  const res = await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = (res.rows as { tablename: string }[]).map((r) => `"${r.tablename}"`);
  if (names.length) await db.execute(sql.raw(`truncate ${names.join(", ")} restart identity cascade`));
  resetAskClientCache();
}

export async function project(name: string, opts: { confidential?: boolean; aiAccess?: boolean; summary?: string } = {}) {
  const [row] = await db
    .insert(projectsTable)
    .values({ name, slug: slugify(name), confidential: opts.confidential ?? false, aiAccess: opts.aiAccess ?? true, summary: opts.summary ?? null })
    .returning();
  return row;
}

export async function organisation(name: string, opts: { confidential?: boolean; aiAccess?: boolean } = {}) {
  const [row] = await db
    .insert(organisationsTable)
    .values({ name, slug: slugify(name), confidential: opts.confidential ?? false, aiAccess: opts.aiAccess ?? true })
    .returning();
  return row;
}

export async function person(name: string, opts: { confidential?: boolean; aiAccess?: boolean; organisationId?: number; role?: string } = {}) {
  const [row] = await db
    .insert(peopleTable)
    .values({
      name,
      slug: slugify(name),
      confidential: opts.confidential ?? false,
      aiAccess: opts.aiAccess ?? true,
      organisationId: opts.organisationId ?? null,
      role: opts.role ?? null,
    })
    .returning();
  return row;
}

export async function task(title: string, opts: { projectId?: number; personId?: number; confidential?: boolean | null; notes?: string } = {}) {
  const [row] = await db
    .insert(tasksTable)
    .values({
      title,
      status: "now",
      projectId: opts.projectId ?? null,
      personId: opts.personId ?? null,
      confidential: opts.confidential ?? null,
      notes: opts.notes ?? null,
      createdBy: "test",
    })
    .returning();
  return row;
}

export async function decision(projectId: number, text: string, confidential: boolean | null = null) {
  const [row] = await db.insert(decisionsTable).values({ projectId, text, decidedAt: "2026-11-02", confidential, createdBy: "test" }).returning();
  return row;
}

export async function note(entityType: "project" | "person" | "organisation" | "task" | "decision", entityId: number, body: string, confidential: boolean | null = null) {
  const [row] = await db.insert(notesTable).values({ entityType, entityId, body, title: null, confidential, createdBy: "test" }).returning();
  return row;
}

export async function fact(entityType: "project" | "person" | "organisation", entityId: number, text: string) {
  const [row] = await db.insert(factsTable).values({ entityType, entityId, text, createdBy: "test" }).returning();
  return row;
}

export async function link(fromType: "task" | "decision" | "project" | "person", fromId: number, toType: "project" | "person", toId: number) {
  await db.insert(linksTable).values({ fromType, fromId, toType, toId, createdBy: "test" });
}

export async function client(name: string) {
  const [row] = await db.insert(aiClientsTable).values({ name, kind: "connector", auth: "oauth", scopes: ["read", "write"], connectedAt: new Date() }).returning();
  return row;
}

export async function scopeFor(c: { id: number; name: string }): Promise<AiScope> {
  return buildScope(c);
}
