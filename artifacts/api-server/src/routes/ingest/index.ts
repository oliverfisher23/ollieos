/**
 * Ingest API (PRD 12) for the scheduled Claude sweep and any script.
 * Authorization: Bearer <INBOX_API_KEY>. Reads go through ai-data as the "Capture sweep" client;
 * writes are audited with actor "ingest". This folder never imports the database.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { CADENCES, RULE_MAX, RELATIONSHIPS, isIsoDate, todayLondon } from "@workspace/shared";
import { handle } from "../../lib/handle";
import {
  doneSinceForIngest,
  enabledNoiseRules,
  lastSweepFinishedAt,
  openTasksForIngest,
  resolvePick,
  visibleFact,
  visibleTaskId,
  type PickType,
} from "../../lib/ai-data/context";
import { buildScope, type AiScope } from "../../lib/ai-data/scope";
import { playbookForAi, resolvePlaybookForAi, resolveProductForAi } from "../../lib/ai-data/playbooks";
import { captureTask, enabledRules, finishSweep, logActivity, startSweep, type Writer } from "../../services/aiWrites";
import { attachMeetingNotes, findEventBySourceRef } from "../../services/briefs";
import { scheduledWork } from "../../services/scheduledWork";
import { refusedClaudeSources } from "../../services/connectors";
import { AttendeeSchema, syncCalendarFeed } from "../../services/calendarSync";
import { captureSweepClient, ingestKeyConfigured, ingestKeyMatches, touchClient } from "../../services/clients";
import { proposalReply, proposeOrganisation, proposePerson, proposeProject, type AiProposeResult } from "../../services/aiPropose";
import { FACT_ATTRIBUTES, SUGGESTION_SOURCES, propose, type ProposeMeta } from "../../services/suggestions";
import { ConflictError, NotFoundError, ValidationError } from "../../services/tasks";
import { parseLink, titleFromUrl } from "../../services/library";
import { runImport } from "../capture";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ingest?: { scope: AiScope; writer: Writer };
    }
  }
}

export const INGEST_ACTOR = "ingest";

async function requireIngestKey(req: Request, res: Response, next: NextFunction) {
  try {
    if (!ingestKeyConfigured()) {
      res.status(503).json({ error: "Ingest is not set up yet: INBOX_API_KEY is missing" });
      return;
    }
    const h = req.headers.authorization ?? "";
    const given = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
    if (!ingestKeyMatches(given)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Invalid ingest key" });
      return;
    }
    const client = await captureSweepClient();
    if (client.revokedAt) {
      res.status(403).json({ error: "The Capture sweep has been revoked in OllieOS Settings. Reconnect it there to resume." });
      return;
    }
    req.ingest = {
      scope: await buildScope({ id: client.id, name: client.name }),
      writer: { actor: INGEST_ACTOR, clientId: client.id },
    };
    await touchClient(client.id);
    next();
  } catch (err) {
    next(err);
  }
}

const router: IRouter = Router();
router.use("/ingest", requireIngestKey);

const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Use an ISO 8601 date and time");
const trimmed = (max: number) => z.string().trim().max(max);
const optText = (max: number) => trimmed(max).nullish();

const IngestItem = z.object({
  source: z.enum(["email", "slack", "meeting", "quarterly", "manual"]),
  source_ref: trimmed(500).min(1),
  kind: z.enum(["task", "promise"]).optional(),
  title: trimmed(300).min(1),
  snippet: optText(2000),
  source_quote: optText(2000),
  source_url: optText(2000),
  source_subject: optText(500),
  source_channel: optText(200),
  from_name: optText(200),
  from_address: optText(320),
  suggested_action: optText(500),
  suggested_priority: z.enum(["high", "medium", "low"]).nullish(),
  suggested_due: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date").nullish(),
  project_hint: optText(200),
  person_hint: optText(200),
  waiting_on_hint: optText(200),
  confidential: z.boolean().nullish(),
  captured_at: isoDateTime.nullish(),
});

/** POST /api/ingest/tasks: up to 100 items, each judged on its own. */
router.post(
  "/ingest/tasks",
  handle(async (req, res) => {
    const { scope, writer } = req.ingest!;
    const raw: unknown = Array.isArray(req.body) ? req.body : (req.body?.items ?? req.body?.tasks);
    if (!Array.isArray(raw)) throw new ValidationError("Send an array of items, or { items: [...] }");
    if (raw.length > 100) throw new ValidationError("At most 100 items per call");
    const rules = await enabledRules();
    const refused = await refusedClaudeSources();
    const results: { source_ref: string | null; outcome: "created" | "duplicate" | "noise" | "ignored" | "error"; task_id?: number; noise_rule_id?: number; error?: string; message?: string }[] = [];
    for (const entry of raw) {
      const parsed = IngestItem.safeParse(entry);
      const ref = typeof (entry as { source_ref?: unknown })?.source_ref === "string" ? (entry as { source_ref: string }).source_ref : null;
      if (!parsed.success) {
        results.push({ source_ref: ref, outcome: "error" as const, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      const it = parsed.data;
      // OllieOS reads this service itself now, so Claude's copy would arrive twice.
      if (it.source === "email" || it.source === "slack" || it.source === "meeting") {
        if (refused.has(it.source)) {
          const name = it.source === "email" ? "Gmail" : it.source === "slack" ? "Slack" : "Granola";
          results.push({ source_ref: it.source_ref, outcome: "ignored", message: `OllieOS reads ${name} itself now. Stop sending these.` });
          continue;
        }
      }
      const hint = (v: string | null | undefined, type: PickType) => (v ? resolvePick(scope, v, [type]) : Promise.resolve(null));
      const [project, person, waiting] = await Promise.all([hint(it.project_hint, "project"), hint(it.person_hint, "person"), hint(it.waiting_on_hint, "person")]);
      try {
        const r = await captureTask(
          writer,
          {
            title: it.title,
            kind: it.kind,
            source: it.source,
            sourceRef: it.source_ref,
            sourceUrl: it.source_url,
            sourceQuote: it.source_quote,
            sourceSubject: it.source_subject,
            sourceChannel: it.source_channel,
            snippet: it.snippet,
            suggestedAction: it.suggested_action,
            fromName: it.from_name,
            fromAddress: it.from_address,
            priority: it.suggested_priority ?? undefined,
            dueDate: it.suggested_due ?? null,
            projectId: project?.id ?? null,
            personId: person?.id ?? null,
            waitingOnPersonId: waiting?.id ?? null,
            confidential: it.confidential ?? null,
            capturedAt: it.captured_at ? new Date(it.captured_at) : null,
          },
          { applyNoise: true, via: "ingest", rules },
        );
        // Ids of hidden tasks are not handed back, so a reply never confirms a hidden item.
        const visible = r.taskId != null ? await visibleTaskId(scope, `task:${r.taskId}`) : null;
        results.push({
          source_ref: it.source_ref,
          outcome: r.outcome,
          ...(visible != null ? { task_id: visible } : {}),
          ...(r.noiseRuleId != null ? { noise_rule_id: r.noiseRuleId } : {}),
        });
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        results.push({ source_ref: it.source_ref, outcome: "error" as const, error: err.message });
      }
    }
    const count = (o: string) => results.filter((r) => r.outcome === o).length;
    res.json({ results, counts: { created: count("created"), noise: count("noise"), duplicate: count("duplicate"), ignored: count("ignored"), error: count("error") } });
  }),
);

router.get(
  "/ingest/cursor",
  handle(async (_req, res) => {
    const at = await lastSweepFinishedAt();
    res.json({ last_finished_at: at ? at.toISOString() : null });
  }),
);

const SweepRunBody = z
  .object({
    id: z.number().int().positive().optional(),
    started_at: isoDateTime.optional(),
    finished_at: isoDateTime.optional(),
    items_created: z.number().int().min(0).optional(),
    items_noise: z.number().int().min(0).optional(),
    items_duplicate: z.number().int().min(0).optional(),
    activity_logged: z.number().int().min(0).optional(),
    errors: z.array(z.string().max(2000)).max(200).optional(),
  })
  .strict();

/**
 * POST /api/ingest/sweep-run. Without an id it starts a run and returns the id. With an id it
 * finishes that run. Without an id but with finished_at, it records a whole run in one call.
 */
router.post(
  "/ingest/sweep-run",
  handle(async (req, res) => {
    const { writer } = req.ingest!;
    const b = SweepRunBody.parse(req.body ?? {});
    const counts = {
      itemsCreated: b.items_created,
      itemsNoise: b.items_noise,
      itemsDuplicate: b.items_duplicate,
      activityLogged: b.activity_logged,
      errors: b.errors,
    };
    if (b.id == null) {
      const id = await startSweep(writer, b.started_at ? new Date(b.started_at) : new Date());
      if (b.finished_at) await finishSweep(writer, id, new Date(b.finished_at), counts);
      res.status(201).json({ id, finished: !!b.finished_at, ...(b.finished_at ? { scheduled: await scheduledWork("sweep") } : {}) });
      return;
    }
    const done = await finishSweep(writer, b.id, b.finished_at ? new Date(b.finished_at) : new Date(), counts);
    if (!done) {
      res.status(409).json({ error: "That sweep run does not exist or is already finished" });
      return;
    }
    res.json({ id: b.id, finished: true, scheduled: await scheduledWork("sweep") });
  }),
);

const CalendarBody = z.object({
  events: z
    .array(
      z.object({
        source_ref: trimmed(500).min(1),
        title: trimmed(300).min(1),
        starts_at: isoDateTime,
        ends_at: isoDateTime,
        attendees: z.array(AttendeeSchema).max(100).optional(),
        personal: z.boolean().optional(),
        people: z.array(z.string().max(200)).max(50).optional(),
        project: optText(200),
        location: optText(500),
        platform: optText(40),
      }),
    )
    .max(500),
});

router.post(
  "/ingest/calendar",
  handle(async (req, res) => {
    const { scope, writer } = req.ingest!;
    const body = CalendarBody.parse(Array.isArray(req.body) ? { events: req.body } : (req.body ?? {}));
    const r = await syncCalendarFeed(scope, writer, body.events);
    if (r.ignored) {
      res.json({ replaced: 0, removed: 0, ignored: true, message: r.ignored });
      return;
    }
    res.json({ replaced: r.replaced, removed: r.removed, skipped_outside_window: r.outsideWindow, unmatched: r.unmatched });
  }),
);

const MeetingNotesBody = z.object({
  calendar_source_ref: trimmed(500).min(1),
  granola_ref: trimmed(500).min(1),
  notes: trimmed(50000).min(1),
  source_url: optText(2000),
  decisions: z
    .array(
      z.object({
        text: trimmed(2000).min(1),
        decided_by: optText(200),
        decided_at: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date").nullish(),
        project: optText(200),
        confidential: z.boolean().nullish(),
      }),
    )
    .max(50)
    .optional(),
  actions: z
    .array(
      z.object({
        title: trimmed(300).min(1),
        source_ref: optText(500),
        due_date: z.string().refine(isIsoDate, "Use a YYYY-MM-DD date").nullish(),
        priority: z.enum(["high", "medium", "low"]).nullish(),
        person: optText(200),
      }),
    )
    .max(50)
    .optional(),
});

/**
 * POST /api/ingest/meeting-notes (feature 03 rule 6, build plan 31). Attaches Granola notes to the
 * meeting's brief. Actions go to the Inbox; when the sweep has already captured an action, send the
 * same source_ref and the existing Inbox item is linked rather than duplicated. Decisions become
 * Knowledge Inbox suggestions on the meeting's project, or the project named on the decision.
 */
router.post(
  "/ingest/meeting-notes",
  handle(async (req, res) => {
    const { scope, writer } = req.ingest!;
    const b = MeetingNotesBody.parse(req.body ?? {});
    // OllieOS reads Granola itself now, so these notes would arrive twice.
    if ((await refusedClaudeSources()).has("meeting")) {
      res.json({ attached: false, ignored: true, message: "OllieOS reads Granola itself now. Stop sending meeting notes." });
      return;
    }
    const event = await findEventBySourceRef(b.calendar_source_ref);
    if (!event) throw new NotFoundError("No calendar event has that source_ref. Send the calendar first.");
    if (event.personal) throw new ConflictError("Personal events have no brief");

    const actions: { title: string; outcome: string; task_id?: number; error?: string }[] = [];
    const taskIds: number[] = [];
    for (const [i, a] of (b.actions ?? []).entries()) {
      try {
        const person = a.person ? await resolvePick(scope, a.person, ["person"]) : null;
        const r = await captureTask(
          writer,
          {
            title: a.title,
            source: "meeting",
            sourceRef: a.source_ref ?? `granola:${b.granola_ref}:${i + 1}`,
            sourceUrl: b.source_url ?? null,
            sourceSubject: event.title,
            priority: a.priority ?? undefined,
            dueDate: a.due_date ?? null,
            projectId: event.projectId,
            personId: person?.id ?? null,
            capturedAt: new Date(),
          },
          { applyNoise: false, via: "meeting_notes" },
        );
        if (r.taskId != null) taskIds.push(r.taskId);
        const visible = r.taskId != null ? await visibleTaskId(scope, `task:${r.taskId}`) : null;
        actions.push({ title: a.title, outcome: r.outcome, ...(visible != null ? { task_id: visible } : {}) });
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        actions.push({ title: a.title, outcome: "error", error: err.message });
      }
    }

    const decisions: Record<string, unknown>[] = [];
    for (const d of b.decisions ?? []) {
      const named = d.project ? await resolvePick(scope, d.project, ["project"]) : null;
      const projectId = named?.id ?? event.projectId;
      if (projectId == null) {
        decisions.push({ text: d.text, error: "A decision needs a project. Name one on the decision, or link the meeting to a project." });
        continue;
      }
      const r = await propose(
        { proposedBy: scope.actor, clientId: writer.clientId, sourceType: "meeting", sourceRef: b.granola_ref, sourceUrl: b.source_url ?? null, sourceLabel: `Granola: ${event.title}`, saidBy: { name: d.decided_by ?? null, at: event.startsAt } },
        {
          kind: "decision",
          entityType: "project",
          entityId: projectId,
          payload: { text: d.text, decided_at: d.decided_at ?? todayLondon(), decided_by: d.decided_by ?? null, source: `Granola: ${event.title}`, confidential: d.confidential ?? null },
        },
      );
      decisions.push({ text: d.text, ...proposalReply(r) });
    }

    await attachMeetingNotes(event, { granolaRef: b.granola_ref, notes: b.notes, url: b.source_url ?? null, actionTaskIds: taskIds, actor: writer.actor, clientId: writer.clientId });
    res.json({ attached: true, actions, decisions });
  }),
);

async function resolveAll(scope: AiScope, names: string[], type: PickType) {
  const ids: number[] = [];
  const unmatched: string[] = [];
  for (const n of names) {
    const hit = await resolvePick(scope, n, [type]);
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
    } else unmatched.push(n);
  }
  return { ids, unmatched };
}

const hintList = z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]).nullish();
const ActivityEntry = z.object({
  kind: z.enum(["email", "meeting", "slack", "note", "task"]),
  summary: trimmed(1000).min(1),
  occurred_at: isoDateTime,
  source_url: optText(2000),
  source_ref: optText(500),
  people: hintList,
  projects: hintList,
  person_hint: hintList,
  project_hint: hintList,
});

/** PRD 14: Claude posts the reviewed one-off imports here. Each kind runs once. */
router.post(
  "/ingest/import",
  handle(async (req, res) => {
    const { writer } = req.ingest!;
    res.status(201).json(await runImport(req.body, writer.actor));
  }),
);

const asList = (...vals: (string | string[] | null | undefined)[]) => vals.flatMap((v) => (v == null ? [] : Array.isArray(v) ? v : [v])).filter((s) => s.trim());

router.post(
  "/ingest/activity",
  handle(async (req, res) => {
    const { scope, writer } = req.ingest!;
    const raw: unknown = Array.isArray(req.body) ? req.body : (req.body?.entries ?? req.body?.items ?? req.body?.activity);
    if (!Array.isArray(raw)) throw new ValidationError("Send an array of entries, or { entries: [...] }");
    if (raw.length > 200) throw new ValidationError("At most 200 entries per call");
    const refused = await refusedClaudeSources();
    const results = [];
    for (const entry of raw) {
      const parsed = ActivityEntry.safeParse(entry);
      if (!parsed.success) {
        results.push({ outcome: "error" as const, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      const a = parsed.data;
      if ((a.kind === "email" || a.kind === "slack" || a.kind === "meeting") && refused.has(a.kind)) {
        const what = a.kind === "email" ? "email" : a.kind === "slack" ? "Slack" : "meeting";
        results.push({ source_ref: a.source_ref ?? null, outcome: "ignored" as const, message: `OllieOS logs ${what} activity itself now.` });
        continue;
      }
      const [people, projects] = await Promise.all([
        resolveAll(scope, asList(a.people, a.person_hint), "person"),
        resolveAll(scope, asList(a.projects, a.project_hint), "project"),
      ]);
      const r = await logActivity(
        writer,
        {
          kind: a.kind,
          summary: a.summary,
          occurredAt: new Date(a.occurred_at),
          sourceUrl: a.source_url,
          sourceRef: a.source_ref,
          personIds: people.ids,
          projectIds: projects.ids,
        },
        "ingest",
      );
      results.push({
        source_ref: a.source_ref ?? null,
        outcome: r.duplicate ? ("duplicate" as const) : ("created" as const),
        unmatched: [...people.unmatched, ...projects.unmatched],
      });
    }
    res.json({ results, logged: results.filter((r) => r.outcome === "created").length });
  }),
);

/* ---------- Suggestions (feature 01) ---------- */

const SuggestionItem = z.object({
  kind: z.enum(["fact", "decision", "person", "organisation", "project", "document", "rule", "cadence", "relationship", "product", "playbook"]),
  /** fact: the project, person, organisation or product; decision: the project. Name, slug or ref. */
  entity: optText(200),
  text: optText(2000),
  attribute: z.enum(FACT_ATTRIBUTES).nullish(),
  supersedes: optText(40),
  decided_at: z.string().refine(isIsoDate, "Use YYYY-MM-DD").nullish(),
  decided_by: optText(200),
  confidential: z.boolean().nullish(),
  name: optText(200),
  slug: optText(200),
  email: z.string().trim().email().max(320).nullish(),
  organisation: optText(200),
  role: optText(200),
  relationship_summary: optText(2000),
  type: optText(200),
  area: optText(200),
  status: optText(200),
  summary: optText(5000),
  /** document */
  url: optText(2000),
  title: optText(300),
  /** document and rule: the projects it belongs to; rule: organisations too */
  projects: z.array(z.string().trim().min(1).max(200)).max(10).nullish(),
  organisations: z.array(z.string().trim().min(1).max(200)).max(10).nullish(),
  /** rule */
  applies_when: optText(300),
  rule: optText(RULE_MAX),
  /** product: name and summary (one line), plus facts; playbook: title, applies_when (when to use it), summary (purpose) */
  facts: z.array(z.string().trim().min(1).max(2000)).max(5).nullish(),
  /** playbook: for a change, the playbook's title or ref, with the whole new list of steps */
  playbook: optText(200),
  owner: optText(200),
  steps: z
    .array(z.object({ text: z.string().trim().min(1).max(600), person: optText(200), after_days: z.number().int().min(0).max(3650).nullish() }))
    .max(30)
    .nullish(),
  products: z.array(z.string().trim().min(1).max(200)).max(10).nullish(),
  /** cadence: entity is the person */
  cadence: z.enum(CADENCES).nullish(),
  reason: optText(500),
  /** relationship: entity <relationship> to, e.g. entity "Sam Lee", relationship "reports_to", to "Alex Kerr"; text is the evidence */
  relationship: z.enum(RELATIONSHIPS).nullish(),
  to: optText(200),
  source: optText(500),
  source_type: z.enum(SUGGESTION_SOURCES).nullish(),
  source_ref: optText(500),
  source_url: optText(2000),
  /** Part N: who made the claim, by name or email, and when */
  said_by: optText(200),
  said_at: optText(40),
});
type SuggestionItem = z.infer<typeof SuggestionItem>;

function saidByOf(who: string | null, when: string | null): ProposeMeta["saidBy"] {
  const at = when ? new Date(isIsoDate(when) ? `${when}T12:00:00Z` : when) : null;
  const ok = at && !Number.isNaN(at.getTime()) ? at : null;
  if (!who && !ok) return null;
  return { name: who && !who.includes("@") ? who : null, email: who?.includes("@") ? who : null, at: ok };
}

async function suggestOne(scope: AiScope, writer: Writer, s: SuggestionItem): Promise<AiProposeResult | { error: string }> {
  const meta: ProposeMeta = {
    proposedBy: scope.actor,
    clientId: writer.clientId,
    sourceType: s.source_type ?? null,
    sourceRef: s.source_ref ?? null,
    sourceUrl: s.source_url ?? null,
    sourceLabel: s.source ?? null,
    saidBy: saidByOf(s.said_by ?? null, s.said_at ?? s.decided_at ?? null),
  };
  const exact = { partial: false };
  switch (s.kind) {
    case "fact": {
      if (!s.entity || !s.text) return { error: "A fact needs entity and text" };
      const product = await resolveProductForAi(scope, s.entity);
      const entity: { type: "project" | "person" | "organisation" | "product"; id: number } | null =
        (await resolvePick(scope, s.entity)) ?? (product ? { type: "product", id: product.id } : null);
      if (!entity) return { error: `No visible project, person, organisation or product matches "${s.entity}"` };
      let supersedes: number | null = null;
      if (s.supersedes) {
        const old = await visibleFact(scope, s.supersedes);
        if (!old || old.entityType !== entity.type || old.entityId !== entity.id) return { error: "supersedes must be a current fact on the same item" };
        supersedes = old.id;
      }
      return propose(meta, {
        kind: "fact",
        entityType: entity.type,
        entityId: entity.id,
        payload: { text: s.text, attribute: s.attribute ?? null, supersedes, source: s.source ?? null },
      });
    }
    case "decision": {
      if (!s.entity || !s.text) return { error: "A decision needs entity (the project) and text" };
      const project = await resolvePick(scope, s.entity, ["project"]);
      if (!project) return { error: `No visible project matches "${s.entity}"` };
      return propose(meta, {
        kind: "decision",
        entityType: "project",
        entityId: project.id,
        payload: { text: s.text, decided_at: s.decided_at ?? todayLondon(), decided_by: s.decided_by ?? null, source: s.source ?? null, confidential: s.confidential ?? null },
      });
    }
    case "person": {
      if (!s.name) return { error: "A person needs a name" };
      const match =
        (s.slug ? await resolvePick(scope, { slug: s.slug }, ["person"], exact) : null) ??
        (s.email ? await resolvePick(scope, { name: s.email }, ["person"], exact) : null) ??
        (await resolvePick(scope, { name: s.name }, ["person"], exact));
      const org = s.organisation ? await resolvePick(scope, s.organisation, ["organisation"], exact) : null;
      return proposePerson(meta, {
        matchId: match?.id ?? null,
        name: s.name,
        email: s.email,
        role: s.role,
        organisation: org ? { id: org.id, name: org.name } : null,
        relationshipSummary: s.relationship_summary,
      });
    }
    case "organisation": {
      if (!s.name) return { error: "An organisation needs a name" };
      const match =
        (s.slug ? await resolvePick(scope, { slug: s.slug }, ["organisation"], exact) : null) ?? (await resolvePick(scope, { name: s.name }, ["organisation"], exact));
      return proposeOrganisation(meta, { matchId: match?.id ?? null, name: s.name, type: s.type, summary: s.summary });
    }
    case "project": {
      if (!s.name) return { error: "A project needs a name" };
      const match = (s.slug ? await resolvePick(scope, { slug: s.slug }, ["project"], exact) : null) ?? (await resolvePick(scope, { name: s.name }, ["project"], exact));
      return proposeProject(meta, { matchId: match?.id ?? null, name: s.name, area: s.area, status: s.status, summary: s.summary });
    }
    case "document": {
      if (!s.url) return { error: "A document needs a url" };
      const url = parseLink(s.url);
      const projects = await picks(scope, s.projects, "project");
      if ("error" in projects) return projects;
      return propose(meta, {
        kind: "document",
        payload: {
          url: url.toString(),
          title: s.title ?? titleFromUrl(url),
          summary: s.summary ?? null,
          project_ids: projects.map((p) => p.id),
          project_names: projects.map((p) => p.name),
        },
      });
    }
    case "rule": {
      if (!s.title || !s.applies_when || !s.rule) return { error: "A rule needs title, applies_when and rule" };
      const projects = await picks(scope, s.projects, "project");
      if ("error" in projects) return projects;
      const orgs = await picks(scope, s.organisations, "organisation");
      if ("error" in orgs) return orgs;
      return propose(meta, {
        kind: "rule",
        payload: {
          title: s.title,
          applies_when: s.applies_when,
          rule: s.rule,
          project_ids: projects.map((p) => p.id),
          organisation_ids: orgs.map((o) => o.id),
          link_names: [...projects, ...orgs].map((x) => x.name),
        },
      });
    }
    case "product": {
      if (!s.name) return { error: "A product needs a name" };
      if (await resolveProductForAi(scope, s.name)) return { error: `OllieOS already has "${s.name}"; add facts to it with kind fact` };
      return propose(meta, { kind: "product", payload: { name: s.name, description: s.summary ?? null, facts: s.facts ?? [] } });
    }
    case "playbook": {
      let playbookId: number | null = null;
      if (s.playbook) {
        playbookId = await resolvePlaybookForAi(scope, s.playbook);
        if (playbookId == null) return { error: `No playbook in use matches "${s.playbook}"` };
        if (!s.steps?.length) return { error: "A playbook change needs the whole new list of steps" };
      } else if (!s.title || !s.applies_when || !s.steps?.length) {
        return { error: "A new playbook needs title, applies_when (when to use it) and steps" };
      }
      const person = async (v: string | null | undefined) => (v ? ((await resolvePick(scope, v, ["person"]))?.id ?? null) : null);
      const steps = await Promise.all(s.steps!.map(async (x) => ({ text: x.text, person_id: await person(x.person), after_days: x.after_days ?? null })));
      if (playbookId != null) {
        // Keep the ids of steps whose text is unchanged, so the card shows what really changed.
        const current = await playbookForAi(scope, playbookId);
        const byText = new Map((current?.steps ?? []).map((x) => [x.text.trim().toLowerCase(), x.id]));
        const withIds = steps.map((x) => ({ ...x, id: byText.get(x.text.trim().toLowerCase()) ?? null }));
        const ownerId = await person(s.owner);
        return propose(meta, {
          kind: "playbook",
          payload: { playbook_id: playbookId, title: "", when_to_use: "", steps: withIds, ...(ownerId != null ? { owner_id: ownerId } : {}), reason: s.reason ?? null },
        });
      }
      const projects = await picks(scope, s.projects, "project");
      if ("error" in projects) return projects;
      const orgs = await picks(scope, s.organisations, "organisation");
      if ("error" in orgs) return orgs;
      const products: { id: number; name: string }[] = [];
      for (const n of s.products ?? []) {
        const hit = await resolveProductForAi(scope, n);
        if (!hit) return { error: `No visible product matches "${n}"` };
        products.push(hit);
      }
      return propose(meta, {
        kind: "playbook",
        payload: {
          title: s.title!,
          when_to_use: s.applies_when!,
          purpose: s.summary ?? null,
          owner_id: await person(s.owner),
          steps,
          project_ids: projects.map((p) => p.id),
          organisation_ids: orgs.map((o) => o.id),
          product_ids: products.map((p) => p.id),
          link_names: [...projects, ...orgs, ...products].map((x) => x.name),
        },
      });
    }
    case "cadence": {
      if (!s.entity || !s.cadence) return { error: "A cadence suggestion needs entity (the person) and cadence" };
      const person = await resolvePick(scope, s.entity, ["person"]);
      if (!person) return { error: `No visible person matches "${s.entity}"` };
      return propose(meta, { kind: "cadence", entityType: "person", entityId: person.id, payload: { cadence: s.cadence, reason: s.reason ?? null } });
    }
    case "relationship": {
      if (!s.entity || !s.to || !s.relationship) return { error: "A relationship suggestion needs entity, relationship and to" };
      const [from, to] = await Promise.all([resolvePick(scope, s.entity), resolvePick(scope, s.to)]);
      if (!from) return { error: `No visible project, person or organisation matches "${s.entity}"` };
      if (!to) return { error: `No visible project, person or organisation matches "${s.to}"` };
      return propose(meta, {
        kind: "relationship",
        entityType: from.type,
        entityId: from.id,
        payload: { relationship: s.relationship, to_type: to.type, to_id: to.id, note: s.text ?? s.reason ?? null },
      });
    }
  }
}

/** Resolves a list of names to visible projects or organisations; any miss is an error, so nothing links to the wrong item. */
async function picks(scope: AiScope, names: string[] | null | undefined, type: "project" | "organisation"): Promise<{ id: number; name: string }[] | { error: string }> {
  const out: { id: number; name: string }[] = [];
  for (const n of names ?? []) {
    const hit = await resolvePick(scope, n, [type]);
    if (!hit) return { error: `No visible ${type} matches "${n}"` };
    if (!out.some((o) => o.id === hit.id)) out.push({ id: hit.id, name: hit.name });
  }
  return out;
}

/**
 * POST /api/ingest/suggestions: facts, decisions, people, organisations, projects, documents,
 * rules and cadences for Ollie to approve. Same rules as the MCP tools; each item reports suggested, conflict, duplicate,
 * previously_rejected, unchanged or error.
 */
router.post(
  "/ingest/suggestions",
  handle(async (req, res) => {
    const { scope, writer } = req.ingest!;
    const raw: unknown = Array.isArray(req.body) ? req.body : (req.body?.suggestions ?? req.body?.items);
    if (!Array.isArray(raw)) throw new ValidationError("Send an array of suggestions, or { suggestions: [...] }");
    if (raw.length > 100) throw new ValidationError("At most 100 suggestions per call");
    const results: Record<string, unknown>[] = [];
    for (const item of raw) {
      const parsed = SuggestionItem.safeParse(item);
      if (!parsed.success) {
        results.push({ status: "error", error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      try {
        const r = await suggestOne(scope, writer, parsed.data);
        results.push("error" in r ? { status: "error", error: r.error } : proposalReply(r));
      } catch (err) {
        if (err instanceof ValidationError) results.push({ status: "error", error: err.message });
        else throw err;
      }
    }
    const count = (st: string) => results.filter((r) => r.status === st).length;
    res.json({
      results,
      counts: {
        suggested: count("suggested"),
        conflict: count("conflict"),
        duplicate: count("duplicate"),
        previously_rejected: count("previously_rejected"),
        unchanged: count("unchanged"),
        error: count("error"),
      },
    });
  }),
);

router.get("/ingest/noise-rules", handle(async (_req, res) => void res.json({ rules: await enabledNoiseRules() })));

router.get(
  "/ingest/open-tasks",
  handle(async (req, res) => {
    res.json({ tasks: await openTasksForIngest(req.ingest!.scope) });
  }),
);

const DoneQuery = z.object({ since: isoDateTime });

router.get(
  "/ingest/done",
  handle(async (req, res) => {
    const { since } = DoneQuery.parse(req.query);
    res.json({ tasks: await doneSinceForIngest(req.ingest!.scope, new Date(since)) });
  }),
);

export default router;
