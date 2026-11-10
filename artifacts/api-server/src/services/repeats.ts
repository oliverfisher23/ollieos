/**
 * Repeating tasks (build plan 14, Part I). Ticking off a repeating task makes the next copy in the
 * Backlog with the next due date. Taking the tick back removes that copy again, if it is untouched.
 */
import { eq } from "drizzle-orm";
import { tasksTable, type RepeatRule as StoredRule, type Task as TaskRow, type TaskStep } from "@workspace/db";
import { formatLong, nextRepeatDate, todayLondon, type RepeatRule } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";

/** A copy is still untouched when nothing has been saved to it since it was made. */
const UNTOUCHED_MS = 2000;

export function freshSteps(steps: TaskStep[]): TaskStep[] {
  return steps.map((s) => ({ ...s, done: false }));
}

/** Makes the next copy of a repeating task and returns its id. */
export async function makeNextCopy(tx: DbOrTx, current: TaskRow, rule: StoredRule, actor: string, clientId: number | null, now = new Date()): Promise<number> {
  const due = nextRepeatDate(rule as RepeatRule, current.dueDate, todayLondon(now));
  const [next] = await tx
    .insert(tasksTable)
    .values({
      title: current.title,
      kind: current.kind,
      status: "backlog",
      priority: current.priority,
      dueDate: due,
      source: "manual",
      notes: current.notes,
      fromName: current.fromName,
      projectId: current.projectId,
      personId: current.personId,
      goalId: current.goalId,
      notGoalWork: current.notGoalWork,
      confidential: current.confidential,
      repeat: rule,
      steps: freshSteps(current.steps ?? []),
      createdBy: "ollie",
      capturedAt: now,
      triagedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: tasksTable.id });
  await writeAudit(tx, {
    actor,
    clientId,
    action: "create",
    entityType: "task",
    entityId: next.id,
    payload: { via: "repeat", fromTaskId: current.id, dueLabel: formatLong(due) },
  });
  return next.id;
}

/**
 * Removes the next copy when the tick that made it is taken back, as long as nobody has touched it.
 * Returns true when it went, so the caller can forget the link and make a fresh one next time.
 */
export async function withdrawNextCopy(tx: DbOrTx, nextId: number, actor: string): Promise<boolean> {
  const [next] = await tx.select().from(tasksTable).where(eq(tasksTable.id, nextId));
  if (!next) return true;
  const untouched = next.status === "backlog" && Math.abs(next.updatedAt.getTime() - next.createdAt.getTime()) < UNTOUCHED_MS;
  if (!untouched) return false;
  await tx.delete(tasksTable).where(eq(tasksTable.id, nextId));
  await writeAudit(tx, { actor, action: "remove", entityType: "task", entityId: nextId, payload: { reason: "repeat_undone" } });
  return true;
}
