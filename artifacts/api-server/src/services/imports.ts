/**
 * One-off imports (PRD section 14, milestone 9): open tasks, and knowledge exported from Claude's
 * memory. Each kind runs once; a second import of the same kind is refused. Ollie reviews the list
 * before Claude posts it, so items are written straight in, with sale, buyer, CIP and board items
 * marked confidential by the exporter. Facts keep `source: "claude-memory"` and their own date, so
 * old ones come up in the weekly fact check.
 */
import { eq, sql } from "drizzle-orm";
import { db, factsTable, importRunsTable, organisationsTable, peopleTable, projectsTable, tasksTable } from "@workspace/db";
import { isIsoDate } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { uniqueSlug } from "./knowledge/common";
import { ConflictError, ValidationError } from "./tasks";

export interface TaskImportRow {
  title: string;
  status?: "inbox" | "now" | "backlog" | "waiting";
  priority?: "high" | "medium" | "low";
  dueDate?: string | null;
  project?: string | null;
  person?: string | null;
  notes?: string | null;
}

export interface KnowledgeImport {
  organisations?: { name: string; type?: string | null; summary?: string | null; confidential?: boolean }[];
  projects?: { name: string; summary?: string | null; status?: string | null; confidential?: boolean }[];
  people?: { name: string; role?: string | null; email?: string | null; organisation?: string | null; relationshipSummary?: string | null; confidential?: boolean }[];
  facts?: { about: { type: "project" | "person" | "organisation"; name: string }; text: string; date?: string | null }[];
}

export interface ImportResult {
  kind: "tasks" | "knowledge";
  created: Record<string, number>;
  matched: Record<string, number>;
  skipped: string[];
}

async function claim(kind: "tasks" | "knowledge", actor: string): Promise<void> {
  const rows = await db.insert(importRunsTable).values({ kind, actor }).onConflictDoNothing().returning({ id: importRunsTable.id });
  if (!rows.length) throw new ConflictError(`The ${kind} import has already run. It runs once.`);
}

async function finish(kind: "tasks" | "knowledge", r: ImportResult, actor: string) {
  await db.update(importRunsTable).set({ counts: { created: r.created, matched: r.matched, skipped: r.skipped.length } }).where(eq(importRunsTable.kind, kind));
  await writeAudit(db, { actor, action: "import", payload: { kind, created: r.created, matched: r.matched, skipped: r.skipped.length } });
}

const byName = async <T extends typeof projectsTable | typeof peopleTable | typeof organisationsTable>(table: T, name: string | null | undefined): Promise<number | null> => {
  const n = name?.trim();
  if (!n) return null;
  const [row] = await db.select({ id: table.id }).from(table as typeof projectsTable).where(sql`lower(${table.name}) = ${n.toLowerCase()}`).limit(1);
  return row?.id ?? null;
};

export async function importTasks(rows: TaskImportRow[], actor: string): Promise<ImportResult> {
  if (!rows.length) throw new ValidationError("There are no tasks to import");
  await claim("tasks", actor);
  const r: ImportResult = { kind: "tasks", created: { tasks: 0 }, matched: {}, skipped: [] };
  for (const t of rows) {
    const title = t.title?.trim();
    if (!title) {
      r.skipped.push("A task with no title");
      continue;
    }
    if (t.dueDate && !isIsoDate(t.dueDate)) r.skipped.push(`"${title}": the due date was not a date, so it was left off`);
    await db.insert(tasksTable).values({
      title: title.slice(0, 200),
      status: t.status ?? "backlog",
      priority: t.priority ?? "medium",
      dueDate: t.dueDate && isIsoDate(t.dueDate) ? t.dueDate : null,
      projectId: await byName(projectsTable, t.project),
      personId: await byName(peopleTable, t.person),
      notes: t.notes?.trim() || null,
      source: "manual",
      createdBy: actor,
    });
    r.created.tasks++;
  }
  await finish("tasks", r, actor);
  return r;
}

export async function importKnowledge(body: KnowledgeImport, actor: string): Promise<ImportResult> {
  const total = (body.organisations?.length ?? 0) + (body.projects?.length ?? 0) + (body.people?.length ?? 0) + (body.facts?.length ?? 0);
  if (!total) throw new ValidationError("There is nothing to import");
  await claim("knowledge", actor);
  const r: ImportResult = { kind: "knowledge", created: { organisations: 0, projects: 0, people: 0, facts: 0 }, matched: { organisations: 0, projects: 0, people: 0 }, skipped: [] };

  for (const o of body.organisations ?? []) {
    if (!o.name?.trim()) continue;
    if (await byName(organisationsTable, o.name)) {
      r.matched.organisations++;
      continue;
    }
    const name = o.name.trim();
    await db.insert(organisationsTable).values({ name, slug: await uniqueSlug(db, "organisation", name), type: o.type ?? null, summary: o.summary ?? null, confidential: o.confidential ?? false });
    r.created.organisations++;
  }
  for (const p of body.projects ?? []) {
    if (!p.name?.trim()) continue;
    if (await byName(projectsTable, p.name)) {
      r.matched.projects++;
      continue;
    }
    const name = p.name.trim();
    await db.insert(projectsTable).values({ name, slug: await uniqueSlug(db, "project", name), summary: p.summary ?? null, status: p.status ?? null, confidential: p.confidential ?? false });
    r.created.projects++;
  }
  for (const p of body.people ?? []) {
    if (!p.name?.trim()) continue;
    if (await byName(peopleTable, p.name)) {
      r.matched.people++;
      continue;
    }
    const name = p.name.trim();
    const email = p.email?.trim().toLowerCase() || null;
    if (email) {
      const [taken] = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.email, email));
      if (taken) {
        r.matched.people++;
        continue;
      }
    }
    await db.insert(peopleTable).values({
      name,
      slug: await uniqueSlug(db, "person", name),
      role: p.role ?? null,
      email,
      organisationId: await byName(organisationsTable, p.organisation),
      relationshipSummary: p.relationshipSummary ?? null,
      confidential: p.confidential ?? false,
    });
    r.created.people++;
  }
  for (const f of body.facts ?? []) {
    const text = f.text?.trim();
    if (!text) continue;
    const table = f.about.type === "project" ? projectsTable : f.about.type === "person" ? peopleTable : organisationsTable;
    const id = await byName(table, f.about.name);
    if (!id) {
      r.skipped.push(`"${text.slice(0, 60)}": no ${f.about.type} called ${f.about.name}`);
      continue;
    }
    const at = f.date && isIsoDate(f.date) ? new Date(f.date + "T12:00:00Z") : new Date();
    await db.insert(factsTable).values({ entityType: f.about.type, entityId: id, text, source: "claude-memory", createdBy: actor, createdAt: at, lastConfirmedAt: at });
    r.created.facts++;
  }
  await finish("knowledge", r, actor);
  return r;
}

export async function importStatus(): Promise<{ kind: string; ranAt: Date; actor: string }[]> {
  return db.select({ kind: importRunsTable.kind, ranAt: importRunsTable.ranAt, actor: importRunsTable.actor }).from(importRunsTable);
}
