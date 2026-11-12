/**
 * Linking tasks to the people they are with (build plan section 27).
 *
 * The readers link a person when they capture a task, but tasks made before name matching existed,
 * tasks added by hand and tasks from Cowork have nobody on them. This looks at each task once (new
 * ones too) and, when exactly one person fits, links them:
 *
 * - who sent the message it came from, by email or by name;
 * - for a Waiting on task, who its title says Ollie is waiting on ("Volodymyr to set up…");
 * - otherwise a person named in the title ("Give Zoe a rough figure", "Send Sam the numbers").
 *
 * A first name alone only counts when one person has it. No AI is used. Each task is looked at
 * once, so a link Ollie removes is not put back, and it does not count as touching the task.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, peopleTable, tasksTable } from "@workspace/db";
import { emailsOf } from "./personMatch";
import { matchName, namesInTitle, waitingOnInTitle } from "./personNames";

const BATCH = 500;

export interface LinkPeopleCounts {
  checked: number;
  linked: number;
}

/** Links people to tasks not yet looked at. Runs with the scheduled checks; cheap when there is nothing new. */
export async function linkPeopleToTasks(): Promise<LinkPeopleCounts> {
  const tasks = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      fromName: tasksTable.fromName,
      fromAddress: tasksTable.fromAddress,
      personId: tasksTable.personId,
      waitingOnPersonId: tasksTable.waitingOnPersonId,
    })
    .from(tasksTable)
    .where(isNull(tasksTable.personCheckedAt))
    .orderBy(asc(tasksTable.id))
    .limit(BATCH);
  if (!tasks.length) return { checked: 0, linked: 0 };

  const people = await db
    .select({ id: peopleTable.id, name: peopleTable.name, email: peopleTable.email, otherEmails: peopleTable.otherEmails, isSelf: peopleTable.isSelf })
    .from(peopleTable)
    .limit(5000);
  const byEmail = new Map<string, number>();
  for (const p of people) if (!p.isSelf) for (const e of emailsOf(p)) if (!byEmail.has(e)) byEmail.set(e, p.id);
  const fromTitle = (title: string, skip: number | null): number | null => {
    for (const n of namesInTitle(title)) {
      const hit = matchName(n, people);
      if (hit && hit.id !== skip) return hit.id;
    }
    return null;
  };

  let linked = 0;
  const now = new Date();
  for (const t of tasks) {
    const set: { personId?: number; waitingOnPersonId?: number } = {};
    const waiting = t.status === "waiting";
    let waitingOn = t.waitingOnPersonId;
    if (waiting && waitingOn == null) {
      waitingOn = matchName(waitingOnInTitle(t.title), people)?.id ?? null;
      if (waitingOn != null) set.waitingOnPersonId = waitingOn;
    }
    if (t.personId == null) {
      const sender =
        (t.fromAddress ? byEmail.get(t.fromAddress.toLowerCase()) : undefined) ??
        (t.fromName && !/^(you|ollie)$/i.test(t.fromName.trim()) ? matchName(t.fromName, people)?.id : undefined) ??
        null;
      // A Waiting on task names who Ollie waits on first; anyone else in the title is who it is for.
      const person = sender ?? (waiting && set.waitingOnPersonId == null && t.waitingOnPersonId == null ? null : fromTitle(t.title, waitingOn));
      if (person != null && person !== waitingOn) set.personId = person;
    }
    // Not a change Ollie made, so updatedAt (and the stale flag) is left alone.
    await db
      .update(tasksTable)
      .set({ ...set, personCheckedAt: now, updatedAt: sql`${tasksTable.updatedAt}` })
      .where(and(eq(tasksTable.id, t.id), isNull(tasksTable.personCheckedAt)));
    if (set.personId != null || set.waitingOnPersonId != null) linked++;
  }
  return { checked: tasks.length, linked };
}
