import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AiError,
  SEARCH_TYPES,
  addFact,
  addNote,
  createTaskForAi,
  getContext,
  getToday,
  listTasksForAi,
  logActivity,
  logDecision,
  logPromiseForAi,
  replaceCalendar,
  requestAccess,
  sanitiseOutput,
  searchForAi,
  updateTaskForAi,
  upsertPerson,
  upsertProject,
  type AiScope,
  type Writer,
} from "../lib/ai-data";
import { logger } from "../lib/logger";

/** Every tool description opens with this (build plan section 5). */
export const DESCRIPTION_LEAD =
  "OllieOS is the source of truth for Ollie's work: tasks, projects, people and decisions. Check it before asking Ollie for context.";

const d = (rest: string) => `${DESCRIPTION_LEAD} ${rest}`;

const STATUSES = ["inbox", "now", "backlog", "waiting", "done", "noise"] as const;
const OPEN_STATUSES = ["inbox", "now", "backlog", "waiting"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;
const SOURCES = ["email", "slack", "meeting", "quarterly", "manual"] as const;
const KINDS = ["task", "promise"] as const;
const ENTITY_TYPES = ["project", "person", "organisation"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const entityPick = z
  .object({
    ref: z.string().optional().describe("A ref such as project:12"),
    slug: z.string().optional(),
    name: z.string().optional(),
    type: z.enum(ENTITY_TYPES).optional(),
  })
  .describe("Name the item with a ref, a slug or its exact name");

const date = z.string().regex(DATE, "Use a date like 2026-11-09");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs a tool body, passes the reply through the second visibility check, and turns AiErrors into tool errors. */
function runner(scope: AiScope, name: string) {
  return async (fn: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      const out = await sanitiseOutput(scope, await fn());
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    } catch (err) {
      if (err instanceof AiError) return { isError: true, content: [{ type: "text", text: JSON.stringify(err.toJSON()) }] };
      logger.error({ err, tool: name, clientId: scope.clientId }, "MCP tool failed");
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "internal", message: "OllieOS hit a problem. Try again." }) }] };
    }
  };
}

/** The tool names, for the acceptance test that no tool can delete anything. */
export interface ToolInfo {
  name: string;
  description: string;
}

/**
 * One MCP server per request (stateless Streamable HTTP, so it works on Autoscale).
 * Every tool reads and writes through lib/ai-data with this client's scope.
 * There is deliberately no tool that deletes anything (acceptance criterion 7).
 */
export function buildMcpServer(scope: AiScope, who: Writer): { server: McpServer; tools: ToolInfo[] } {
  const server = new McpServer({ name: "OllieOS", version: "1.0.0" }, { capabilities: { tools: {}, resources: {} } });
  const tools: ToolInfo[] = [];
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    annotations: typeof read,
    body: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
  ) => {
    tools.push({ name, description });
    const run = runner(scope, name);
    // The SDK's generic types for registerTool are heavier than the compiler likes; the shape is checked at runtime.
    (server.registerTool as (...a: unknown[]) => unknown)(name, { description, inputSchema, annotations }, (args: z.objectOutputType<S, z.ZodTypeAny>) =>
      run(() => body(args)),
    );
  };

  tool(
    "search",
    d("Full-text search across tasks, projects, people, organisations, decisions, notes and facts. Returns refs you can pass to get_context or update_task."),
    {
      query: z.string().min(1),
      types: z.array(z.enum(SEARCH_TYPES)).optional(),
      limit: z.number().int().min(1).max(50).optional().describe("Default 20, at most 50"),
    },
    read,
    (a) => searchForAi(scope, a),
  );

  tool(
    "get_context",
    d(
      "Everything OllieOS knows about one project, person or organisation: summary, facts, decisions, open tasks, promises, what Ollie is waiting on them for, related people and projects, notes and the last 20 activity items. Use it before drafting anything for Ollie.",
    ),
    entityPick.shape,
    read,
    (a) => getContext(scope, a),
  );

  tool(
    "list_tasks",
    d("Lists tasks. Defaults to open tasks (inbox, now, backlog, waiting). Filter by status, kind, project, person or due date."),
    {
      status: z.array(z.enum(STATUSES)).optional(),
      kind: z.enum(KINDS).optional(),
      project: entityPick.optional(),
      person: entityPick.optional(),
      due_before: date.optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
    },
    read,
    (a) => listTasksForAi(scope, a),
  );

  tool(
    "create_task",
    d(
      "Adds a task or promise. It lands in Ollie's Inbox unless you give another status. Pass source and source_ref when the task comes from an email, Slack message or meeting, so the same item is never added twice.",
    ),
    {
      title: z.string().min(1),
      kind: z.enum(KINDS).optional(),
      status: z.enum(OPEN_STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      due_date: date.optional(),
      project: entityPick.optional(),
      person: entityPick.optional(),
      waiting_on: entityPick.optional().describe("The person Ollie is waiting on"),
      notes: z.string().optional(),
      source: z.enum(SOURCES).optional(),
      source_ref: z.string().optional(),
      source_url: z.string().optional(),
      source_quote: z.string().optional(),
      confidential: z.boolean().optional().describe("True hides the task from every AI tool, including you, from the moment it is saved"),
    },
    write,
    (a) => createTaskForAi(scope, who, a),
  );

  tool(
    "update_task",
    d(
      "Edits a task by ref: title, status, priority, due date, project, person, who Ollie is waiting on, or appends to its notes. To clear a task off Ollie's list, set its status to done or noise. Pass null to clear a field.",
    ),
    {
      ref: z.string().describe("A task ref such as task:42"),
      title: z.string().optional(),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      due_date: date.nullable().optional(),
      project: entityPick.nullable().optional(),
      person: entityPick.nullable().optional(),
      waiting_on: entityPick.nullable().optional(),
      notes_append: z.string().optional(),
    },
    write,
    (a) => updateTaskForAi(scope, who, a),
  );

  tool(
    "add_fact",
    d("Records a durable fact about a project, person or organisation. Pass supersedes with an older fact's ref when this one replaces it."),
    {
      entity: entityPick,
      text: z.string().min(1),
      source: z.string().optional().describe("Where the fact came from, for example an email subject"),
      supersedes: z.string().optional().describe("A fact ref such as fact:7"),
    },
    write,
    (a) => addFact(scope, who, a),
  );

  tool(
    "log_decision",
    d("Logs a decision on a project. decided_at defaults to today."),
    {
      project: entityPick,
      text: z.string().min(1),
      decided_at: date.optional(),
      decided_by: z.string().optional(),
      source: z.string().optional(),
      confidential: z.boolean().optional(),
    },
    write,
    (a) => logDecision(scope, who, a),
  );

  tool(
    "add_note",
    d("Adds a note to a project, person or organisation (or a task or decision, by ref)."),
    {
      entity: entityPick,
      title: z.string().optional(),
      body: z.string().min(1),
      confidential: z.boolean().optional(),
    },
    write,
    (a) => addNote(scope, who, a),
  );

  tool(
    "log_activity",
    d("Logs a touchpoint (email, meeting, Slack thread, note or task) against people and projects. People and projects can be names, slugs or emails. Pass source_ref so the same touchpoint is logged once."),
    {
      kind: z.enum(["email", "meeting", "slack", "note", "task"]),
      summary: z.string().min(1),
      occurred_at: z.string().describe("ISO date-time"),
      source_url: z.string().optional(),
      source_ref: z.string().optional(),
      people: z.array(z.string()).optional(),
      projects: z.array(z.string()).optional(),
    },
    write,
    (a) => logActivity(who, a, { grants: scope.grants, visibleOnly: true }),
  );

  tool(
    "upsert_person",
    d("Adds a person, or updates the one that matches by slug, then email, then exact name. Only the fields you pass are changed."),
    {
      name: z.string().min(1),
      slug: z.string().optional(),
      email: z.string().optional(),
      organisation: z.string().optional().describe("Organisation name; added if OllieOS does not have it"),
      role: z.string().optional(),
      relationship_summary: z.string().optional(),
    },
    write,
    (a) => upsertPerson(scope, who, a),
  );

  tool(
    "upsert_project",
    d("Adds a project, or updates the one that matches by slug, then exact name. Only the fields you pass are changed."),
    {
      name: z.string().min(1),
      slug: z.string().optional(),
      area: z.string().optional(),
      status: z.string().optional(),
      summary: z.string().optional(),
    },
    write,
    (a) => upsertProject(scope, who, a),
  );

  tool(
    "request_access",
    d(
      "Asks Ollie to open up an item you cannot see, for example one he mentioned by name. He approves it on his Home screen and you get access for one hour. The reply is the same whether or not the item exists.",
    ),
    {
      item: z.string().min(1).describe("The name or ref you were told about"),
      reason: z.string().min(1),
    },
    write,
    (a) => requestAccess(scope, a.item, a.reason),
  );

  tool(
    "log_promise",
    d("Records something Ollie promised to do for someone. It lands in his Inbox as a promise."),
    {
      title: z.string().min(1),
      to_person: z.string().optional().describe("Name, slug or email"),
      project: z.string().optional(),
      due_date: date.optional(),
      source: z.enum(SOURCES),
      source_ref: z.string().optional(),
      source_url: z.string().optional(),
      source_quote: z.string().optional(),
    },
    write,
    (a) => logPromiseForAi(scope, who, a),
  );

  tool(
    "upsert_calendar",
    d("Replaces Ollie's calendar for today and the next 7 days with the events you send. Events outside that window are skipped."),
    {
      events: z
        .array(
          z.object({
            source_ref: z.string().min(1),
            title: z.string().min(1),
            starts_at: z.string(),
            ends_at: z.string(),
            attendees: z.array(z.string()).optional(),
            personal: z.boolean().optional(),
            people: z.array(z.string()).optional(),
            project: z.string().optional(),
            location: z.string().optional(),
          }),
        )
        .max(500),
    },
    write,
    async (a) => {
      const r = await replaceCalendar(who, a.events, { grants: scope.grants, visibleOnly: true });
      return { replaced: r.replaced, skipped: r.skipped, unmatched_people: r.unmatched_people };
    },
  );

  /* ---------- Resources ---------- */

  const json = async (uri: URL, fn: () => Promise<unknown>) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await sanitiseOutput(scope, await fn())) }],
  });

  server.registerResource(
    "today",
    "ollieos://today",
    { title: "Today", description: d("Ollie's day: Do next, Waiting on, Promises, inbox count, today's calendar and the last sweep."), mimeType: "application/json" },
    (uri) => json(uri, () => getToday(scope)),
  );
  server.registerResource(
    "project",
    new ResourceTemplate("ollieos://project/{slug}", { list: undefined }),
    { title: "Project", description: d("Everything about one project, the same as get_context."), mimeType: "application/json" },
    (uri, vars) => json(uri, () => getContext(scope, { slug: String(vars.slug), type: "project" })),
  );
  server.registerResource(
    "person",
    new ResourceTemplate("ollieos://person/{slug}", { list: undefined }),
    { title: "Person", description: d("Everything about one person, the same as get_context."), mimeType: "application/json" },
    (uri, vars) => json(uri, () => getContext(scope, { slug: String(vars.slug), type: "person" })),
  );

  return { server, tools };
}
