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
import { matchName, nameCandidates, nameKey, namesInTitle, waitingOnInTitle } from "./personNames";
import { loadTask } from "./tasks";
import type { EntitySummary } from "./taskView";

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
    .select({ id: peopleTable.id, name: peopleTable.name, email: peopleTable.email, otherEmails: peopleTable.otherEmails, isSelf: peopleTable.isSelf, otherNames: peopleTable.otherNames })
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

export interface PersonSuggestions {
  /** Which link the suggestion is for, or null when there is nothing to suggest */
  slot: "person" | "waitingOn" | null;
  /** The name the task uses ("Paul", "Kevin") */
  name: string | null;
  /** Contacts the name could mean, when it fits more than one (or one added since the task was looked at) */
  people: EntitySummary[];
  /** Nobody in Contacts has this name, so it can be added from here */
  canAdd: boolean;
  /** The task names its Waiting on person in a way their contact does not know ("Volodymyr" for Vova) */
  remember: { person: EntitySummary; name: string; otherNames: string[] } | null;
}

const NOTHING: PersonSuggestions = { slot: null, name: null, people: [], canAdd: false, remember: null };

/**
 * Section 28: closing the gaps the automatic pass leaves. "Which Paul?" when a name fits several
 * contacts; "Add Kevin to Contacts" when it fits none; and "Remember Volodymyr as another name
 * for Vova" when Ollie has linked someone the title names differently. No AI.
 */
export async function personSuggestionsFor(taskId: number): Promise<PersonSuggestions> {
  const t = await loadTask(taskId);
  if (!["inbox", "now", "backlog", "waiting"].includes(t.status)) return NOTHING;
  const people = await db
    .select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, confidential: peopleTable.confidential, isSelf: peopleTable.isSelf, otherNames: peopleTable.otherNames })
    .from(peopleTable)
    .limit(5000);
  const summary = (p: (typeof people)[number]): EntitySummary => ({ id: p.id, name: p.name, slug: p.slug, confidential: p.confidential });

  if (t.status === "waiting") {
    const hint = waitingOnInTitle(t.title);
    if (!hint) return NOTHING;
    if (t.waitingOnPersonId != null) {
      const linked = people.find((p) => p.id === t.waitingOnPersonId);
      // Only when the name means nobody yet: it must not be someone else's name.
      if (linked && !linked.isSelf && !nameCandidates(hint, people).length) {
        return { ...NOTHING, remember: { person: summary(linked), name: hint, otherNames: linked.otherNames } };
      }
      return NOTHING;
    }
    const found = nameCandidates(hint, people).slice(0, 5);
    return { slot: "waitingOn", name: hint, people: found.map(summary), canAdd: !found.length, remember: null };
  }

  if (t.personId != null) return NOTHING;
  const sender = t.fromName && !/^(you|ollie)$/i.test(t.fromName.trim()) ? t.fromName.trim() : null;
  for (const hint of [sender, ...namesInTitle(t.title)]) {
    if (!hint) continue;
    const found = nameCandidates(hint, people).slice(0, 5);
    if (found.length) return { slot: "person", name: hint, people: found.map(summary), canAdd: false, remember: null };
  }
  // A sender with a full name who is not in Contacts can be added; a word in a title is too weak for that.
  if (sender && nameKey(sender).split(" ").length >= 2 && (t.source === "email" || t.source === "slack")) {
    return { slot: "person", name: sender, people: [], canAdd: true, remember: null };
  }
  return NOTHING;
}
