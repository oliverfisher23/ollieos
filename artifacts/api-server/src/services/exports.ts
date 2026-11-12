/**
 * Milestone 9: the tasks CSV export, and clearing Noise after 90 days (PRD section 13).
 */
import { and, asc, eq, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, peopleTable, projectsTable, tasksTable } from "@workspace/db";

/** Noise items older than this are deleted. */
export const NOISE_KEEP_DAYS = 90;

export async function clearOldNoise(now = new Date()): Promise<number> {
  const rows = await db
    .delete(tasksTable)
    .where(and(eq(tasksTable.status, "noise"), lt(tasksTable.updatedAt, new Date(now.getTime() - NOISE_KEEP_DAYS * 86_400_000))))
    .returning({ id: tasksTable.id });
  return rows.length;
}

/** One CSV field: quoted when it holds a comma, quote or line break; a leading = + - @ is made safe for spreadsheets. */
export function csvField(v: unknown): string {
  if (v == null) return "";
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADER = ["id", "title", "status", "kind", "priority", "due_date", "project", "for_person", "waiting_on", "source", "source_link", "notes", "confidential", "created_at", "completed_at"];

/** Every task, oldest first, as CSV with a header row (Noise included, so nothing is lost). */
export async function tasksCsv(): Promise<string> {
  const waiting = alias(peopleTable, "waiting_person");
  const rows = await db
    .select({
      t: tasksTable,
      project: projectsTable.name,
      person: peopleTable.name,
      waitingOn: waiting.name,
    })
    .from(tasksTable)
    .leftJoin(projectsTable, eq(projectsTable.id, tasksTable.projectId))
    .leftJoin(peopleTable, eq(peopleTable.id, tasksTable.personId))
    .leftJoin(waiting, eq(waiting.id, tasksTable.waitingOnPersonId))
    .orderBy(asc(tasksTable.id));
  const lines = [HEADER.join(",")];
  for (const r of rows) {
    const t = r.t;
    lines.push(
      [t.id, t.title, t.status, t.kind, t.priority, t.dueDate, r.project, r.person, r.waitingOn, t.source, t.sourceUrl, t.notes, t.confidential ? "yes" : "", t.createdAt, t.completedAt].map(csvField).join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
