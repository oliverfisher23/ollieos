/**
 * Functions and clients for projects (asked for 11th November 2026). AI suggests, for each project
 * that has no function or no client yet, which part of the business it belongs to and which
 * organisation it is for, using what OllieOS already knows about it. Each answer becomes a card in
 * the Knowledge Inbox; nothing changes until Ollie approves it.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, factsTable, organisationsTable, projectsTable, suggestionsTable, decisionsTable } from "@workspace/db";
import { BUSINESS_FUNCTIONS, BUSINESS_FUNCTION_LABELS, isBusinessFunction, toRef, type BusinessFunction, type RefType } from "@workspace/shared";
import { organisationVisible, projectVisible } from "../lib/ai-data/visibility";
import { loadVisibleDocs } from "../lib/ai-data/retrieve";
import { defaultScope } from "../lib/ai-data/scope";
import { searchItems } from "../lib/ai-data/search";
import { logger } from "../lib/logger";
import { haikuJson } from "./connectors/sorter";
import { PROJECT_ID, clientNamesSql } from "./knowledge/functions";
import { linkedIds } from "./knowledge/items";
import { normalise, propose, type OrganisationPayload, type ProposeMeta, type ProposeResult } from "./suggestions";

export const PROJECT_FUNCTION_ACTOR = "Function and client check";

const MAX_ITEMS = 24;
const MAX_CHARS = 40_000;

/** Sends a function for a project to the Knowledge Inbox, unless it already has that one. */
export async function proposeProjectFunction(meta: ProposeMeta, projectId: number, fn: BusinessFunction, reason: string | null): Promise<ProposeResult | { status: "unchanged" }> {
  const [row] = await db.select({ function: projectsTable.function, isFunction: projectsTable.isFunction }).from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!row || row.isFunction || row.function === fn) return { status: "unchanged" };
  return propose(meta, {
    kind: "summary_change",
    entityType: "project",
    entityId: projectId,
    payload: { fields: { function: fn }, before: { function: row.function }, reason: reason?.trim().slice(0, 300) || null },
  });
}

/**
 * Sends a project's client to the Knowledge Inbox: a change card when OllieOS knows the
 * organisation, otherwise a new organisation card that links it when approved. When the same
 * organisation is already waiting as a card, the project is added to that card instead.
 */
export async function proposeProjectClient(
  meta: ProposeMeta,
  project: { id: number; name: string },
  clientName: string,
  reason: string | null,
  summary: string | null,
): Promise<ProposeResult | { status: "unchanged" }> {
  const name = clientName.trim();
  if (!name) return { status: "unchanged" };
  const [known] = await db
    .select({ id: organisationsTable.id })
    .from(organisationsTable)
    .where(sql`lower(${organisationsTable.name}) = ${name.toLowerCase()}`)
    .limit(1);
  if (known) {
    return propose(meta, {
      kind: "summary_change",
      entityType: "project",
      entityId: project.id,
      payload: { fields: { client: name }, before: { client: null }, client_id: known.id, reason: reason?.trim().slice(0, 300) || null },
    });
  }
  const [waiting] = await db
    .select({ id: suggestionsTable.id, payload: suggestionsTable.payload })
    .from(suggestionsTable)
    .where(and(eq(suggestionsTable.kind, "organisation"), eq(suggestionsTable.status, "pending"), eq(suggestionsTable.normalisedText, normalise(name))))
    .limit(1);
  if (waiting) {
    const p = waiting.payload as unknown as OrganisationPayload;
    if ((p.client_of_project_ids ?? []).includes(project.id)) return { status: "duplicate", suggestionId: waiting.id };
    const next: OrganisationPayload = {
      ...p,
      type: p.type || "customer",
      client_of_project_ids: [...(p.client_of_project_ids ?? []), project.id],
      client_of_project_names: [...(p.client_of_project_names ?? []), project.name],
    };
    await db.update(suggestionsTable).set({ payload: next as unknown as Record<string, unknown> }).where(eq(suggestionsTable.id, waiting.id));
    return { status: "suggested", suggestionId: waiting.id, hidden: false };
  }
  return propose(meta, {
    kind: "organisation",
    payload: { name, type: "customer", summary: summary?.trim().slice(0, 500) || null, client_of_project_ids: [project.id], client_of_project_names: [project.name] },
  });
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reasoning", "function", "function_why", "client", "client_why", "client_summary"],
  properties: {
    reasoning: { type: "string" },
    function: { type: "string", enum: [...BUSINESS_FUNCTIONS, "unclear"] },
    function_why: { type: "string" },
    client: { type: "string" },
    client_why: { type: "string" },
    client_summary: { type: "string" },
  },
} as const;

function system(orgs: string[]): string {
  const list = BUSINESS_FUNCTIONS.map((f) => `"${f}" (${BUSINESS_FUNCTION_LABELS[f]})`).join(", ");
  return [
    "You help Ollie Fisher at Springpod, a careers education company, file each of his projects.",
    "You get one project in <project> and what his knowledge base says about it in <known>, each item with a ref.",
    `"function" is the part of Springpod the project mainly belongs to, one of ${list}:`,
    "- delivery: running programmes and services for clients and partners once agreed, onboarding, reporting, account management.",
    "- product: building or changing Springpod's own products and platform.",
    "- sales: winning, pitching, renewing or expanding clients and partnerships, proposals, pricing, pipeline.",
    "- marketing: brand, campaigns, website, content and reaching students, schools or employers.",
    'Use "unclear" when the items do not say, only guess, or point equally at two. Never pick from the name alone.',
    '"client" is the outside organisation the project is for or with (a customer or partner), named as the items name it. Use an exact name from <organisations> when it is one of them. Give "" when the project is internal, or the items do not name one.',
    '"reasoning" comes first: a line or two on what the items say. "function_why" and "client_why" are one short line each, under 160 characters, saying what shows it, or "" when not given. "client_summary" is one sentence on who the client is to Springpod when it is not in <organisations>, otherwise "".',
    "Plain British English, no em dashes.",
    `<organisations>${orgs.length ? orgs.map((o) => `"${o}"`).join(", ") : "none yet"}</organisations>`,
  ].join("\n");
}

/** What AI may see about a project: itself, its facts, decisions and documents, and items that mention it. */
async function knownAbout(project: { id: number; name: string }): Promise<string> {
  const scope = defaultScope();
  const refs: string[] = [toRef("project", project.id)];
  const [facts, decisions, docs] = await Promise.all([
    db.select({ id: factsTable.id }).from(factsTable).where(and(eq(factsTable.entityType, "project"), eq(factsTable.entityId, project.id), sql`${factsTable.supersededBy} is null`)),
    db.select({ id: decisionsTable.id }).from(decisionsTable).where(eq(decisionsTable.projectId, project.id)).limit(8),
    linkedIds("project", project.id, "document"),
  ]);
  refs.push(...facts.map((f) => toRef("fact", f.id)), ...decisions.map((d) => toRef("decision", d.id)), ...docs.map((id) => toRef("document", id)));
  const hits = await searchItems({ q: project.name, types: ["document", "fact", "note", "session", "decision"], mode: "user", visibleOnly: true, scope, limitPerType: 6 });
  refs.push(...hits.sort((a, b) => b.rank - a.rank).map((h) => toRef(h.type as RefType, h.id)));
  const loaded = await loadVisibleDocs(scope, [...new Set(refs)].slice(0, MAX_ITEMS));
  let out = "";
  for (const d of loaded) {
    if (out.length + d.text.length > MAX_CHARS) break;
    out += d.text + "\n\n";
  }
  return out.trim();
}

export interface SuggestProjectFunctionsResult {
  checked: number;
  functions: number;
  clients: number;
  unclear: number;
}

const pendingField = (field: string) => sql`exists (select 1 from ${suggestionsTable} s where s.kind = 'summary_change' and s.status = 'pending'
  and s.entity_type = 'project' and s.entity_id = ${PROJECT_ID} and s.payload->'fields' ? ${field})`;

/**
 * Asks Haiku about every project AI may see that is missing a function or a client, and has no card
 * already waiting for it. Runs three projects at a time.
 */
export async function suggestProjectFunctions(): Promise<SuggestProjectFunctionsResult> {
  const rows = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      summary: projectsTable.summary,
      needsFunction: sql<boolean>`${projectsTable.function} is null and not ${pendingField("function")}`,
      needsClient: sql<boolean>`cardinality(${clientNamesSql(PROJECT_ID)}) = 0 and not ${pendingField("client")}
        and not exists (select 1 from ${suggestionsTable} s where s.kind = 'organisation' and s.status = 'pending'
          and s.payload->'client_of_project_ids' @> to_jsonb(${PROJECT_ID}))`,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.isFunction, false), eq(projectsTable.archived, false), sql.raw(projectVisible("projects"))));
  const projects = rows.filter((r) => r.needsFunction || r.needsClient);
  const result: SuggestProjectFunctionsResult = { checked: projects.length, functions: 0, clients: 0, unclear: 0 };
  if (!projects.length) return result;

  const orgs = await db
    .select({ name: organisationsTable.name })
    .from(organisationsTable)
    .where(and(sql.raw(organisationVisible("organisations")), sql`lower(coalesce(${organisationsTable.type}, '')) <> 'internal'`))
    .orderBy(organisationsTable.name)
    .limit(300);
  const sys = system(orgs.map((o) => o.name));
  const meta: ProposeMeta = { proposedBy: PROJECT_FUNCTION_ACTOR, clientId: null, sourceType: "documents", sourceLabel: "What OllieOS knows about the project" };

  const queue = [...projects];
  // Client cards one at a time, so two projects naming the same new organisation share one card.
  let clientTurn: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = clientTurn.then(fn, fn);
    clientTurn = next.catch(() => undefined);
    return next;
  };
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      let found = false;
      try {
        const known = await knownAbout(p);
        if (known) {
          const content = [`<project>`, `${p.name}${p.summary ? `: ${p.summary.slice(0, 500)}` : ""}`, `</project>`, `<known>`, known, `</known>`].join("\n");
          const r = await haikuJson<{ function?: string; function_why?: string; client?: string; client_why?: string; client_summary?: string }>(sys, content, SCHEMA, 1200);
          const tidy = (s: string | undefined) => (s ?? "").replace(/\s*—\s*/g, ", ").trim();
          if (p.needsFunction && isBusinessFunction(r.function)) {
            const out = await proposeProjectFunction(meta, p.id, r.function, tidy(r.function_why));
            if (out.status === "suggested") (result.functions++, (found = true));
          }
          const client = tidy(r.client);
          if (p.needsClient && client && client.toLowerCase() !== "springpod") {
            const project = p;
            const out = await oneAtATime(() => proposeProjectClient(meta, project, client, tidy(r.client_why), tidy(r.client_summary)));
            if (out.status === "suggested") (result.clients++, (found = true));
          }
        }
      } catch (err) {
        logger.error({ err, project: p.id }, "Function and client check failed");
      }
      if (!found) result.unclear++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return result;
}
