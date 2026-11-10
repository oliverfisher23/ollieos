/**
 * The Review page: items waiting for Ollie that are kept out of the Inbox.
 *
 * - Actions a Granola look back found (Assist Part C). Now, Backlog and Waiting on turn an item into
 *   a task with that status (through captureTask, so a task with the same source is never made
 *   twice). Already done and Dropped just close the item.
 * - No reply yet (Assist Part D): emails Ollie sent that nobody answered. Chase is Waiting on: it
 *   makes a Waiting on task from the email, with the chase line as the next step. Already handled
 *   (done) and Dropped close it.
 *
 * Every choice also works on several selected items at once.
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, peopleTable, projectsTable, reviewItemsTable, tasksTable, type ReviewItem } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { captureTask } from "./aiWrites";
import { NotFoundError, ValidationError } from "./tasks";
import type { EntitySummary } from "./taskView";

const ACTOR = "ollie";

export const REVIEW_ACTIONS = ["now", "backlog", "waiting", "done", "dropped"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export interface ReviewItemView {
  id: number;
  kind: ReviewItem["kind"];
  state: ReviewItem["state"];
  text: string;
  action: string | null;
  quote: string | null;
  meetingTitle: string;
  meetingAt: Date;
  sourceUrl: string | null;
  email: string | null;
  reason: string | null;
  suggestedType: string;
  owner: string;
  person: EntitySummary | null;
  project: EntitySummary | null;
  dueDate: string | null;
  priority: ReviewItem["priority"];
  confidential: boolean;
  taskId: number | null;
  createdAt: Date;
  decidedAt: Date | null;
}

async function toViews(rows: ReviewItem[]): Promise<ReviewItemView[]> {
  if (!rows.length) return [];
  const personIds = [...new Set(rows.map((r) => r.personId).filter((x): x is number => x != null))];
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is number => x != null))];
  const [people, projects] = await Promise.all([
    personIds.length
      ? db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, confidential: peopleTable.confidential }).from(peopleTable).where(inArray(peopleTable.id, personIds))
      : [],
    projectIds.length
      ? db.select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, confidential: projectsTable.confidential }).from(projectsTable).where(inArray(projectsTable.id, projectIds))
      : [],
  ]);
  const person = new Map(people.map((p) => [p.id, p]));
  const project = new Map(projects.map((p) => [p.id, p]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    state: r.state,
    text: r.text,
    action: r.action,
    quote: r.quote,
    meetingTitle: r.meetingTitle,
    meetingAt: r.meetingAt,
    sourceUrl: r.sourceUrl,
    email: r.email,
    reason: r.reason,
    suggestedType: r.suggestedType,
    owner: r.owner,
    person: r.personId != null ? (person.get(r.personId) ?? null) : null,
    project: r.projectId != null ? (project.get(r.projectId) ?? null) : null,
    dueDate: r.dueDate,
    priority: r.priority,
    confidential: r.confidential === true || (r.personId != null && person.get(r.personId)?.confidential === true) || (r.projectId != null && project.get(r.projectId)?.confidential === true),
    taskId: r.taskId,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  }));
}

/** Pending items, newest meeting or email first. */
export async function listReview(): Promise<{ items: ReviewItemView[]; pending: number; actions: number; noReply: number }> {
  const rows = await db
    .select()
    .from(reviewItemsTable)
    .where(eq(reviewItemsTable.state, "pending"))
    .orderBy(desc(reviewItemsTable.meetingAt), asc(reviewItemsTable.sourceRef))
    .limit(1000);
  const noReply = rows.filter((r) => r.kind === "no_reply").length;
  return { items: await toViews(rows), pending: rows.length, actions: rows.length - noReply, noReply };
}

export interface ReviewChoice {
  action: ReviewAction;
  /** For Waiting on: who Ollie is waiting on. Unset keeps each item's own person; null is someone not in People. */
  waitingOnPersonId?: number | null;
}

async function checkPerson(id: number | null | undefined) {
  if (id == null) return;
  const [p] = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.id, id));
  if (!p) throw new ValidationError("That person does not exist");
}

/** Chase on an unanswered email: a Waiting on task from the email, with the chase line as its next step. */
async function chase(item: ReviewItem, choice: ReviewChoice, now: Date): Promise<number | null> {
  const waitingOn = choice.waitingOnPersonId !== undefined ? choice.waitingOnPersonId : item.personId;
  const r = await captureTask(
    { actor: ACTOR, clientId: null },
    {
      title: item.text,
      kind: "task",
      status: "waiting",
      priority: item.priority,
      dueDate: item.dueDate,
      source: "email",
      // Its own ref, so it never clashes with a task the regular Gmail check made from the same email.
      sourceRef: `${item.sourceRef}#chase`,
      sourceUrl: item.sourceUrl,
      sourceQuote: item.quote,
      sourceSubject: item.meetingTitle,
      suggestedAction: item.action,
      fromName: item.owner,
      fromAddress: item.email,
      projectId: item.projectId,
      waitingOnPersonId: waitingOn,
      confidential: item.confidential,
      capturedAt: item.meetingAt,
    },
    { applyNoise: false, via: "review" },
  );
  if (r.outcome === "created" && r.taskId != null) await db.update(tasksTable).set({ triagedAt: now }).where(eq(tasksTable.id, r.taskId));
  return r.taskId;
}

async function decideOne(item: ReviewItem, choice: ReviewChoice, now: Date): Promise<ReviewItem> {
  let taskId: number | null = null;
  if (item.kind === "no_reply" && choice.action === "waiting") {
    taskId = await chase(item, choice, now);
  } else if (choice.action === "now" || choice.action === "backlog" || choice.action === "waiting") {
    const waiting = choice.action === "waiting";
    const waitingOn = waiting ? (choice.waitingOnPersonId !== undefined ? choice.waitingOnPersonId : item.personId) : null;
    const r = await captureTask(
      { actor: ACTOR, clientId: null },
      {
        title: item.text,
        kind: item.suggestedType === "promise" && !waiting ? "promise" : "task",
        status: choice.action,
        priority: item.priority,
        dueDate: item.dueDate,
        source: "meeting",
        sourceRef: item.sourceRef,
        sourceUrl: item.sourceUrl,
        sourceQuote: item.quote,
        sourceSubject: item.meetingTitle,
        suggestedAction: item.action,
        projectId: item.projectId,
        personId: waiting ? null : item.personId,
        waitingOnPersonId: waitingOn,
        confidential: item.confidential,
        capturedAt: item.meetingAt,
      },
      { applyNoise: false, via: "review" },
    );
    taskId = r.taskId;
    if (r.outcome === "created" && taskId != null) await db.update(tasksTable).set({ triagedAt: now }).where(eq(tasksTable.id, taskId));
  }
  const state = choice.action === "done" ? "done" : choice.action === "dropped" ? "dropped" : "accepted";
  const [updated] = await db
    .update(reviewItemsTable)
    .set({ state, taskId, decidedAt: now })
    .where(and(eq(reviewItemsTable.id, item.id), eq(reviewItemsTable.state, "pending")))
    .returning();
  if (!updated) throw new ValidationError("That item was already decided");
  await writeAudit(db, { actor: ACTOR, action: "review", entityType: "review_item", entityId: item.id, payload: { choice: choice.action, taskId } });
  return updated;
}

/** Applies one choice to one or more pending items. Items already decided are left as they are. */
export async function decideReview(ids: number[], choice: ReviewChoice, now = new Date()): Promise<ReviewItemView[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new ValidationError("Choose at least one item");
  if (choice.action === "waiting") await checkPerson(choice.waitingOnPersonId);
  const rows = await db.select().from(reviewItemsTable).where(inArray(reviewItemsTable.id, unique));
  if ((choice.action === "now" || choice.action === "backlog") && rows.some((r) => r.kind === "no_reply" && r.state === "pending")) {
    throw new ValidationError("An unanswered email can be chased, marked as handled or dropped.");
  }
  if (unique.length === 1) {
    if (!rows.length) throw new NotFoundError("That item does not exist");
    if (rows[0].state !== "pending") throw new ValidationError("That item was already decided");
  }
  const out: ReviewItem[] = [];
  for (const row of rows) {
    if (row.state !== "pending") continue;
    out.push(await decideOne(row, choice, now));
  }
  return toViews(out);
}
