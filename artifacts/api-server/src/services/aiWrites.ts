/**
 * Writes from AI clients: the MCP tools and the ingest API (PRD 11 and 12).
 * Callers resolve names to visible ids through ai-data first; these functions only write.
 * Every write is audited with the client's actor name and client id, in the same transaction.
 * There is deliberately nothing here that deletes Ollie's data (criterion 7); the calendar is a
 * copy of Ollie's real calendar, so events dropped from the feed are removed.
 */
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  captureLogTable,
  db,
  linksTable,
  noiseRulesTable,
  notesTable,
  sweepRunsTable,
  tasksTable,
  type CalendarAttendee,
  type NoiseRule,
} from "@workspace/db";
import { addDays, londonRange, todayLondon, type Priority, type TaskSource, type TaskStatus } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { cleanText, touch } from "./knowledge/common";
import { ValidationError } from "./tasks";
import { recordContact } from "./cadence";

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

const CONTACT_KINDS = new Set(["email", "meeting", "slack"]);

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
    // Only real contact counts towards cadence: email, meetings and Slack, never notes (feature 05 rule 2).
    if (CONTACT_KINDS.has(input.kind)) await recordContact(tx, input.personIds, input.occurredAt);
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
  /** Names only, for display and the AI name filter */
  attendees: string[];
  attendeeDetails: CalendarAttendee[];
  platform: string | null;
  personal: boolean;
  personIds: number[];
  projectId: number | null;
  location: string | null;
}

/** Attendees arrive as plain names or emails, or as objects with an email and response. */
export type AttendeeInput = string | { name?: string | null; email?: string | null; response?: string | null; organiser?: boolean | null };

const RESPONSES = new Set(["accepted", "tentative", "declined", "none"]);

export function normaliseAttendees(list: AttendeeInput[] | undefined): { names: string[]; details: CalendarAttendee[] } {
  const details: CalendarAttendee[] = [];
  for (const a of list ?? []) {
    if (typeof a === "string") {
      const v = a.trim();
      if (!v) continue;
      details.push(v.includes("@") && !v.includes(" ") ? { name: v, email: v.toLowerCase() } : { name: v });
      continue;
    }
    const email = cleanText(a.email)?.toLowerCase() ?? null;
    const name = cleanText(a.name) ?? email;
    if (!name) continue;
    const response = a.response ? a.response.trim().toLowerCase().replace("needsaction", "none").replace("needs_action", "none") : null;
    details.push({
      name,
      ...(email ? { email } : {}),
      ...(response && RESPONSES.has(response) ? { response: response as CalendarAttendee["response"] } : {}),
      ...(a.organiser ? { organiser: true } : {}),
    });
  }
  return { names: details.map((d) => d.name), details };
}

/** Teams, Zoom, Meet or In person, from the location when the sweep does not say. */
export function platformFor(given: string | null | undefined, location: string | null): string | null {
  const g = cleanText(given);
  if (g) return g;
  const l = (location ?? "").toLowerCase();
  if (!l) return null;
  if (l.includes("teams.microsoft") || /\bteams\b/.test(l)) return "Teams";
  if (l.includes("zoom.us") || /\bzoom\b/.test(l)) return "Zoom";
  if (l.includes("meet.google") || /\bgoogle meet\b/.test(l)) return "Meet";
  return "In person";
}

/**
 * Brings the calendar window (today 00:00 to the end of today + 7 days, London time) in line with
 * the feed. Events are upserted by source_ref so their ids, and the briefs hung off them, survive
 * each sweep. Events that have not started and are no longer in the feed are removed; events that
 * have started are kept, and cleared 30 days after they end (build plan 29).
 */
export async function replaceCalendar(
  w: { actor: string; clientId: number | null },
  events: CalendarInput[],
  now = new Date(),
): Promise<{ replaced: number; removed: number; outsideWindow: number }> {
  const window = londonRange(todayLondon(now), 8);
  const inWindow = events.filter((e) => e.startsAt >= window.start && e.startsAt < window.end);
  const seen = new Set<string>();
  const unique = inWindow.filter((e) => (seen.has(e.sourceRef) ? false : (seen.add(e.sourceRef), true)));
  let removed = 0;
  await db.transaction(async (tx) => {
    const future = await tx
      .select({ id: calendarEventsTable.id, sourceRef: calendarEventsTable.sourceRef })
      .from(calendarEventsTable)
      .where(and(gte(calendarEventsTable.startsAt, now > window.start ? now : window.start), lt(calendarEventsTable.startsAt, window.end)));
    const gone = future.filter((e) => !seen.has(e.sourceRef)).map((e) => e.id);
    if (gone.length) await tx.delete(calendarEventsTable).where(inArray(calendarEventsTable.id, gone));
    removed = gone.length;
    for (const e of unique) {
      const values = {
        sourceRef: e.sourceRef,
        title: e.title,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        attendees: e.attendees,
        attendeeDetails: e.attendeeDetails,
        platform: e.platform,
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
      action: "sync",
      entityType: "calendar_event",
      payload: { count: unique.length, removed, from: window.start.toISOString(), to: window.end.toISOString() },
    });
  });
  return { replaced: unique.length, removed, outsideWindow: events.length - inWindow.length };
}

/** Clears calendar events (and their briefs) that ended more than 30 days ago. */
export async function clearOldCalendar(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await db.delete(calendarEventsTable).where(lt(calendarEventsTable.endsAt, cutoff)).returning({ id: calendarEventsTable.id });
  return rows.length;
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

