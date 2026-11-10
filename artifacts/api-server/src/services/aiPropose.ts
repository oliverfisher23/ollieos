/**
 * Turns AI writes to people, projects and organisations into suggestions: a new record becomes a
 * "New person" (or project, organisation) suggestion, and new values on an existing one become a
 * "Changed summary" or "Changed details" suggestion (build plan 26). Shared by MCP and ingest,
 * which resolve names to visible ids first.
 */
import { eq } from "drizzle-orm";
import { db, organisationsTable, peopleTable, projectsTable } from "@workspace/db";
import { cleanText } from "./knowledge/common";
import { propose, type ProposeMeta, type ProposeResult } from "./suggestions";

export type AiProposeResult = ProposeResult | { status: "unchanged"; ref: string };

/** Only fields given, non-empty and different from what is stored. */
function diff(current: Record<string, string | null>, given: Record<string, string | null | undefined>) {
  const fields: Record<string, string> = {};
  const before: Record<string, string | null> = {};
  for (const [k, raw] of Object.entries(given)) {
    const v = cleanText(raw ?? null);
    if (!v) continue;
    if ((current[k] ?? "").trim().toLowerCase() === v.toLowerCase()) continue;
    fields[k] = v;
    before[k] = current[k] ?? null;
  }
  return { fields, before };
}

export async function proposePerson(
  meta: ProposeMeta,
  input: {
    matchId: number | null;
    name: string;
    email?: string | null;
    role?: string | null;
    organisation?: { id: number; name: string } | null;
    relationshipSummary?: string | null;
  },
): Promise<AiProposeResult> {
  if (input.matchId == null) {
    return propose(meta, {
      kind: "person",
      payload: {
        name: input.name,
        email: cleanText(input.email)?.toLowerCase() ?? null,
        role: cleanText(input.role),
        organisation_id: input.organisation?.id ?? null,
        organisation_name: input.organisation?.name ?? null,
        relationship_summary: cleanText(input.relationshipSummary),
      },
    });
  }
  const [row] = await db.select().from(peopleTable).where(eq(peopleTable.id, input.matchId));
  const [org] = row?.organisationId ? await db.select({ name: organisationsTable.name }).from(organisationsTable).where(eq(organisationsTable.id, row.organisationId)) : [];
  const { fields, before } = diff(
    { role: row.role, email: row.email, relationship_summary: row.relationshipSummary, organisation: org?.name ?? null },
    { role: input.role, email: input.email?.toLowerCase(), relationship_summary: input.relationshipSummary, organisation: input.organisation?.name },
  );
  if (!Object.keys(fields).length) return { status: "unchanged", ref: `person:${input.matchId}` };
  return propose(meta, {
    kind: "summary_change",
    entityType: "person",
    entityId: input.matchId,
    payload: { fields, before, organisation_id: fields.organisation ? (input.organisation?.id ?? null) : null },
  });
}

export async function proposeProject(
  meta: ProposeMeta,
  input: { matchId: number | null; name: string; area?: string | null; status?: string | null; summary?: string | null },
): Promise<AiProposeResult> {
  if (input.matchId == null) {
    return propose(meta, {
      kind: "project",
      payload: { name: input.name, area: cleanText(input.area), status: cleanText(input.status), summary: cleanText(input.summary) },
    });
  }
  const [row] = await db.select().from(projectsTable).where(eq(projectsTable.id, input.matchId));
  const { fields, before } = diff({ area: row.area, status: row.status, summary: row.summary }, { area: input.area, status: input.status, summary: input.summary });
  if (!Object.keys(fields).length) return { status: "unchanged", ref: `project:${input.matchId}` };
  return propose(meta, { kind: "summary_change", entityType: "project", entityId: input.matchId, payload: { fields, before } });
}

export async function proposeOrganisation(
  meta: ProposeMeta,
  input: { matchId: number | null; name: string; type?: string | null; summary?: string | null },
): Promise<AiProposeResult> {
  if (input.matchId == null) {
    return propose(meta, { kind: "organisation", payload: { name: input.name, type: cleanText(input.type), summary: cleanText(input.summary) } });
  }
  const [row] = await db.select().from(organisationsTable).where(eq(organisationsTable.id, input.matchId));
  const { fields, before } = diff({ type: row.type, summary: row.summary }, { type: input.type, summary: input.summary });
  if (!Object.keys(fields).length) return { status: "unchanged", ref: `organisation:${input.matchId}` };
  return propose(meta, { kind: "summary_change", entityType: "organisation", entityId: input.matchId, payload: { fields, before } });
}

const MESSAGES = {
  suggested: "Sent to Ollie's Knowledge Inbox. It becomes knowledge once he approves it.",
  conflict: "This disagrees with a current fact, so it is waiting for Ollie to choose between them.",
  duplicate_pending: "The same suggestion is already waiting for Ollie.",
  duplicate_fact: "OllieOS already has this fact.",
  duplicate_known: "OllieOS already has this.",
  previously_rejected: "Ollie rejected the same suggestion in the last 30 days. Do not propose it again.",
  unchanged: "Nothing new: OllieOS already has these details.",
  hidden: "Sent to Ollie's Knowledge Inbox. It is marked confidential, so you will not see it again.",
};

/** The reply AI callers get, in snake_case. */
export function proposalReply(r: AiProposeResult): Record<string, unknown> {
  switch (r.status) {
    case "suggested":
      return r.hidden ? { status: "suggested", message: MESSAGES.hidden } : { status: "suggested", suggestion_id: r.suggestionId, message: MESSAGES.suggested };
    case "conflict":
      return { status: "conflict", suggestion_id: r.suggestionId, review_id: r.reviewId, message: MESSAGES.conflict };
    case "duplicate":
      return r.factId != null
        ? { status: "duplicate", fact: `fact:${r.factId}`, message: MESSAGES.duplicate_fact }
        : r.suggestionId != null
          ? { status: "duplicate", suggestion_id: r.suggestionId, message: MESSAGES.duplicate_pending }
          : { status: "duplicate", message: MESSAGES.duplicate_known };
    case "previously_rejected":
      return { status: "previously_rejected", suggestion_id: r.suggestionId, message: MESSAGES.previously_rejected };
    case "unchanged":
      return { status: "unchanged", ref: r.ref, message: MESSAGES.unchanged };
  }
}
