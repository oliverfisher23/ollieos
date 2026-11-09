import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  accessRequestsTable,
  activityTable,
  aiClientsTable,
  auditEventsTable,
  db,
  decisionsTable,
  factsTable,
  notesTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  tasksTable,
} from "@workspace/db";
import { parseRef, toRef, type RefType } from "@workspace/shared";
import {
  GRANT_TYPES,
  NO_GRANTS,
  activityVisible,
  decisionVisible,
  factVisible,
  noteVisible,
  organisationVisible,
  personVisible,
  projectVisible,
  taskVisible,
  type GrantType,
  type Grants,
} from "./visibility";

/** Who is reading, and what Ollie has opened up to them. Every AI-facing read takes one. */
export interface AiScope {
  clientId: number;
  /** Shown in the AI read log, for example "Ask OllieOS" or "Claude" */
  actor: string;
  grants: Grants;
}

export const ASK_CLIENT_NAME = "Ask OllieOS";

let askClientId: number | null = null;

/** The built-in Ask OllieOS client. Created on first use; Ask is its own client (question 12). */
export async function askClient(): Promise<{ id: number; name: string }> {
  if (askClientId != null) return { id: askClientId, name: ASK_CLIENT_NAME };
  const [found] = await db
    .select({ id: aiClientsTable.id })
    .from(aiClientsTable)
    .where(and(eq(aiClientsTable.name, ASK_CLIENT_NAME), eq(aiClientsTable.auth, "internal")));
  if (found) {
    askClientId = found.id;
  } else {
    const [created] = await db
      .insert(aiClientsTable)
      .values({ name: ASK_CLIENT_NAME, kind: "other", auth: "internal", scopes: ["read"], connectedAt: new Date() })
      .returning({ id: aiClientsTable.id });
    askClientId = created.id;
  }
  return { id: askClientId, name: ASK_CLIENT_NAME };
}

/** Test hook: forget the cached client id when the database is reset. */
export function resetAskClientCache() {
  askClientId = null;
}

/** Approved, unexpired grants for one client. Expiry is checked at read time, so nothing needs scheduling. */
export async function liveGrants(clientId: number, now = new Date()): Promise<Grants> {
  const rows = await db
    .select({ type: accessRequestsTable.entityType, id: accessRequestsTable.entityId })
    .from(accessRequestsTable)
    .where(
      and(
        eq(accessRequestsTable.clientId, clientId),
        eq(accessRequestsTable.status, "approved"),
        gt(accessRequestsTable.expiresAt, now),
        isNotNull(accessRequestsTable.entityId),
      ),
    );
  const out: Record<GrantType, number[]> = { project: [], person: [], organisation: [], task: [], decision: [], note: [] };
  for (const r of rows) {
    if (r.type && r.id != null && (GRANT_TYPES as readonly string[]).includes(r.type)) out[r.type as GrantType].push(r.id);
  }
  return out;
}

export async function buildScope(client: { id: number; name: string }): Promise<AiScope> {
  return { clientId: client.id, actor: client.name, grants: await liveGrants(client.id) };
}

/** A scope with no grants, used to work out what is hidden by default. */
export function defaultScope(): AiScope {
  return { clientId: 0, actor: "", grants: NO_GRANTS };
}

/** Which of the given refs this scope can see. Anything not returned is hidden or does not exist. */
export async function visibleRefs(scope: AiScope, refList: readonly string[]): Promise<Set<string>> {
  const refs = refList.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  const ids = (t: RefType) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const g = scope.grants;
  const q = async <T extends { id: number }>(type: RefType, run: (ids: number[]) => Promise<T[]>) => {
    const list = ids(type);
    return list.length ? (await run(list)).map((r) => toRef(type, r.id)) : [];
  };
  const parts = await Promise.all([
    q("task", (i) => db.select({ id: tasksTable.id }).from(tasksTable).where(and(inArray(tasksTable.id, i), sql.raw(taskVisible("tasks", g))))),
    q("project", (i) => db.select({ id: projectsTable.id }).from(projectsTable).where(and(inArray(projectsTable.id, i), sql.raw(projectVisible("projects", g))))),
    q("person", (i) => db.select({ id: peopleTable.id }).from(peopleTable).where(and(inArray(peopleTable.id, i), sql.raw(personVisible("people", g))))),
    q("organisation", (i) =>
      db.select({ id: organisationsTable.id }).from(organisationsTable).where(and(inArray(organisationsTable.id, i), sql.raw(organisationVisible("organisations", g)))),
    ),
    q("decision", (i) => db.select({ id: decisionsTable.id }).from(decisionsTable).where(and(inArray(decisionsTable.id, i), sql.raw(decisionVisible("decisions", g))))),
    q("note", (i) => db.select({ id: notesTable.id }).from(notesTable).where(and(inArray(notesTable.id, i), sql.raw(noteVisible("notes", g))))),
    q("fact", (i) => db.select({ id: factsTable.id }).from(factsTable).where(and(inArray(factsTable.id, i), sql.raw(factVisible("facts", g))))),
    q("activity", (i) => db.select({ id: activityTable.id }).from(activityTable).where(and(inArray(activityTable.id, i), sql.raw(activityVisible("activity", g))))),
  ]);
  return new Set(parts.flat());
}

/**
 * Drops every ref this scope cannot see. A second check after the SQL filter, in case a join
 * is ever wrong (build plan section 6, step 4).
 */
export async function sanitiseRefs(scope: AiScope, refs: readonly string[]): Promise<string[]> {
  const ok = await visibleRefs(scope, refs);
  return refs.filter((r) => ok.has(r));
}

/**
 * Writes one audit_events row per item an AI client was given (PRD 10, rule 4).
 * Rows from one call share a batch id so the read log can show them as one action.
 */
export async function recordReads(scope: AiScope, refs: readonly string[], context: Record<string, unknown> = {}): Promise<void> {
  const unique = [...new Set(refs)].map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  if (!unique.length) return;
  const batch = crypto.randomUUID();
  await db.insert(auditEventsTable).values(
    unique.map((r) => ({
      actor: scope.actor,
      clientId: scope.clientId,
      action: "read",
      entityType: r.type,
      entityId: r.id,
      payload: { batch, ...context },
    })),
  );
  await db.update(aiClientsTable).set({ lastUsedAt: new Date() }).where(eq(aiClientsTable.id, scope.clientId));
}

/** One audit row per AI search (action "search"), with the query and the refs it returned (build plan 6, step 5). */
export async function recordSearch(scope: AiScope, query: string, refs: readonly string[], context: Record<string, unknown> = {}): Promise<void> {
  await db.insert(auditEventsTable).values({
    actor: scope.actor,
    clientId: scope.clientId,
    action: "search",
    entityType: null,
    entityId: null,
    payload: { query, results: [...refs], ...context },
  });
}

/** Stamps a client's last use, shown in Settings. */
export async function markClientUsed(clientId: number): Promise<void> {
  await db.update(aiClientsTable).set({ lastUsedAt: new Date() }).where(eq(aiClientsTable.id, clientId));
}
