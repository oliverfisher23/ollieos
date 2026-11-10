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
import { findDocumentsForAi, getPlaybooksForAi, goalsForAi, overdueContactsForAi } from "../lib/ai-data/direction";
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
  type Writer,
} from "../services/aiWrites";
import { NotFoundError, updateTask, ValidationError, type TaskUpdateInput } from "../services/tasks";
import { AttendeeSchema, syncCalendarFeed } from "../services/calendarSync";
import { briefForAi, resolveEventForAi } from "../services/briefs";
import { saveSession, SESSION_LIMITS, type SessionAction } from "../services/sessions";

export const SOURCE_OF_TRUTH =
  "OllieOS is the source of truth for Ollie's work: tasks, projects, people and decisions. Check it before asking Ollie for context.";

/** Sent once when a client connects. */
export const SERVER_INSTRUCTIONS = [
  SOURCE_OF_TRUTH,
  'A fact marked "needs_check": true may be out of date. If you rely on one, tell Ollie it may be out of date.',
  "Facts, decisions, new people, organisations and projects, and changes to existing records, are suggestions until Ollie approves them in his Knowledge Inbox. Use list_my_suggestions to avoid proposing the same thing twice. Tasks, promises, notes and activity go in directly.",
  "Before drafting anything on Ollie's behalf, call get_playbooks for the project or person concerned and follow every rule it returns.",
  "In a Cowork session, call get_context for the project or person it is about before you start, and call save_session once at the end with what was done.",
].join(" ");

const STATUSES = ["inbox", "now", "backlog", "waiting", "done", "noise", "dropped"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;
const SOURCES = ["email", "slack", "meeting", "quarterly", "manual", "session"] as const;
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
    if (e instanceof NotFoundError) return err("not_found", e.message);
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
      description: describe("Full-text search across tasks, projects, people, organisations, decisions, notes, facts, documents and Cowork sessions."),
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
        "Everything about one project, person or organisation: summary, current facts, decisions, open tasks, promises, what they owe Ollie, people, notes, the last 20 touchpoints and the playbooks that apply. For a project, also its goal and its documents. Recent Cowork sessions about it are included, so a new session can pick up where the last one left off.",
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

  server.registerTool(
    "list_goals",
    {
      description: describe(
        "Ollie's goals for the year, with sub-goals, the projects serving each, and counts of open tasks and tasks due this week. Use it to judge what matters most. Targets of confidential goals are left out.",
      ),
      inputSchema: {},
    },
    async () => ok(await goalsForAi(scope)),
  );

  server.registerTool(
    "list_overdue_contacts",
    {
      description: describe(
        "People Ollie has not been in touch with for longer than the cadence he set for them, most overdue first. days_overdue is null when there is no contact on file. Paused cadences are left out.",
      ),
      inputSchema: {
        include_due_soon: z.boolean().optional().describe("Also list people whose check-in is due soon"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
    },
    async (a) => ok(await overdueContactsForAi(scope, { includeDueSoon: a.include_due_soon, limit: a.limit })),
  );

  server.registerTool(
    "find_documents",
    {
      description: describe(
        "Finds documents in Ollie's Library: links to files in Dropbox, Google Drive and Claude projects, with a summary. OllieOS holds the link, not the file. Narrow it to one project if you like.",
      ),
      inputSchema: {
        query: z.string().min(1).max(500),
        project: Pick.optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Default 20"),
      },
    },
    async (a) => {
      const project = a.project ? await resolvePick(scope, a.project, ["project"]) : null;
      if (a.project && !project) return NOT_FOUND("project");
      return ok(await findDocumentsForAi(scope, a.query, project?.id, a.limit ?? 20));
    },
  );

  server.registerTool(
    "get_playbooks",
    {
      description: describe(
        'Ollie\'s rules for drafting: terminology, tone and things to avoid. Give a context (a project, person or organisation) to get the rules that apply there, "general" for rules that apply everywhere, or nothing for all of them with what each applies to. Follow every rule returned.',
      ),
      inputSchema: {
        context: z.union([z.literal("general"), Pick]).optional(),
      },
    },
    async (a) => {
      if (a.context === undefined || a.context === "general") return ok({ playbooks: await getPlaybooksForAi(scope, a.context ?? null) });
      const hit = await resolvePick(scope, a.context);
      if (!hit) return NOT_FOUND("project, person or organisation");
      return ok({ context: { ref: `${hit.type}:${hit.id}`, name: hit.name }, playbooks: await getPlaybooksForAi(scope, hit) });
    },
  );

  server.registerTool(
    "get_meeting_brief",
    {
      description: describe(
        'The brief for a work meeting: why it matters (each line with the refs it rests on), who is coming, open promises to them, linked projects, goals, documents and playbooks, and questions to ask. Give "next" for the next work meeting today or tomorrow, or a calendar_event ref from ollieos://today. Personal events and meetings with nobody known have no brief.',
      ),
      inputSchema: {
        event: z.string().min(1).max(60).describe('"next", or a ref such as calendar_event:12'),
      },
    },
    async (a) =>
      guard(async () => {
        const id = await resolveEventForAi(scope, a.event);
        if (id == null) return NOT_FOUND("work meeting with a brief");
        return ok(await briefForAi(scope, id));
      }),
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
      description: describe("Changes a task: title, status (including done, noise and dropped), priority, due date, links, or adds to its notes. Done, noise or dropped takes a task off Ollie's lists. Dropped means it was real but Ollie decided not to do it; noise means it should never have come in."),
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
    "save_document",
    {
      description: describe(
        "Proposes keeping a document you wrote (an artifact, plan, notes or summary) in Ollie's Library, with its full text. It goes to his Knowledge Inbox; once he approves it, OllieOS keeps the text and reads it for knowledge. Use a clear title.",
      ),
      inputSchema: {
        title: z.string().min(1).max(300),
        content: z.string().min(1).max(200_000).describe("The full text, Markdown is fine"),
        kind: z.string().max(60).optional().describe('What it is, e.g. "plan", "notes", "brief", "analysis"'),
        summary: z.string().max(1000).optional().describe("One or two sentences on what it is"),
        project: Pick.optional().describe("The project it belongs to"),
        ...SourceFields,
      },
    },
    async (a) =>
      guard(async () => {
        const project = a.project ? await resolvePick(scope, a.project, ["project"]) : null;
        if (a.project && !project) return NOT_FOUND("project");
        const r = await propose(metaOf(a), {
          kind: "document",
          payload: {
            title: a.title.trim(),
            content: a.content,
            doc_kind: a.kind?.trim() || null,
            summary: a.summary?.trim() || null,
            url: null,
            project_ids: project ? [project.id] : [],
            project_names: project ? [project.name] : [],
          },
        });
        return ok(proposalReply(r));
      }),
  );

  server.registerTool(
    "save_session",
    {
      description: describe(
        "Saves a record of this Cowork session at its end, so Ollie can look back on it and future sessions can build on it. Call it once, after the work is done. Its actions go straight to Ollie's Inbox as tasks or promises; documents in artifacts are proposed for his Library; and OllieOS reads the session for facts and decisions, which wait in his Knowledge Inbox. Do not also call create_task or log_promise for the same actions. Give session_id if you have one, so saving again updates the same session.",
      ),
      inputSchema: {
        title: z.string().min(1).max(200).describe("A short title for what the session was about"),
        summary: z.string().min(1).max(3000).describe("What the session set out to do and where it ended up, in a few sentences"),
        outcomes: z.array(z.string().min(1).max(500)).max(SESSION_LIMITS.outcomes).optional().describe("What was done, one line each, including any decisions Ollie made"),
        transcript: z.string().max(200_000).optional().describe("The transcript, or its key parts"),
        happened_at: isoDateTime.optional().describe("When the session started, if not now"),
        session_id: z.string().max(200).optional().describe("Your own id for this session"),
        projects: z.array(z.string().max(200)).max(20).optional().describe("Projects it was about: names, slugs or refs"),
        people: z.array(z.string().max(200)).max(30).optional().describe("People it was about: names, emails or refs"),
        task_refs: z.array(z.string().max(40)).max(50).optional().describe("Tasks you already created or updated in this session, such as task:42"),
        actions: z
          .array(
            z.object({
              title: z.string().min(1).max(300),
              kind: z.enum(["task", "promise"]).optional().describe("promise when Ollie said he would do something for someone"),
              person: z.string().max(200).optional().describe("Who it is for: name, email or ref"),
              project: z.string().max(200).optional(),
              due_date: isoDate.optional(),
              quote: z.string().max(1000).optional().describe("The words it came from"),
            }),
          )
          .max(SESSION_LIMITS.actions)
          .optional()
          .describe("Follow-ups still to do after the session"),
        artifacts: z
          .array(
            z.object({
              title: z.string().min(1).max(300),
              content: z.string().min(1).max(200_000).describe("The full text, Markdown is fine"),
              kind: z.string().max(60).optional().describe('What it is, e.g. "plan", "brief", "analysis"'),
              summary: z.string().max(1000).optional(),
            }),
          )
          .max(SESSION_LIMITS.artifacts)
          .optional()
          .describe("Documents produced in the session worth keeping in the Library"),
        confidential: z.boolean().optional().describe("true when the session was about something sensitive, such as the company sale, the board, pay or HR"),
      },
    },
    async (a) =>
      guard(async () => {
        const [projects, people] = await Promise.all([resolveNames(scope, a.projects, "project"), resolveNames(scope, a.people, "person")]);
        const taskIds: number[] = [];
        const unmatchedTasks: string[] = [];
        for (const ref of a.task_refs ?? []) {
          const id = await visibleTaskId(scope, ref);
          if (id != null) taskIds.push(id);
          else unmatchedTasks.push(ref);
        }
        const actions: SessionAction[] = [];
        const unmatched = [...projects.unmatched, ...people.unmatched];
        for (const x of a.actions ?? []) {
          const [person, project] = await Promise.all([pickOrNull(scope, x.person, ["person"]), pickOrNull(scope, x.project, ["project"])]);
          if (x.person && !person) unmatched.push(x.person);
          if (x.project && !project) unmatched.push(x.project);
          actions.push({
            title: x.title,
            kind: x.kind ?? "task",
            personId: person?.id ?? null,
            projectId: project?.id ?? null,
            dueDate: x.due_date ?? null,
            quote: x.quote ?? null,
          });
        }
        const r = await saveSession(writer, {
          title: a.title,
          summary: a.summary,
          outcomes: a.outcomes ?? [],
          transcript: a.transcript ?? null,
          happenedAt: a.happened_at ? new Date(a.happened_at) : null,
          externalRef: a.session_id ?? null,
          projectIds: projects.ids,
          personIds: people.ids,
          taskIds,
          confidential: a.confidential ?? null,
          actions,
          artifacts: (a.artifacts ?? []).map((x) => ({ title: x.title, content: x.content, kind: x.kind ?? null, summary: x.summary ?? null })),
        });
        return ok({
          saved: true,
          session: r.visible ? `session:${r.id}` : undefined,
          updated: r.updated,
          tasks: r.tasks.map((t) => ({ ...(t.id != null && r.visible ? { ref: `task:${t.id}` } : {}), outcome: t.outcome })),
          artifacts: r.artifacts.map((x) => proposalReply(x)),
          message: r.visible
            ? "Saved. OllieOS will read it for facts and decisions and put them in Ollie's Knowledge Inbox."
            : "Saved. It is hidden from AI, so OllieOS will not read it for knowledge.",
          ...([...new Set(unmatched)].length ? { unmatched: [...new Set(unmatched)] } : {}),
          ...(unmatchedTasks.length ? { unmatched_tasks: unmatchedTasks } : {}),
        });
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
      description: describe(
        "Updates Ollie's calendar from today to seven days ahead (London time) with the events given. Events are matched on source_ref. Send the whole window each time: events that have not started and are not in the list drop off the calendar, and past events are kept. Use the Google Calendar event id as source_ref. When OllieOS reads Google Calendar itself, the call changes nothing and says so.",
      ),
      inputSchema: {
        events: z
          .array(
            z.object({
              source_ref: z.string().min(1).max(500),
              title: z.string().min(1).max(300),
              starts_at: isoDateTime,
              ends_at: isoDateTime,
              attendees: z.array(AttendeeSchema).max(100).optional().describe("Names or emails, or objects with name, email and response"),
              personal: z.boolean().optional(),
              people: z.array(z.string().max(200)).max(50).optional(),
              project: z.string().max(200).optional(),
              location: z.string().max(500).optional(),
              platform: z.string().max(40).optional().describe("Teams, Zoom, Meet or In person"),
            }),
          )
          .max(500),
      },
    },
    async (a) =>
      guard(async () => {
        const r = await syncCalendarFeed(scope, writer, a.events);
        if (r.ignored) return ok({ replaced: 0, removed: 0, ignored: true, message: r.ignored });
        return ok({
          replaced: r.replaced,
          removed: r.removed,
          unmatched: r.unmatched,
          ...(r.outsideWindow ? { skipped_outside_window: r.outsideWindow } : {}),
        });
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

  server.registerResource(
    "brief_next",
    "ollieos://brief/next",
    { description: describe("The brief for Ollie's next work meeting today or tomorrow, the same as get_meeting_brief with \"next\"."), mimeType: "application/json" },
    async (uri) => {
      const id = await resolveEventForAi(scope, "next");
      return json(uri, id == null ? { brief: null, message: "No work meeting with a brief between now and the end of tomorrow." } : await briefForAi(scope, id));
    },
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
