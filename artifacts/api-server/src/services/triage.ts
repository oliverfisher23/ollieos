import { and, asc, desc, eq, gte, lt, notInArray, sql } from "drizzle-orm";
import {
  auditEventsTable,
  goalsTable,
  db,
  noiseRulesTable,
  peopleTable,
  tasksTable,
  type InsertTask,
  type Task as TaskRow,
} from "@workspace/db";
import { STATUS_LABELS, formatLong, londonRange, todayLondon, weekStartOf } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import type { FieldChange } from "./history";
import { noiseRuleOptions, toNoiseRuleView, upsertNoiseRule, type NoiseMatchType } from "./noiseRules";
import {
  ConflictError,
  ValidationError,
  loadTask,
  personName,
  snapshotOf,
  type LifecycleSnapshot,
} from "./tasks";
import { toTaskView, toTaskViews, type TaskView } from "./taskView";

export type TriageAction = "now" | "backlog" | "waiting" | "noise" | "dropped";

export interface TriageInput {
  action: TriageAction;
  waitingOnPersonId?: number | null;
  noiseRule?: { matchType: NoiseMatchType; matchValue: string };
}

/** Actions whose audit payload carries a `previous` snapshot and can be undone. */
const UNDOABLE = new Set(["status", "triage", "snooze", "restore"]);
/** Undo is offered straight after an action, not as a way to rewind old history. */
const UNDO_WINDOW_MS = 60 * 60 * 1000;

/** Best guess for who an item is waiting on when Ollie does not pick: current Waiting on, the For person, then the sender's email. */
async function defaultWaitingOn(t: TaskRow): Promise<number | null> {
  if (t.waitingOnPersonId) return t.waitingOnPersonId;
  if (t.personId) return t.personId;
  const address = t.fromAddress?.trim().toLowerCase();
  if (address) {
    const [p] = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(sql`lower(${peopleTable.email}) = ${address}`);
    if (p) return p.id;
  }
  return null;
}

async function latestEvent(id: number) {
  const [last] = await db
    .select()
    .from(auditEventsTable)
    // Reads and reply drafts do not change the task, so they never block an Undo.
    .where(and(eq(auditEventsTable.entityType, "task"), eq(auditEventsTable.entityId, id), notInArray(auditEventsTable.action, ["read", "reply_draft"])))
    .orderBy(desc(auditEventsTable.createdAt), desc(auditEventsTable.id))
    .limit(1);
  return last ?? null;
}

export async function triageTask(id: number, input: TriageInput, actor: string) {
  const current = await loadTask(id);
  // A follow-up straight after a triage (adding a Noise rule, or changing who it is waiting on)
  // amends that triage, so one Undo goes back to where the item was before both.
  let previous: LifecycleSnapshot = snapshotOf(current);
  if (current.status === input.action && (input.action === "noise" || input.action === "waiting")) {
    const last = await latestEvent(id);
    const p = last?.payload as { to?: string; previous?: LifecycleSnapshot; createdRuleId?: number | null } | undefined;
    if (last && last.action === "triage" && p?.to === input.action && p.previous && !p.createdRuleId && Date.now() - last.createdAt.getTime() <= UNDO_WINDOW_MS) {
      previous = p.previous;
    }
  }
  if (input.noiseRule && input.action !== "noise") throw new ValidationError("A noise rule can only be made when moving to Noise");
  if (input.noiseRule && current.source === "meeting") throw new ValidationError("Meeting actions are never ignored by a rule");

  const now = new Date();
  const set: Partial<InsertTask> = { status: input.action };
  const changes: FieldChange[] = [];
  if (current.status !== input.action) {
    changes.push({ field: "status", from: STATUS_LABELS[current.status], to: STATUS_LABELS[input.action] });
  }
  if (!current.triagedAt) set.triagedAt = now;
  if (current.status === "done") set.completedAt = null;
  if (input.action !== "noise") set.noiseRuleId = null;

  if (input.action === "waiting") {
    const waitingOn = input.waitingOnPersonId !== undefined ? input.waitingOnPersonId : await defaultWaitingOn(current);
    if (waitingOn !== current.waitingOnPersonId) {
      set.waitingOnPersonId = waitingOn;
      changes.push({ field: "waitingOn", from: await personName(current.waitingOnPersonId), to: await personName(waitingOn) });
    }
    if (current.status !== "waiting") set.waitingSince = now;
  } else if (current.status === "waiting") {
    set.waitingSince = null;
  }
  if (input.action === "noise" || input.action === "dropped") set.snoozedUntil = null;

  return db.transaction(async (tx) => {
    let rule: Awaited<ReturnType<typeof upsertNoiseRule>> | null = null;
    if (input.action === "noise" && input.noiseRule) {
      rule = await upsertNoiseRule(tx, { ...input.noiseRule, fromTask: current }, actor);
      set.noiseRuleId = rule.rule.id;
    }
    const [row] = await tx.update(tasksTable).set(set).where(eq(tasksTable.id, id)).returning();
    await writeAudit(tx, {
      actor,
      action: "triage",
      entityType: "task",
      entityId: id,
      payload: {
        to: input.action,
        changes,
        previous,
        ruleId: rule?.rule.id ?? null,
        ruleLabel: rule ? toNoiseRuleView(rule.rule).label : null,
        createdRuleId: rule?.created ? rule.rule.id : null,
      },
    });
    return {
      task: await toTaskView(row, tx),
      noiseRule: rule ? toNoiseRuleView(rule.rule) : null,
    };
  });
}

/** Reverts the most recent status change, triage, snooze or restore, if nothing else has happened to the task since. */
export async function undoLast(id: number, actor: string): Promise<TaskView> {
  const current = await loadTask(id);
  const last = await latestEvent(id);

  const payload = (last?.payload ?? {}) as { previous?: LifecycleSnapshot; createdRuleId?: number | null };
  if (!last || !UNDOABLE.has(last.action) || !payload.previous) {
    throw new ConflictError("There is nothing to undo on this task");
  }
  if (Date.now() - last.createdAt.getTime() > UNDO_WINDOW_MS) {
    throw new ConflictError("That change is too old to undo. Edit the task instead");
  }

  const prev = payload.previous;
  const set: Partial<InsertTask> = {
    status: prev.status,
    waitingOnPersonId: prev.waitingOnPersonId,
    waitingSince: prev.waitingSince ? new Date(prev.waitingSince) : null,
    triagedAt: prev.triagedAt ? new Date(prev.triagedAt) : null,
    completedAt: prev.completedAt ? new Date(prev.completedAt) : null,
    snoozedUntil: prev.snoozedUntil ? new Date(prev.snoozedUntil) : null,
    noiseRuleId: prev.noiseRuleId,
  };

  const changes: FieldChange[] = [];
  if (current.status !== prev.status) {
    changes.push({ field: "status", from: STATUS_LABELS[current.status], to: STATUS_LABELS[prev.status] });
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(tasksTable).set(set).where(eq(tasksTable.id, id)).returning();
    let removedRule = false;
    if (payload.createdRuleId) {
      // A rule made by the action being undone goes too, unless it has already caught something.
      const [rule] = await tx.select().from(noiseRulesTable).where(eq(noiseRulesTable.id, payload.createdRuleId));
      const [{ refs }] = await tx
        .select({ refs: sql<number>`count(*)::int` })
        .from(tasksTable)
        .where(eq(tasksTable.noiseRuleId, payload.createdRuleId));
      if (rule && rule.hitCount === 0 && refs === 0) {
        await tx.delete(noiseRulesTable).where(eq(noiseRulesTable.id, rule.id));
        await writeAudit(tx, {
          actor,
          action: "remove",
          entityType: "noise_rule",
          entityId: rule.id,
          payload: { reason: "undo", matchType: rule.matchType, matchValue: rule.matchValue },
        });
        removedRule = true;
      }
    }
    await writeAudit(tx, {
      actor,
      action: "undo",
      entityType: "task",
      entityId: id,
      payload: { undid: last.action, undoneEventId: last.id, changes, removedRule },
    });
    return row;
  });
  return toTaskView(updated);
}

/** Noise or Dropped back to the Inbox, ready to triage again. */
export async function restoreFromNoise(id: number, actor: string): Promise<TaskView> {
  const current = await loadTask(id);
  if (current.status !== "noise" && current.status !== "dropped") throw new ConflictError("Only items in Noise or Dropped can be restored");
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(tasksTable)
      // Bringing it back says it is real, so it no longer shows as "Probably noise".
      .set({ status: "inbox", noiseRuleId: null, triagedAt: null, noiseHintKept: current.noiseHint ? true : current.noiseHintKept })
      .where(eq(tasksTable.id, id))
      .returning();
    await writeAudit(tx, {
      actor,
      action: "restore",
      entityType: "task",
      entityId: id,
      payload: { changes: [{ field: "status", from: STATUS_LABELS[current.status], to: "Inbox" }], previous: snapshotOf(current) },
    });
    return row;
  });
  return toTaskView(updated);
}

export async function getNoiseRuleOptionsFor(id: number) {
  return noiseRuleOptions(await loadTask(id));
}

const LEADING_VERBS =
  /^(follow[\s-]?up|chase|check in|nudge|remind|ping|wait(?:ing)? for|wait(?:ing)? on)\b(\s+(with|on))?\s*/i;

/** Turns a task title into the thing being chased: "Follow up with Paul Buxton on the RAF proposal" becomes "the RAF proposal". */
export function chaseSubject(title: string, personNames: string[]): string {
  let s = title.trim().replace(/[.!]+$/, "");
  s = s.replace(LEADING_VERBS, "");
  for (const name of personNames) {
    const first = name.split(/\s+/)[0];
    for (const n of [name, first]) {
      const re = new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}('s)?\\s+`, "i");
      if (re.test(s)) {
        s = s.replace(re, "");
        break;
      }
    }
  }
  s = s.replace(/^(on|about|re|regarding|for)\s+/i, "");
  if (!s) return `"${title.trim()}"`;
  const [first, ...rest] = s.split(" ");
  // An instruction ("Send the quote") reads badly after "checking in on", so quote the title instead.
  if (/^(send|get|sign|confirm|book|finish|build|share|review|approve|agree|arrange|set|chase|reply|respond|return|provide|complete)$/i.test(first)) {
    return `this one: "${title.trim().replace(/[.!]+$/, "")}"`;
  }
  if (/^(the|a|an|your|our|my|this|that|their|his|her)$/i.test(first)) return [first.toLowerCase(), ...rest].join(" ");
  return s;
}

/** A short, friendly chase line in British English. Copied to the clipboard, never sent from OllieOS. */
export async function buildChaseLine(id: number): Promise<string> {
  const t = await toTaskView(await loadTask(id));
  const sender = t.source === "manual" ? null : t.fromName;
  const who = t.waitingOn?.name ?? t.person?.name ?? sender ?? null;
  const firstName = who?.split(/\s+/)[0] ?? null;
  const names = [t.waitingOn?.name, t.person?.name, sender].filter((n): n is string => !!n);
  const subject = chaseSubject(t.title, names);
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  return `${greeting} just checking in on ${subject}. Is there any update from your side? Thanks, Ollie`;
}

/**
 * This week's Done items as plain text for a weekly update: grouped by goal, with projects as
 * sub-headings, and "Not linked to a goal" last (build plan question 34).
 */
export async function buildWeeklyUpdate(weekStartParam?: string) {
  const ws = weekStartOf(weekStartParam ?? todayLondon());
  const { start, end } = londonRange(ws, 7);
  const rows = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, start), lt(tasksTable.completedAt, end)))
    .orderBy(asc(tasksTable.completedAt));
  const tasks = await toTaskViews(rows);
  const goals = await db.select({ id: goalsTable.id, name: goalsTable.name, parentId: goalsTable.parentId, sortOrder: goalsTable.sortOrder }).from(goalsTable);
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const topOf = (id: number) => {
    const g = goalById.get(id);
    return g?.parentId ? (goalById.get(g.parentId) ?? g) : g;
  };

  // goal id (0 = none) -> project name ("" = none) -> titles
  const groups = new Map<number, Map<string, string[]>>();
  for (const t of tasks) {
    const goalKey = t.goal ? (topOf(t.goal.id)?.id ?? 0) : 0;
    if (!groups.has(goalKey)) groups.set(goalKey, new Map());
    const byProject = groups.get(goalKey)!;
    const key = t.project?.name ?? "";
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)!.push(t.title);
  }
  const goalOrder = [...groups.keys()]
    .filter((k) => k !== 0)
    .sort((a, b) => (goalById.get(a)!.sortOrder - goalById.get(b)!.sortOrder) || a - b);
  if (groups.has(0)) goalOrder.push(0);

  const lines = [`Done in the week of ${formatLong(ws)}`];
  if (tasks.length === 0) {
    lines.push("", "Nothing marked done yet.");
  } else {
    for (const goalKey of goalOrder) {
      const heading = goalKey ? goalById.get(goalKey)!.name : goalOrder.length > 1 ? "Not linked to a goal" : null;
      if (heading) lines.push("", heading.toUpperCase());
      const byProject = groups.get(goalKey)!;
      const named = [...byProject.keys()].filter((k) => k).sort((a, b) => a.localeCompare(b, "en-GB"));
      const ordered = byProject.has("") ? [...named, ""] : named;
      for (const key of ordered) {
        lines.push("", key || (named.length ? "Other" : "Tasks"));
        for (const title of byProject.get(key)!) lines.push(`- ${title}`);
      }
    }
  }
  return { text: lines.join("\n"), count: tasks.length, weekStart: ws };
}

