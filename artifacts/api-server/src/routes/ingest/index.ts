/**
 * Ingest API (PRD 12) for the scheduled Claude sweep and any script.
 * Authorization: Bearer <INBOX_API_KEY>. Reads go through ai-data as the "Capture sweep" client;
 * writes are audited with actor "ingest". This folder never imports the database.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { isIsoDate } from "@workspace/shared";
import { handle } from "../../lib/handle";
import {
  doneSinceForIngest,
  enabledNoiseRules,
  lastSweepFinishedAt,
  openTasksForIngest,
  resolvePick,
  visibleTaskId,
  type PickType,
} from "../../lib/ai-data/context";
import { buildScope, type AiScope } from "../../lib/ai-data/scope";
import { captureTask, enabledRules, finishSweep, logActivity, replaceCalendar, startSweep, type Writer } from "../../services/aiWrites";
import { captureSweepClient, ingestKeyConfigured, ingestKeyMatches, touchClient } from "../../services/clients";
import { ValidationError } from "../../services/tasks";

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
    const results: { source_ref: string | null; outcome: "created" | "duplicate" | "noise" | "error"; task_id?: number; noise_rule_id?: number; error?: string }[] = [];
    for (const entry of raw) {
      const parsed = IngestItem.safeParse(entry);
      const ref = typeof (entry as { source_ref?: unknown })?.source_ref === "string" ? (entry as { source_ref: string }).source_ref : null;
      if (!parsed.success) {
        results.push({ source_ref: ref, outcome: "error" as const, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      const it = parsed.data;
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
    res.json({ results, counts: { created: count("created"), noise: count("noise"), duplicate: count("duplicate"), error: count("error") } });
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
      res.status(201).json({ id, finished: !!b.finished_at });
      return;
    }
    const done = await finishSweep(writer, b.id, b.finished_at ? new Date(b.finished_at) : new Date(), counts);
    if (!done) {
      res.status(409).json({ error: "That sweep run does not exist or is already finished" });
      return;
    }
    res.json({ id: b.id, finished: true });
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
        attendees: z.array(z.string().max(320)).max(100).optional(),
        personal: z.boolean().optional(),
        people: z.array(z.string().max(200)).max(50).optional(),
        project: optText(200),
        location: optText(500),
      }),
    )
    .max(500),
});

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

router.post(
  "/ingest/calendar",
  handle(async (req, res) => {
    const { scope, writer } = req.ingest!;
    const body = CalendarBody.parse(Array.isArray(req.body) ? { events: req.body } : (req.body ?? {}));
    const unmatched = new Set<string>();
    const events = [];
    for (const e of body.events) {
      const people = await resolveAll(scope, e.people ?? [], "person");
      people.unmatched.forEach((u) => unmatched.add(u));
      const project = e.project ? await resolvePick(scope, e.project, ["project"]) : null;
      if ((e.project && !project) || people.unmatched.length) {
        throw new ValidationError("Every calendar association must match a visible project or person.");
      }
      events.push({
        sourceRef: e.source_ref,
        title: e.title,
        startsAt: new Date(e.starts_at),
        endsAt: new Date(e.ends_at),
        attendees: e.attendees ?? [],
        personal: e.personal ?? false,
        personIds: people.ids,
        projectId: project?.id ?? null,
        location: e.location ?? null,
      });
    }
    const r = await replaceCalendar(writer, events);
    res.json({ replaced: r.replaced, skipped_outside_window: r.outsideWindow, unmatched: [...unmatched] });
  }),
);

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

const asList = (...vals: (string | string[] | null | undefined)[]) => vals.flatMap((v) => (v == null ? [] : Array.isArray(v) ? v : [v])).filter((s) => s.trim());

router.post(
  "/ingest/activity",
  handle(async (req, res) => {
    const { scope, writer } = req.ingest!;
    const raw: unknown = Array.isArray(req.body) ? req.body : (req.body?.entries ?? req.body?.items ?? req.body?.activity);
    if (!Array.isArray(raw)) throw new ValidationError("Send an array of entries, or { entries: [...] }");
    if (raw.length > 200) throw new ValidationError("At most 200 entries per call");
    const results = [];
    for (const entry of raw) {
      const parsed = ActivityEntry.safeParse(entry);
      if (!parsed.success) {
        results.push({ outcome: "error" as const, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      const a = parsed.data;
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
