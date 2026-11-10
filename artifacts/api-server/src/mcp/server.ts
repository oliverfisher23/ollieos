/**
 * The OllieOS MCP server (PRD 11.2 and 11.3, build plan section 5).
 * Reads go through ai-data, writes through services/aiWrites. This folder never imports the
 * database (enforced by test/boundary.test.ts). There is deliberately no delete tool.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isIsoDate, todayLondon } from "@workspace/shared";
import {
  getContext,
  listTasksForAi,
  resolvePick,
  searchForAi,
  taskForAi,
  todayForAi,
  visibleFact,
  visibleTaskId,
  type PickType,
} from "../lib/ai-data/context";
import { requestAccess } from "../lib/ai-data/requests";
import type { AiScope } from "../lib/ai-data/scope";
import { SEARCH_TYPES } from "../lib/ai-data/search";
import { listMySuggestions } from "../lib/ai-data/suggestions";
import { proposalReply, proposePerson, proposeProject } from "../services/aiPropose";
import { FACT_ATTRIBUTES, SUGGESTION_SOURCES, propose, type ProposeMeta } from "../services/suggestions";
import {
  addNote,
  captureTask,
  logActivity,
  replaceCalendar,
  type Writer,
} from "../services/aiWrites";
import { updateTask, ValidationError, type TaskUpdateInput } from "../services/tasks";

export const SOURCE_OF_TRUTH =
  "OllieOS is the source of truth for Ollie's work: tasks, projects, people and decisions. Check it before asking Ollie for context.";

/** Sent once when a client connects. */
export const SERVER_INSTRUCTIONS = [
  SOURCE_OF_TRUTH,
  'A fact marked "needs_check": true may be out of date. If you rely on one, tell Ollie it may be out of date.',
  "Facts, decisions, new people, organisations and projects, and changes to existing records, are suggestions until Ollie approves them in his Knowledge Inbox. Use list_my_suggestions to avoid proposing the same thing twice. Tasks, promises, notes and activity go in directly.",
].join(" ");

const STATUSES = ["inbox", "now", "backlog", "waiting", "done", "noise"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;
const SOURCES = ["email", "slack", "meeting", "quarterly", "manual"] as const;
const ENTITY_TYPES = ["project", "person", "organisation"] as const;

const Pick = z
  .object({
    ref: z.string().max(40).optional().describe("A ref such as project:12"),
    slug: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
    type: z.enum(ENTITY_TYPES).optional(),
  })
  .describe("Which project, person or organisation: give a ref, a slug or a name");

const isoDate = z.string().refine(isIsoDate, "Use a YYYY-MM-DD date");
const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Use an ISO 8601 date and time");

type ErrCode = "not_found" | "invalid_input" | "forbidden";

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
}

function err(error: ErrCode, message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error, message }) }], isError: true };
}

const NOT_FOUND = (what: string) => err("not_found", `No ${what} matches that.`);

const HIDDEN_SAVE = {
  saved: true,
  hidden: true,
  message: "Saved. It is marked confidential, so it is hidden from AI tools.",
};

/** Turns validation errors from the services into invalid_input; anything else is a real fault. */
async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ValidationError) return err("invalid_input", e.message);
    throw e;
  }
}

function describe(text: string): string {
  return `${SOURCE_OF_TRUTH} ${text}`;
}

async function pickOrNull(scope: AiScope, pick: z.infer<typeof Pick> | string | null | undefined, types: PickType[]) {
  if (pick == null) return null;
  return resolvePick(scope, pick, types);
}

/** Resolves a list of names, slugs or emails to visible ids; anything else is reported as unmatched. */
async function resolveNames(scope: AiScope, names: string[] | undefined, type: PickType) {
  const ids: number[] = [];
  const unmatched: string[] = [];
  for (const n of names ?? []) {
    const hit = await resolvePick(scope, n, [type]);
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
    } else unmatched.push(n);
  }
  return { ids, unmatched };
}

export function buildMcpServer(scope: AiScope, writer: Writer, permissions: readonly string[]): McpServer {
  const server = new McpServer({ name: "OllieOS", version: "1.0.0" }, { instructions: SERVER_INSTRUCTIONS });

  /* ---------- Reads ---------- */

  server.registerTool(
    "search",
    {
      description: describe("Full-text search across tasks, projects, people, organisations, decisions and notes."),
      inputSchema: {
        query: z.string().min(1).max(500),
        types: z.array(z.enum(SEARCH_TYPES)).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
      },
    },
    async (a) => ok(await searchForAi(scope, a.query, a.types, a.limit ?? 20)),
  );

  server.registerTool(
    "get_context",
    {
      description: describe(
        "Everything about one project, person or organisation: summary, current facts, decisions, open tasks, promises, what they owe Ollie, people, notes and the last 20 touchpoints.",
      ),
      inputSchema: Pick.shape,
    },
    async (a) => {
      const out = await getContext(scope, a);
      return out ? ok(out) : NOT_FOUND("project, person or organisation");
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description: describe("Lists tasks and promises. By default returns open ones (inbox, now, backlog, waiting)."),
      inputSchema: {
        status: z.array(z.enum(STATUSES)).optional(),
        kind: z.enum(["task", "promise"]).optional(),
        project: Pick.optional(),
        person: Pick.optional(),
        due_before: isoDate.optional(),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
    },
    async (a) => {
      const out = await listTasksForAi(scope, a);
      return "error" in out ? err(out.error, out.message) : ok(out);
    },
  );

  /* ---------- Tasks ---------- */

  // Unregistered tools cannot be dispatched, even if a caller knows their names.
  if (permissions.includes("write")) {
  server.registerTool(
    "create_task",
    {
      description: describe(
        "Adds a task. It lands in Ollie's Inbox unless you give a status. Give source and source_ref when it came from an email, Slack message or meeting, so it is never captured twice.",
      ),
      inputSchema: {
        title: z.string().min(1).max(300),
        kind: z.enum(["task", "promise"]).optional(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        due_date: isoDate.optional(),
        project: Pick.optional(),
        person: Pick.optional(),
        waiting_on: Pick.optional(),
        notes: z.string().max(5000).optional(),
        source: z.enum(SOURCES).optional(),
        source_ref: z.string().max(500).optional(),
        source_url: z.string().url().max(2000).optional(),
        source_quote: z.string().max(2000).optional(),
        confidential: z.boolean().optional(),
      },
    },
    async (a) =>
      guard(async () => {
        const [project, person, waiting] = await Promise.all([
          pickOrNull(scope, a.project, ["project"]),
          pickOrNull(scope, a.person, ["person"]),
          pickOrNull(scope, a.waiting_on, ["person"]),
        ]);
        if (a.project && !project) return NOT_FOUND("project");
        if (a.person && !person) return NOT_FOUND("person");
        if (a.waiting_on && !waiting) return NOT_FOUND("person");
        const result = await captureTask(
          writer,
          {
            title: a.title,
            kind: a.kind,
            status: a.status,
            priority: a.priority,
            dueDate: a.due_date ?? null,
            source: a.source ?? "manual",
            sourceRef: a.source_ref,
            sourceUrl: a.source_url,
            sourceQuote: a.source_quote,
            notes: a.notes,
            projectId: project?.id ?? null,
            personId: person?.id ?? null,
            waitingOnPersonId: waiting?.id ?? null,
            confidential: a.confidential ?? null,
          },
          { applyNoise: true, via: "mcp" },
        );
        const task = result.taskId != null ? await taskForAi(scope, result.taskId, "create_task") : null;
        if (result.outcome === "duplicate") return ok(task ? { task, duplicate: true } : { duplicate: true, message: "Already captured." });
        return ok(task ? { task, duplicate: false } : HIDDEN_SAVE);
      }),
  );

  server.registerTool(
    "update_task",
    {
      description: describe("Changes a task: title, status (including done and noise), priority, due date, links, or adds to its notes. Done or noise takes a task off Ollie's lists."),
      inputSchema: {
        ref: z.string().max(40).describe("A task ref such as task:42"),
        title: z.string().min(1).max(300).optional(),
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        due_date: isoDate.nullable().optional(),
        project: Pick.nullable().optional(),
        person: Pick.nullable().optional(),
        waiting_on: Pick.nullable().optional(),
        notes_append: z.string().max(5000).optional(),
      },
    },
    async (a) =>
      guard(async () => {
        const id = await visibleTaskId(scope, a.ref);
        if (id == null) return NOT_FOUND("task");
        const input: TaskUpdateInput = {};
        if (a.title !== undefined) input.title = a.title;
        if (a.status !== undefined) input.status = a.status;
        if (a.priority !== undefined) input.priority = a.priority;
        if (a.due_date !== undefined) input.dueDate = a.due_date;
        for (const [key, field, type] of [
          ["project", "projectId", "project"],
          ["person", "personId", "person"],
          ["waiting_on", "waitingOnPersonId", "person"],
        ] as const) {
          const v = a[key];
          if (v === undefined) continue;
          if (v === null) {
            input[field] = null;
            continue;
          }
          const hit = await resolvePick(scope, v, [type]);
          if (!hit) return NOT_FOUND(type);
          input[field] = hit.id;
        }
        if (a.notes_append?.trim()) {
          const current = await taskForAi(scope, id, "update_task");
          input.notes = current?.notes ? `${current.notes}\n\n${a.notes_append.trim()}` : a.notes_append.trim();
        }
        await updateTask(id, input, scope.actor, scope.clientId);
        const task = await taskForAi(scope, id, "update_task");
        return task ? ok({ task }) : ok(HIDDEN_SAVE);
      }),
  );

  server.registerTool(
    "log_promise",
    {
      description: describe("Records something Ollie promised to do for someone, so it shows on his Home screen until it is kept."),
      inputSchema: {
        title: z.string().min(1).max(300),
        to_person: z.string().max(200).optional().describe("Name, slug or email"),
        project: z.string().max(200).optional(),
        due_date: isoDate.optional(),
        source: z.enum(SOURCES),
        source_ref: z.string().max(500).optional(),
        source_url: z.string().url().max(2000).optional(),
        source_quote: z.string().max(2000).optional(),
      },
    },
    async (a) =>
      guard(async () => {
        const [person, project] = await Promise.all([pickOrNull(scope, a.to_person, ["person"]), pickOrNull(scope, a.project, ["project"])]);
        const unmatched = [a.to_person && !person ? a.to_person : null, a.project && !project ? a.project : null].filter((x): x is string => !!x);
        const result = await captureTask(
          writer,
          {
            title: a.title,
            kind: "promise",
            dueDate: a.due_date ?? null,
            source: a.source,
            sourceRef: a.source_ref,
            sourceUrl: a.source_url,
            sourceQuote: a.source_quote,
            personId: person?.id ?? null,
            projectId: project?.id ?? null,
          },
          { applyNoise: false, via: "mcp" },
        );
        const task = result.taskId != null ? await taskForAi(scope, result.taskId, "log_promise") : null;
        return ok({ ...(task ? { task } : { message: "Already captured." }), duplicate: result.outcome === "duplicate", ...(unmatched.length ? { unmatched } : {}) });
      }),
  );

  /* ---------- Knowledge ---------- */

  const SourceFields = {
    source: z.string().max(500).optional().describe('Where this came from, for Ollie, e.g. "Email from Veronica Wilkinson, 30th October"'),
    source_type: z.enum(SUGGESTION_SOURCES).optional(),
    source_url: z.string().url().max(2000).optional(),
  };
  const metaOf = (a: { source?: string; source_type?: string; source_url?: string }): ProposeMeta => ({
    proposedBy: writer.actor,
    clientId: writer.clientId,
    sourceType: a.source_type ?? "chat",
    sourceUrl: a.source_url ?? null,
    sourceLabel: a.source ?? null,
  });

  server.registerTool(
    "add_fact",
    {
      description: describe(
        "Proposes a current fact about a project, person or organisation. It goes to Ollie's Knowledge Inbox and becomes knowledge once he approves it. To correct a fact, pass the old one's ref as supersedes. Give an attribute when the fact is one of the listed kinds, so disagreements are spotted.",
      ),
      inputSchema: {
        entity: Pick,
        text: z.string().min(1).max(2000),
        attribute: z.enum(FACT_ATTRIBUTES).optional().describe("job_title, organisation, status, next_step or decision_date"),
        supersedes: z.string().max(40).optional().describe("Ref of the fact this replaces, such as fact:7"),
        ...SourceFields,
      },
    },
    async (a) =>
      guard(async () => {
        const entity = await resolvePick(scope, a.entity);
        if (!entity) return NOT_FOUND("project, person or organisation");
        let supersedes: number | null = null;
        if (a.supersedes) {
          const old = await visibleFact(scope, a.supersedes);
          if (!old) return NOT_FOUND("current fact");
          if (old.entityType !== entity.type || old.entityId !== entity.id) return err("invalid_input", "That fact belongs to something else.");
          supersedes = old.id;
        }
        const r = await propose(metaOf(a), {
          kind: "fact",
          entityType: entity.type,
          entityId: entity.id,
          payload: { text: a.text.trim(), attribute: a.attribute ?? null, supersedes, source: a.source ?? null },
        });
        return ok(proposalReply(r));
      }),
  );

  server.registerTool(
    "log_decision",
    {
      description: describe("Proposes a decision on a project. It stays a proposal, not an agreed decision, until Ollie approves it in his Knowledge Inbox."),
      inputSchema: {
        project: Pick,
        text: z.string().min(1).max(2000),
        decided_at: isoDate.optional().describe("Default today"),
        decided_by: z.string().max(200).optional(),
        confidential: z.boolean().optional(),
        ...SourceFields,
      },
    },
    async (a) =>
      guard(async () => {
        const project = await resolvePick(scope, a.project, ["project"]);
        if (!project) return NOT_FOUND("project");
        const r = await propose(metaOf(a), {
          kind: "decision",
          entityType: "project",
          entityId: project.id,
          payload: {
            text: a.text.trim(),
            decided_at: a.decided_at ?? todayLondon(),
            decided_by: a.decided_by ?? null,
            source: a.source ?? null,
            confidential: a.confidential ?? null,
          },
        });
        return ok(proposalReply(r));
      }),
  );

  server.registerTool(
    "list_my_suggestions",
    {
      description: describe("Lists what you have proposed that is still waiting for Ollie, and what he rejected in the last 30 days. Check it before proposing, so you do not repeat yourself."),
      inputSchema: { status: z.enum(["pending", "rejected", "all"]).optional().describe("Default all") },
    },
    async (a) => guard(async () => ok(await listMySuggestions(scope, a.status ?? "all"))),
  );

  server.registerTool(
    "add_note",
    {
      description: describe("Adds a note to a project, person or organisation."),
      inputSchema: {
        entity: Pick,
        title: z.string().max(300).optional(),
        body: z.string().min(1).max(20000),
        confidential: z.boolean().optional(),
      },
    },
    async (a) =>
      guard(async () => {
        const entity = await resolvePick(scope, a.entity);
        if (!entity) return NOT_FOUND("project, person or organisation");
        const n = await addNote(writer, { entityType: entity.type, entityId: entity.id, title: a.title, body: a.body, confidential: a.confidential ?? null });
        if (a.confidential) return ok(HIDDEN_SAVE);
        return ok({ note: { ref: `note:${n.id}`, title: n.title, body: n.body, created_at: n.createdAt.toISOString() } });
      }),
  );

  server.registerTool(
    "log_activity",
    {
      description: describe("Records a touchpoint (an email, meeting or Slack thread) against people and projects, so their timelines stay current."),
      inputSchema: {
        kind: z.enum(["email", "meeting", "slack", "note", "task"]),
        summary: z.string().min(1).max(1000),
        occurred_at: isoDateTime,
        source_url: z.string().url().max(2000).optional(),
        source_ref: z.string().max(500).optional(),
        people: z.array(z.string().max(200)).max(50).optional().describe("Names, slugs or emails"),
        projects: z.array(z.string().max(200)).max(20).optional(),
      },
    },
    async (a) =>
      guard(async () => {
        const [people, projects] = await Promise.all([resolveNames(scope, a.people, "person"), resolveNames(scope, a.projects, "project")]);
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
          "mcp",
        );
        return ok({
          activity: { ref: `activity:${r.id}` },
          duplicate: r.duplicate,
          linked: { people: people.ids.map((i) => `person:${i}`), projects: projects.ids.map((i) => `project:${i}`) },
          unmatched: [...people.unmatched, ...projects.unmatched],
        });
      }),
  );

  server.registerTool(
    "upsert_person",
    {
      description: describe(
        "Proposes a new person, or new details for one that exists. Matches by slug, then email, then exact name. Either way it goes to Ollie's Knowledge Inbox for approval. Fields you leave out are kept.",
      ),
      inputSchema: {
        name: z.string().min(1).max(200),
        slug: z.string().max(200).optional(),
        email: z.string().email().max(320).optional(),
        organisation: z.string().max(200).optional().describe("Name or slug of an existing organisation"),
        role: z.string().max(200).optional(),
        relationship_summary: z.string().max(2000).optional(),
        ...SourceFields,
      },
    },
    async (a) =>
      guard(async () => {
        const exact = { partial: false };
        const match =
          (a.slug ? await resolvePick(scope, { slug: a.slug }, ["person"], exact) : null) ??
          (a.email ? await resolvePick(scope, { name: a.email }, ["person"], exact) : null) ??
          (await resolvePick(scope, { name: a.name }, ["person"], exact));
        const org = a.organisation ? await resolvePick(scope, a.organisation, ["organisation"], exact) : null;
        const r = await proposePerson(metaOf(a), {
          matchId: match?.id ?? null,
          name: a.name.trim(),
          email: a.email,
          role: a.role,
          organisation: org ? { id: org.id, name: org.name } : null,
          relationshipSummary: a.relationship_summary,
        });
        return ok({
          ...proposalReply(r),
          ...(match ? { person: { ref: `person:${match.id}`, name: match.name } } : {}),
          ...(a.organisation && !org ? { unmatched: [a.organisation] } : {}),
        });
      }),
  );

  server.registerTool(
    "upsert_project",
    {
      description: describe(
        "Proposes a new project, or new details for one that exists. Matches by slug, then exact name. Either way it goes to Ollie's Knowledge Inbox for approval. Fields you leave out are kept.",
      ),
      inputSchema: {
        name: z.string().min(1).max(200),
        slug: z.string().max(200).optional(),
        area: z.string().max(200).optional(),
        status: z.string().max(200).optional(),
        summary: z.string().max(5000).optional(),
        ...SourceFields,
      },
    },
    async (a) =>
      guard(async () => {
        const exact = { partial: false };
        const match =
          (a.slug ? await resolvePick(scope, { slug: a.slug }, ["project"], exact) : null) ?? (await resolvePick(scope, { name: a.name }, ["project"], exact));
        const r = await proposeProject(metaOf(a), { matchId: match?.id ?? null, name: a.name.trim(), area: a.area, status: a.status, summary: a.summary });
        return ok({ ...proposalReply(r), ...(match ? { project: { ref: `project:${match.id}`, name: match.name } } : {}) });
      }),
  );

  server.registerTool(
    "request_access",
    {
      description: describe(
        "Asks Ollie to open up something you cannot see, for one hour. Use the name or ref you were told about. The reply is the same whether or not it exists.",
      ),
      inputSchema: { item: z.string().min(1).max(200), reason: z.string().min(1).max(500) },
    },
    async (a) => ok(await requestAccess(scope, a.item, a.reason)),
  );

  server.registerTool(
    "upsert_calendar",
    {
      description: describe("Replaces Ollie's calendar from today to seven days ahead (London time) with the events given."),
      inputSchema: {
        events: z
          .array(
            z.object({
              source_ref: z.string().min(1).max(500),
              title: z.string().min(1).max(300),
              starts_at: isoDateTime,
              ends_at: isoDateTime,
              attendees: z.array(z.string().max(320)).max(100).optional(),
              personal: z.boolean().optional(),
              people: z.array(z.string().max(200)).max(50).optional(),
              project: z.string().max(200).optional(),
              location: z.string().max(500).optional(),
            }),
          )
          .max(500),
      },
    },
    async (a) =>
      guard(async () => {
        const unmatched = new Set<string>();
        const events = [];
        for (const e of a.events) {
          const people = await resolveNames(scope, e.people, "person");
          people.unmatched.forEach((u) => unmatched.add(u));
          // Unmatched names are reported, never a reason to drop the event (build plan 30).
          const project = e.project ? await resolvePick(scope, e.project, ["project"]) : null;
          if (e.project && !project) unmatched.add(e.project);
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
        return ok({ replaced: r.replaced, unmatched: [...unmatched], ...(r.outsideWindow ? { skipped_outside_window: r.outsideWindow } : {}) });
      }),
  );

  }

  /* ---------- Resources ---------- */

  const json = (uri: URL, value: unknown): ReadResourceResult => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value, null, 1) }],
  });

  server.registerResource(
    "today",
    "ollieos://today",
    { description: describe("Today: what to do next, waiting on, promises, done this week and the calendar."), mimeType: "application/json" },
    async (uri) => json(uri, await todayForAi(scope)),
  );

  for (const type of ["project", "person"] as const) {
    server.registerResource(
      type,
      new ResourceTemplate(`ollieos://${type}/{slug}`, { list: undefined }),
      { description: describe(`Everything about one ${type}, the same as get_context.`), mimeType: "application/json" },
      async (uri, vars) => {
        const slug = String(Array.isArray(vars.slug) ? vars.slug[0] : vars.slug);
        const out = await getContext(scope, { slug, type }, `resource_${type}`);
        if (!out) throw new Error(`No ${type} matches that.`);
        return json(uri, out);
      },
    );
  }

  return server;
}
