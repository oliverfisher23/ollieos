/**
 * Writes from AI clients: the MCP tools and the ingest API (PRD 11 and 12).
 * Callers resolve names to visible ids through ai-data first; these functions only write.
 * Every write is audited with the client's actor name and client id, in the same transaction.
 * There is deliberately nothing here that deletes Ollie's data (criterion 7); calendar events are
 * replaced as a block, as the PRD specifies.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  captureLogTable,
  db,
  linksTable,
  noiseRulesTable,
  notesTable,
  peopleTable,
  sweepRunsTable,
  tasksTable,
  type NoiseRule,
} from "@workspace/db";
import { addDays, londonRange, todayLondon, type Priority, type TaskSource, type TaskStatus } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { cleanText, touch } from "./knowledge/common";
import { ValidationError } from "./tasks";

/** Who is writing: the actor name for audit_events and the ai_clients row. */
export interface Writer {
  actor: string;
  clientId: number;
}

/* ---------- Tasks and capture ---------- */

export interface CaptureInput {
  title: string;
  kind?: "task" | "promise";
  /** Explicit status. When unset the item lands in Inbox, or Noise when a rule matches. */
  status?: TaskStatus;
  priority?: Priority;
  dueDate?: string | null;
  source: TaskSource;
  sourceRef?: string | null;
  sourceUrl?: string | null;
  sourceQuote?: string | null;
  sourceSubject?: string | null;
  sourceChannel?: string | null;
  snippet?: string | null;
  suggestedAction?: string | null;
  fromName?: string | null;
  fromAddress?: string | null;
  notes?: string | null;
  projectId?: number | null;
  personId?: number | null;
  waitingOnPersonId?: number | null;
  confidential?: boolean | null;
  capturedAt?: Date | null;
}

export interface CaptureResult {
  outcome: "created" | "duplicate" | "noise";
  taskId: number | null;
  noiseRuleId?: number;
}

/** The first enabled rule that matches an item. Meeting actions are never auto-noised (PRD 13). */
export function matchNoiseRule(rules: NoiseRule[], item: CaptureInput): NoiseRule | null {
  if (item.source === "meeting") return null;
  const address = item.fromAddress?.trim().toLowerCase() ?? "";
  const domain = address.includes("@") ? address.split("@").pop()! : "";
  const channel = item.sourceChannel?.trim().toLowerCase().replace(/^#/, "") ?? "";
  const titles = [item.title, item.sourceSubject ?? ""].map((t) => t.toLowerCase());
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.source && r.source !== item.source) continue;
    const v = r.matchValue;
    const hit =
      (r.matchType === "from_address_equals" && address === v) ||
      (r.matchType === "from_domain_equals" && domain === v) ||
      (r.matchType === "slack_channel_equals" && channel === v) ||
      (r.matchType === "title_contains" && v.length > 0 && titles.some((t) => t.includes(v)));
    if (hit) return r;
  }
  return null;
}

/**
 * Adds one captured item. With a source_ref, a second capture of the same source and ref is a
 * duplicate (criterion 5): the capture_log row is claimed first, under its unique index, so two
 * sweeps running at once still create one task. The confidential flag is stored on insert, in
 * the same transaction, so the item is hidden from AI from the moment it exists (criterion 12).
 */
export async function captureTask(w: Writer, item: CaptureInput, opts: { applyNoise: boolean; via: string; rules?: NoiseRule[] }): Promise<CaptureResult> {
  const title = cleanText(item.title);
  if (!title) throw new ValidationError("A task needs a title");
  const sourceRef = cleanText(item.sourceRef);
  const rules = opts.applyNoise && item.status === undefined ? (opts.rules ?? (await db.select().from(noiseRulesTable).where(eq(noiseRulesTable.enabled, true)))) : [];
  const rule = matchNoiseRule(rules, item);
  const now = new Date();

  return db.transaction(async (tx) => {
    let logId: number | null = null;
    if (sourceRef) {
      const [claimed] = await tx
        .insert(captureLogTable)
        .values({ source: item.source, sourceRef, outcome: rule ? "noise" : "created", capturedAt: item.capturedAt ?? now })
        .onConflictDoNothing()
        .returning({ id: captureLogTable.id });
      if (!claimed) {
        const [prev] = await tx
          .select({ taskId: captureLogTable.taskId })
          .from(captureLogTable)
          .where(and(eq(captureLogTable.source, item.source), eq(captureLogTable.sourceRef, sourceRef)));
        return { outcome: "duplicate" as const, taskId: prev?.taskId ?? null };
      }
      logId = claimed.id;
      // A task made by hand with the same ref, before capture_log existed for it.
      const [existing] = await tx
        .select({ id: tasksTable.id })
        .from(tasksTable)
        .where(and(eq(tasksTable.source, item.source), eq(tasksTable.sourceRef, sourceRef)));
      if (existing) {
        await tx.update(captureLogTable).set({ outcome: "duplicate", taskId: existing.id }).where(eq(captureLogTable.id, logId));
        return { outcome: "duplicate" as const, taskId: existing.id };
      }
    }

    const status: TaskStatus = item.status ?? (rule ? "noise" : "inbox");
    const [created] = await tx
      .insert(tasksTable)
      .values({
        title,
        kind: item.kind ?? "task",
        status,
        priority: item.priority ?? "medium",
        dueDate: item.dueDate ?? null,
        source: item.source,
        sourceRef,
        sourceUrl: cleanText(item.sourceUrl),
        sourceQuote: cleanText(item.sourceQuote),
        sourceSubject: cleanText(item.sourceSubject),
        sourceChannel: cleanText(item.sourceChannel),
        snippet: cleanText(item.snippet),
        suggestedAction: cleanText(item.suggestedAction),
        fromName: cleanText(item.fromName),
        fromAddress: cleanText(item.fromAddress)?.toLowerCase() ?? null,
        notes: cleanText(item.notes),
        projectId: item.projectId ?? null,
        personId: item.personId ?? null,
        waitingOnPersonId: item.waitingOnPersonId ?? null,
        waitingSince: status === "waiting" ? now : null,
        completedAt: status === "done" ? now : null,
        noiseRuleId: rule?.id ?? null,
        confidential: item.confidential ?? null,
        capturedAt: item.capturedAt ?? now,
        createdBy: w.actor,
      })
      .returning({ id: tasksTable.id });
    if (logId != null) await tx.update(captureLogTable).set({ taskId: created.id }).where(eq(captureLogTable.id, logId));
    if (rule) {
      await tx
        .update(noiseRulesTable)
        .set({ hitCount: sql`${noiseRulesTable.hitCount} + 1`, lastHitAt: now })
        .where(eq(noiseRulesTable.id, rule.id));
    }
    await writeAudit(tx, {
      actor: w.actor,
      clientId: w.clientId,
      action: "create",
      entityType: "task",
      entityId: created.id,
      payload: { via: opts.via, status, noiseRuleId: rule?.id ?? null, confidential: item.confidential ?? null },
    });
    return rule ? { outcome: "noise" as const, taskId: created.id, noiseRuleId: rule.id } : { outcome: "created" as const, taskId: created.id };
  });
}

/** Enabled noise rules, loaded once per ingest batch. */
export async function enabledRules(): Promise<NoiseRule[]> {
  return db.select().from(noiseRulesTable).where(eq(noiseRulesTable.enabled, true));
}

/* ---------- Knowledge ---------- */

/*
 * Facts, decisions, people, organisations and projects from AI clients are suggestions, not
 * writes: see services/suggestions.ts and services/aiPropose.ts (feature 01, rule 1).
 */

export async function addNote(w: Writer, input: { entityType: "project" | "person" | "organisation"; entityId: number; title?: string | null; body: string; confidential?: boolean | null }) {
  const body = cleanText(input.body);
  if (!body) throw new ValidationError("A note needs some text");
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(notesTable)
      .values({ entityType: input.entityType, entityId: input.entityId, title: cleanText(input.title), body, confidential: input.confidential ?? null, createdBy: w.actor })
      .returning();
    await touch(tx, input.entityType, input.entityId);
    await writeAudit(tx, { actor: w.actor, clientId: w.clientId, action: "create", entityType: "note", entityId: created.id, payload: { on: `${input.entityType}:${input.entityId}` } });
    return created;
  });
}

export interface ActivityInput {
  kind: "email" | "meeting" | "slack" | "note" | "task";
  summary: string;
  occurredAt: Date;
  sourceUrl?: string | null;
  sourceRef?: string | null;
  personIds: number[];
  projectIds: number[];
}

/**
 * One touchpoint. It hangs off the first project (or the first person when there is none),
 * and links to the rest. A repeated source_ref returns the existing row.
 */
export async function logActivity(w: Writer, input: ActivityInput, via: string): Promise<{ id: number; duplicate: boolean }> {
  const summary = cleanText(input.summary);
  if (!summary) throw new ValidationError("Activity needs a summary");
  const sourceRef = cleanText(input.sourceRef);
  const primary = input.projectIds.length
    ? { type: "project" as const, id: input.projectIds[0] }
    : input.personIds.length
      ? { type: "person" as const, id: input.personIds[0] }
      : null;
  return db.transaction(async (tx) => {
    if (sourceRef) {
      const [existing] = await tx.select({ id: activityTable.id }).from(activityTable).where(eq(activityTable.sourceRef, sourceRef));
      if (existing) return { id: existing.id, duplicate: true };
    }
    const [created] = await tx
      .insert(activityTable)
      .values({
        entityType: primary?.type ?? null,
        entityId: primary?.id ?? null,
        kind: input.kind,
        summary,
        sourceUrl: cleanText(input.sourceUrl),
        sourceRef,
        occurredAt: input.occurredAt,
        createdBy: w.actor,
      })
      .onConflictDoNothing()
      .returning({ id: activityTable.id });
    if (!created) {
      const [existing] = await tx.select({ id: activityTable.id }).from(activityTable).where(eq(activityTable.sourceRef, sourceRef!));
      return { id: existing.id, duplicate: true };
    }
    const extra = [
      ...input.projectIds.map((id) => ({ type: "project" as const, id })),
      ...input.personIds.map((id) => ({ type: "person" as const, id })),
    ].filter((e) => !(primary && e.type === primary.type && e.id === primary.id));
    if (extra.length) {
      await tx
        .insert(linksTable)
        .values(extra.map((e) => ({ fromType: "activity" as const, fromId: created.id, toType: e.type, toId: e.id, createdBy: w.actor })))
        .onConflictDoNothing();
    }
    for (const id of input.personIds) {
      await tx
        .update(peopleTable)
        .set({ lastContactAt: sql`greatest(coalesce(${peopleTable.lastContactAt}, ${input.occurredAt.toISOString()}::timestamptz), ${input.occurredAt.toISOString()}::timestamptz)` })
        .where(eq(peopleTable.id, id));
    }
    await writeAudit(tx, {
      actor: w.actor,
      clientId: w.clientId,
      action: "create",
      entityType: "activity",
      entityId: created.id,
      payload: { via, kind: input.kind, people: input.personIds, projects: input.projectIds },
    });
    return { id: created.id, duplicate: false };
  });
}

/* ---------- Calendar ---------- */

export interface CalendarInput {
  sourceRef: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  attendees: string[];
  personal: boolean;
  personIds: number[];
  projectId: number | null;
  location: string | null;
}

/** Replaces every event from today 00:00 to the end of today + 7 days, London time (PRD 12). */
export async function replaceCalendar(w: Writer, events: CalendarInput[], now = new Date()): Promise<{ replaced: number; outsideWindow: number }> {
  const window = londonRange(todayLondon(now), 8);
  const inWindow = events.filter((e) => e.startsAt >= window.start && e.startsAt < window.end);
  const seen = new Set<string>();
  const unique = inWindow.filter((e) => (seen.has(e.sourceRef) ? false : (seen.add(e.sourceRef), true)));
  await db.transaction(async (tx) => {
    await tx.delete(calendarEventsTable).where(and(gte(calendarEventsTable.startsAt, window.start), lt(calendarEventsTable.startsAt, window.end)));
    for (const e of unique) {
      const values = {
        sourceRef: e.sourceRef,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        attendees: e.attendees,
        personal: e.personal,
        personIds: e.personIds,
        projectId: e.projectId,
        location: e.location,
      };
      await tx.insert(calendarEventsTable).values(values).onConflictDoUpdate({ target: calendarEventsTable.sourceRef, set: values });
    }
    await writeAudit(tx, {
      actor: w.actor,
      clientId: w.clientId,
      action: "replace",
      entityType: "calendar_event",
      payload: { count: unique.length, from: window.start.toISOString(), to: window.end.toISOString() },
    });
  });
  return { replaced: unique.length, outsideWindow: events.length - inWindow.length };
}

/** The last day the calendar window covers, for messages. */
export function calendarWindowEnd(now = new Date()): string {
  return addDays(todayLondon(now), 7);
}

/* ---------- Sweep runs ---------- */

export interface SweepCounts {
  itemsCreated?: number;
  itemsNoise?: number;
  itemsDuplicate?: number;
  activityLogged?: number;
  errors?: string[];
}

export async function startSweep(w: Writer, startedAt: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(sweepRunsTable).values({ startedAt, clientId: w.clientId }).returning({ id: sweepRunsTable.id });
    await writeAudit(tx, { actor: w.actor, clientId: w.clientId, action: "sweep_start", payload: { sweepRunId: row.id } });
    return row.id;
  });
}

export async function finishSweep(w: Writer, id: number, finishedAt: Date, counts: SweepCounts): Promise<boolean> {
  return db.transaction(async (tx) => {
    const done = await tx
      .update(sweepRunsTable)
      .set({
        finishedAt,
        itemsCreated: counts.itemsCreated ?? 0,
        itemsNoise: counts.itemsNoise ?? 0,
        itemsDuplicate: counts.itemsDuplicate ?? 0,
        activityLogged: counts.activityLogged ?? 0,
        errors: (counts.errors ?? []).slice(0, 50).map((e) => e.slice(0, 500)),
      })
      .where(and(eq(sweepRunsTable.id, id), eq(sweepRunsTable.clientId, w.clientId), sql`${sweepRunsTable.finishedAt} is null`))
      .returning({ id: sweepRunsTable.id });
    if (!done.length) return false;
    await writeAudit(tx, { actor: w.actor, clientId: w.clientId, action: "sweep_finish", payload: { sweepRunId: id, ...counts } });
    return true;
  });
}

