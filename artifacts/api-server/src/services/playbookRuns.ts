/**
 * Part L (build plan section 14): "Run this playbook" makes its steps into tasks, linked to the
 * person, organisation or project it is run for, dated from the day it starts. Ollie chooses
 * separate tasks, or one task with the steps as a checklist. And where each rule and playbook was
 * used: read from the AI read log, which records every rule and playbook handed to an AI.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { auditEventsTable, db, organisationsTable, peopleTable, playbooksTable, projectsTable, rulesTable, tasksTable } from "@workspace/db";
import { addDays, isIsoDate, todayLondon } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { NotFoundError, ValidationError } from "./tasks";

export interface RunTarget {
  type: "person" | "organisation" | "project";
  id: number;
}

export async function runPlaybook(id: number, input: { target: RunTarget; mode: "tasks" | "checklist"; start?: string | null }, actor: string): Promise<{ taskIds: number[] }> {
  const [pb] = await db.select().from(playbooksTable).where(eq(playbooksTable.id, id));
  if (!pb) throw new NotFoundError("That playbook does not exist");
  if (!pb.steps.length) throw new ValidationError("This playbook has no steps to run");
  const start = input.start ?? todayLondon();
  if (!isIsoDate(start)) throw new ValidationError("Give the start as a date");
  const t = input.target;
  const table = t.type === "person" ? peopleTable : t.type === "organisation" ? organisationsTable : projectsTable;
  const [target] = await db.select({ id: table.id, name: table.name }).from(table).where(eq(table.id, t.id));
  if (!target) throw new NotFoundError(`That ${t.type} does not exist`);
  const link = { personId: t.type === "person" ? t.id : null, projectId: t.type === "project" ? t.id : null };
  const forWhom = ` (${target.name})`;
  const due = (days: number | null) => (days != null ? addDays(start, days) : null);

  const ids = await db.transaction(async (tx) => {
    const out: number[] = [];
    if (input.mode === "checklist") {
      const last = Math.max(0, ...pb.steps.map((s) => s.afterDays ?? 0));
      const [row] = await tx
        .insert(tasksTable)
        .values({
          title: `${pb.title}${forWhom}`.slice(0, 200),
          status: "now",
          source: "manual",
          dueDate: due(last),
          steps: pb.steps.map((s) => ({ id: randomUUID().slice(0, 8), title: s.text, done: false })),
          notes: `From the playbook "${pb.title}", started ${start}.`,
          createdBy: actor,
          ...link,
        })
        .returning({ id: tasksTable.id });
      out.push(row.id);
    } else {
      for (const s of pb.steps) {
        // A step someone else does is something Ollie waits on.
        const waiting = s.personId != null;
        const [row] = await tx
          .insert(tasksTable)
          .values({
            title: `${s.text}${forWhom}`.slice(0, 200),
            status: waiting ? "waiting" : s.status === "now" ? "now" : "backlog",
            source: "manual",
            dueDate: due(s.afterDays),
            notes: `Step of the playbook "${pb.title}", started ${start}.`,
            createdBy: actor,
            ...link,
            ...(waiting ? { waitingOnPersonId: s.personId, waitingSince: new Date(), personId: link.personId } : {}),
          })
          .returning({ id: tasksTable.id });
        out.push(row.id);
      }
    }
    await writeAudit(tx, { actor, action: "run", entityType: "playbook", entityId: pb.id, payload: { target: t, mode: input.mode, start, tasks: out } });
    return out;
  });
  return { taskIds: ids };
}

export interface UsageView {
  count: number;
  lastUsedAt: Date | null;
  recent: { at: Date; by: string; via: string | null }[];
  /** Not used in 90 days (and older than that) */
  unused: boolean;
}

const VIA: Record<string, string> = {
  reply_draft: "Email draft",
  check_in_draft: "Check-in draft",
  slack_reply_draft: "Slack draft",
  meeting_follow_up: "Meeting follow-up",
  check_draft: "Draft check",
  get_meeting_brief: "Meeting brief for an AI",
  ask: "Ask OllieOS",
};

/** How often a rule or playbook reached an AI, when last, and the last 10 times. */
export async function usageOf(type: "rule" | "playbook", id: number, now = new Date()): Promise<UsageView> {
  const where = and(eq(auditEventsTable.action, "read"), eq(auditEventsTable.entityType, type), eq(auditEventsTable.entityId, id));
  const [c] = await db.select({ n: sql<number>`count(*)` }).from(auditEventsTable).where(where);
  const recent = await db.select({ at: auditEventsTable.createdAt, actor: auditEventsTable.actor, payload: auditEventsTable.payload }).from(auditEventsTable).where(where).orderBy(desc(auditEventsTable.createdAt)).limit(10);
  const table = type === "rule" ? rulesTable : playbooksTable;
  const [row] = await db.select({ createdAt: table.createdAt }).from(table).where(eq(table.id, id));
  if (!row) throw new NotFoundError(`That ${type} does not exist`);
  const last = recent[0]?.at ?? null;
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  return {
    count: Number(c?.n ?? 0),
    lastUsedAt: last,
    recent: recent.map((r) => {
      const via = (r.payload as { via?: string } | null)?.via ?? null;
      return { at: r.at, by: r.actor, via: via ? (VIA[via] ?? via.replace(/_/g, " ")) : null };
    }),
    unused: row.createdAt < cutoff && (!last || last < cutoff),
  };
}

/** Ids of rules or playbooks not used in 90 days, for the Library lists. */
export async function unusedIds(type: "rule" | "playbook", now = new Date()): Promise<number[]> {
  const cutoff = new Date(now.getTime() - 90 * 86_400_000);
  const table = type === "rule" ? rulesTable : playbooksTable;
  const old = await db.select({ id: table.id }).from(table).where(sql`${table.createdAt} < ${cutoff.toISOString()}::timestamptz`);
  if (!old.length) return [];
  const used = await db
    .selectDistinct({ id: auditEventsTable.entityId })
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.action, "read"), eq(auditEventsTable.entityType, type), inArray(auditEventsTable.entityId, old.map((o) => o.id)), gte(auditEventsTable.createdAt, cutoff)));
  const usedSet = new Set(used.map((u) => u.id));
  return old.map((o) => o.id).filter((id) => !usedSet.has(id));
}
