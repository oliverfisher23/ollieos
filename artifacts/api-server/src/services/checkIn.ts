/**
 * "Draft a check-in" on the People cadence page (feature 05). Reads only what AI may see about the
 * person, through the same filter as Ask OllieOS, and returns text for Ollie to copy. Nothing is sent.
 */
import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db, peopleTable, projectsTable, tasksTable } from "@workspace/db";
import { OPEN_STATUSES, formatLong, parseRef, toRef } from "@workspace/shared";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { recordReads, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { askScope } from "./ask/ask";
import { draftCheckInFromDocs } from "./ask/model";
import { projectsForPeople } from "./cadence";
import { ConflictError, NotFoundError, UpstreamError } from "./tasks";
import { writingStyleNote } from "./writingStyle";

export interface CheckInThread {
  ref: string;
  type: "task" | "project";
  title: string;
  path: string;
}

export interface CheckInDraft {
  text: string;
  /** The open threads the draft mentions */
  threads: CheckInThread[];
}

export async function checkInDraft(slug: string): Promise<CheckInDraft> {
  const [person] = await db.select().from(peopleTable).where(eq(peopleTable.slug, slug));
  if (!person) throw new NotFoundError("That person does not exist");
  if (person.isSelf) throw new ConflictError("There is no one to check in with on your own record");

  const scope = await askScope();
  const personRef = toRef("person", person.id);
  if (!(await visibleRefs(scope, [personRef])).has(personRef)) {
    throw new ConflictError(`${person.name} is hidden from AI, so OllieOS cannot draft this. Write it yourself or allow AI on their page.`);
  }

  // Open threads: what Ollie owes them, what he is waiting on from them, and live shared projects.
  const [tasks, projects] = await Promise.all([
    db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(inArray(tasksTable.status, [...OPEN_STATUSES]), or(eq(tasksTable.personId, person.id), eq(tasksTable.waitingOnPersonId, person.id))))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(15),
    projectsForPeople([person.id]),
  ]);
  const active = (projects.get(person.id) ?? []).filter((p) => p.lifecycle === "active").slice(0, 5);
  const refs = [personRef, ...tasks.map((t) => toRef("task", t.id)), ...active.map((p) => toRef("project", p.id))];
  if (person.organisationId) refs.push(toRef("organisation", person.organisationId));
  const items = await loadVisibleDocs(scope, refs);
  const rules = await loadVisibleDocs(scope, await applicableRuleRefs(scope, refs));
  const docs = [...rules, ...items];
  await recordReads(scope, docs.map((d) => d.ref), { via: "check_in_draft", person: person.id });

  let draft: { text: string; refs: string[] };
  try {
    draft = await draftCheckInFromDocs({
      to: person.name,
      lastContact: person.lastContactAt ? formatLong(person.lastContactAt, { withYear: true }) : null,
      docs,
      style: await writingStyleNote(),
    });
  } catch (err) {
    logger.error({ err }, "Check-in draft failed");
    throw new UpstreamError("The draft could not be written just now. Try again in a moment.");
  }
  if (!draft.text) throw new UpstreamError("The draft came back empty. Try again in a moment.");

  // Only threads that were handed to the model, and only tasks and projects, are listed as cited.
  const allowed = new Set(items.map((d) => d.ref));
  const cited = [...new Set(draft.refs.map((r) => r.trim()))].filter((r) => allowed.has(r)).map(parseRef);
  const taskIds = cited.filter((r) => r?.type === "task").map((r) => r!.id);
  const projectIds = cited.filter((r) => r?.type === "project").map((r) => r!.id);
  const [taskRows, projectRows] = await Promise.all([
    taskIds.length ? db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable).where(inArray(tasksTable.id, taskIds)) : [],
    projectIds.length
      ? db.select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug }).from(projectsTable).where(inArray(projectsTable.id, projectIds))
      : [],
  ]);
  const threads: CheckInThread[] = [
    ...taskRows.map((t) => ({ ref: toRef("task", t.id), type: "task" as const, title: t.title, path: `/tasks?task=${t.id}` })),
    ...projectRows.map((p) => ({ ref: toRef("project", p.id), type: "project" as const, title: p.name, path: `/knowledge/projects/${p.slug}` })),
  ];

  await writeAudit(db, { actor: "ollie", action: "draft", entityType: "person", entityId: person.id, payload: { via: "check_in", cited: threads.map((t) => t.ref) } });
  return { text: draft.text, threads };
}
