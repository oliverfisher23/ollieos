/**
 * The numbers for a review of how tasks are working (build plan section 28). No AI: counts only,
 * over the last N days. It answers the questions the section 27 changes left open: are quick Slack
 * replies staying on Messages, are items being added to tasks Ollie already had, why is he dropping
 * things, are tasks getting people, projects and dates, and are the duplicate check and the
 * stuck-task coach worth keeping. Titles and text are never returned, so nothing hidden leaks.
 */
import { and, gte, inArray, sql } from "drizzle-orm";
import { connectorRunsTable, coworkSessionsTable, db, taskDuplicatesTable, taskEvidenceTable, tasksTable } from "@workspace/db";
import { DROP_REASONS } from "@workspace/shared";
import { chaseDueSql } from "./tasks";

const n = (v: unknown) => Number(v ?? 0);

export async function taskReview(days = 7, now = new Date()) {
  const from = new Date(now.getTime() - days * 86_400_000);
  const made = gte(tasksTable.createdAt, from);

  const bySource = await db
    .select({
      source: tasksTable.source,
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${tasksTable.status} = 'done')::int`,
      dropped: sql<number>`count(*) filter (where ${tasksTable.status} in ('dropped','noise'))::int`,
      open: sql<number>`count(*) filter (where ${tasksTable.status} in ('inbox','now','backlog','waiting'))::int`,
      doneWithin30Min: sql<number>`count(*) filter (where ${tasksTable.status} = 'done' and ${tasksTable.completedAt} - ${tasksTable.createdAt} <= interval '30 minutes')::int`,
      withChecklist: sql<number>`count(*) filter (where jsonb_array_length(${tasksTable.steps}) > 0)::int`,
    })
    .from(tasksTable)
    .where(made)
    .groupBy(tasksTable.source);

  const reasons = await db
    .select({ reason: tasksTable.dropReason, count: sql<number>`count(*)::int` })
    .from(tasksTable)
    .where(and(inArray(tasksTable.status, ["dropped", "noise"]), gte(tasksTable.updatedAt, from)))
    .groupBy(tasksTable.dropReason);
  const dropReasons: Record<string, number> = { none_given: 0 };
  for (const r of DROP_REASONS) dropReasons[r] = 0;
  for (const r of reasons) dropReasons[r.reason ?? "none_given"] = (dropReasons[r.reason ?? "none_given"] ?? 0) + r.count;

  const [runs] = await db
    .select({
      quickReplies: sql<number>`coalesce(sum((${connectorRunsTable.counts}->>'quick_replies')::int), 0)::int`,
      addedToExisting: sql<number>`coalesce(sum((${connectorRunsTable.counts}->>'linked')::int), 0)::int`,
    })
    .from(connectorRunsTable)
    .where(gte(connectorRunsTable.startedAt, from));
  const [also] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(taskEvidenceTable)
    .where(and(sql`${taskEvidenceTable.shows} = 'same'`, gte(taskEvidenceTable.createdAt, from)));

  const [sessions] = await db
    .select({ saved: sql<number>`count(*)::int`, openQuestions: sql<number>`coalesce(sum(jsonb_array_length(${coworkSessionsTable.openQuestions})), 0)::int` })
    .from(coworkSessionsTable)
    .where(gte(coworkSessionsTable.createdAt, from));

  const [open] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withPerson: sql<number>`count(*) filter (where ${tasksTable.personId} is not null or ${tasksTable.waitingOnPersonId} is not null)::int`,
      withProject: sql<number>`count(*) filter (where ${tasksTable.projectId} is not null)::int`,
      withDueDate: sql<number>`count(*) filter (where ${tasksTable.dueDate} is not null)::int`,
      dueDateSuggested: sql<number>`count(*) filter (where ${tasksTable.dueDate} is null and ${tasksTable.suggestedDue} is not null)::int`,
      waiting: sql<number>`count(*) filter (where ${tasksTable.status} = 'waiting')::int`,
      waitingWithPerson: sql<number>`count(*) filter (where ${tasksTable.status} = 'waiting' and ${tasksTable.waitingOnPersonId} is not null)::int`,
      toChase: sql<number>`count(*) filter (where ${tasksTable.status} = 'waiting' and ${chaseDueSql(now)})::int`,
    })
    .from(tasksTable)
    .where(inArray(tasksTable.status, ["inbox", "now", "backlog", "waiting"]));

  const [dup] = await db
    .select({
      merged: sql<number>`count(*) filter (where ${taskDuplicatesTable.state} = 'merged')::int`,
      notTheSame: sql<number>`count(*) filter (where ${taskDuplicatesTable.state} = 'dismissed')::int`,
      waiting: sql<number>`count(*) filter (where ${taskDuplicatesTable.state} = 'suggested')::int`,
      judgedNotSame: sql<number>`count(*) filter (where ${taskDuplicatesTable.state} = 'not_same')::int`,
    })
    .from(taskDuplicatesTable)
    .where(gte(taskDuplicatesTable.createdAt, from));

  const o = sql`${tasksTable.stuckHint}->>'outcome'`;
  const [stuck] = await db
    .select({
      flagged: sql<number>`count(*)::int`,
      used: sql<number>`count(*) filter (where ${o} = 'used')::int`,
      notStuck: sql<number>`count(*) filter (where ${o} = 'not_stuck')::int`,
      waiting: sql<number>`count(*) filter (where ${o} is null and ${tasksTable.status} in ('now','backlog'))::int`,
    })
    .from(tasksTable)
    .where(and(sql`${tasksTable.stuckHint} is not null`, gte(tasksTable.stuckCheckedAt, from)));

  const total = bySource.reduce((a, r) => a + r.total, 0);
  return {
    days,
    from: from.toISOString(),
    to: now.toISOString(),
    made: {
      total,
      done: bySource.reduce((a, r) => a + r.done, 0),
      dropped: bySource.reduce((a, r) => a + r.dropped, 0),
      open: bySource.reduce((a, r) => a + r.open, 0),
      doneWithin30Min: bySource.reduce((a, r) => a + r.doneWithin30Min, 0),
      withChecklist: bySource.reduce((a, r) => a + r.withChecklist, 0),
      bySource: Object.fromEntries(bySource.map((r) => [r.source, { total: r.total, done: r.done, dropped: r.dropped, open: r.open, doneWithin30Min: r.doneWithin30Min }])),
    },
    dropReasons,
    readers: { quickRepliesLeftOnMessages: n(runs?.quickReplies), addedToExistingTasks: Math.max(n(runs?.addedToExisting), n(also?.count)) },
    cowork: { sessionsSaved: n(sessions?.saved), openQuestionsStillListed: n(sessions?.openQuestions) },
    openNow: {
      total: n(open?.total),
      withPerson: n(open?.withPerson),
      withProject: n(open?.withProject),
      withDueDate: n(open?.withDueDate),
      dueDateSuggested: n(open?.dueDateSuggested),
      waiting: n(open?.waiting),
      waitingWithPerson: n(open?.waitingWithPerson),
      toChase: n(open?.toChase),
    },
    duplicates: { merged: n(dup?.merged), notTheSame: n(dup?.notTheSame), waiting: n(dup?.waiting), checkedAndDifferent: n(dup?.judgedNotSame) },
    stuck: { flagged: n(stuck?.flagged), used: n(stuck?.used), notStuck: n(stuck?.notStuck), waiting: n(stuck?.waiting) },
  };
}

export type TaskReview = Awaited<ReturnType<typeof taskReview>>;
