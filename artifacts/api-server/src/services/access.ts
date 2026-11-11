import { and, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  accessRequestsTable,
  activityTable,
  aiClientsTable,
  auditEventsTable,
  coworkSessionsTable,
  db,
  ideasTable,
  factsTable,
  notesTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  strategySectionsTable,
  tasksTable,
  type AccessRequest,
} from "@workspace/db";
import { londonRange, parseRef, todayLondon } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { GRANT_TYPES, type GrantType } from "../lib/ai-data/visibility";
import { ConflictError, NotFoundError, ValidationError } from "./tasks";
import { resolveEntities } from "./knowledge/common";

const ACTOR = "ollie";
export const GRANT_MS = 60 * 60 * 1000;

/* ---------- Item labels (Ollie's view: every name, with its lock) ---------- */

export interface ItemView {
  ref: string;
  type: string;
  id: number;
  name: string;
  /** App path to open the item */
  path: string | null;
  /** The item's own confidential flag */
  confidential: boolean;
}

function pathFor(type: string, slug: string | null, id: number): string | null {
  if (type === "project" && slug) return `/knowledge/projects/${slug}`;
  if (type === "person" && slug) return `/knowledge/people/${slug}`;
  if (type === "organisation" && slug) return `/knowledge/organisations/${slug}`;
  if (type === "decision") return `/knowledge/decisions/${id}`;
  if (type === "note") return `/knowledge/notes/${id}`;
  if (type === "task") return `/tasks?task=${id}`;
  if (type === "session") return `/knowledge/sessions?session=${id}`;
  if (type === "strategy") return `/strategy?section=${id}`;
  if (type === "idea") return `/strategy?idea=${id}`;
  return null;
}

const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** Names, paths and locks for refs of any type. Missing items are left out. */
export async function describeRefs(refList: readonly string[]): Promise<Map<string, ItemView>> {
  const refs = refList.map(parseRef).filter((r): r is NonNullable<typeof r> => !!r);
  const ids = (t: string) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const [notes, facts, acts, conf, sessions, sections, ideas] = await Promise.all([
    ids("note").length ? db.select().from(notesTable).where(inArray(notesTable.id, ids("note"))) : [],
    ids("fact").length ? db.select().from(factsTable).where(inArray(factsTable.id, ids("fact"))) : [],
    ids("activity").length ? db.select().from(activityTable).where(inArray(activityTable.id, ids("activity"))) : [],
    ownConfidential(refs),
    ids("session").length
      ? db.select({ id: coworkSessionsTable.id, title: coworkSessionsTable.title, confidential: coworkSessionsTable.confidential }).from(coworkSessionsTable).where(inArray(coworkSessionsTable.id, ids("session")))
      : [],
    ids("strategy").length
      ? db.select({ id: strategySectionsTable.id, name: strategySectionsTable.name, confidential: strategySectionsTable.confidential }).from(strategySectionsTable).where(inArray(strategySectionsTable.id, ids("strategy")))
      : [],
    ids("idea").length ? db.select({ id: ideasTable.id, title: ideasTable.title, confidential: ideasTable.confidential }).from(ideasTable).where(inArray(ideasTable.id, ids("idea"))) : [],
  ]);
  const entities = await resolveEntities([
    ...refs.filter((r) => ["project", "person", "organisation", "task", "decision"].includes(r.type)),
    ...facts.map((f) => ({ type: f.entityType as string, id: f.entityId })),
  ]);
  const out = new Map<string, ItemView>();
  for (const [ref, e] of entities) {
    if (!refs.some((r) => `${r.type}:${r.id}` === ref)) continue;
    out.set(ref, { ref, type: e.type, id: e.id, name: clip(e.name), path: pathFor(e.type, e.slug, e.id), confidential: conf.has(ref) });
  }
  for (const n of notes) {
    const ref = `note:${n.id}`;
    out.set(ref, { ref, type: "note", id: n.id, name: clip(n.title || n.body), path: pathFor("note", null, n.id), confidential: n.confidential === true });
  }
  for (const f of facts) {
    const ref = `fact:${f.id}`;
    const about = entities.get(`${f.entityType}:${f.entityId}`);
    out.set(ref, {
      ref,
      type: "fact",
      id: f.id,
      name: clip(about ? `${about.name}: ${f.text}` : f.text),
      path: about ? pathFor(about.type, about.slug, about.id) : null,
      confidential: false,
    });
  }
  for (const a of acts) {
    const ref = `activity:${a.id}`;
    out.set(ref, { ref, type: "activity", id: a.id, name: clip(a.summary), path: null, confidential: false });
  }
  for (const s of sessions) {
    const ref = `session:${s.id}`;
    out.set(ref, { ref, type: "session", id: s.id, name: clip(`Cowork session: ${s.title}`), path: pathFor("session", null, s.id), confidential: s.confidential === true });
  }
  for (const s of sections) {
    const ref = `strategy:${s.id}`;
    out.set(ref, { ref, type: "strategy", id: s.id, name: clip(`Strategy: ${s.name}`), path: pathFor("strategy", null, s.id), confidential: s.confidential });
  }
  for (const i of ideas) {
    const ref = `idea:${i.id}`;
    out.set(ref, { ref, type: "idea", id: i.id, name: clip(`Idea: ${i.title}`), path: pathFor("idea", null, i.id), confidential: i.confidential });
  }
  return out;
}

async function ownConfidential(refs: { type: string; id: number }[]): Promise<Set<string>> {
  const ids = (t: string) => [...new Set(refs.filter((r) => r.type === t).map((r) => r.id))];
  const out = new Set<string>();
  const check = async (type: string, table: typeof projectsTable | typeof peopleTable | typeof organisationsTable | typeof tasksTable) => {
    const list = ids(type);
    if (!list.length) return;
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(and(inArray(table.id, list), eq(table.confidential, true)));
    for (const r of rows) out.add(`${type}:${r.id}`);
  };
  await Promise.all([check("project", projectsTable), check("person", peopleTable), check("organisation", organisationsTable), check("task", tasksTable)]);
  return out;
}

/* ---------- Access requests ---------- */

export interface AccessRequestView {
  id: number;
  client: { id: number; name: string };
  requestedName: string;
  reason: string | null;
  status: "pending" | "approved" | "declined" | "expired";
  /** True while an approval is live */
  open: boolean;
  item: ItemView | null;
  createdAt: Date;
  decidedAt: Date | null;
  expiresAt: Date | null;
}

async function toRequestViews(rows: AccessRequest[]): Promise<AccessRequestView[]> {
  if (!rows.length) return [];
  const clientIds = [...new Set(rows.map((r) => r.clientId))];
  const [clients, items] = await Promise.all([
    db.select({ id: aiClientsTable.id, name: aiClientsTable.name }).from(aiClientsTable).where(inArray(aiClientsTable.id, clientIds)),
    describeRefs(rows.filter((r) => r.entityType && r.entityId != null).map((r) => `${r.entityType}:${r.entityId}`)),
  ]);
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    client: clientById.get(r.clientId) ?? { id: r.clientId, name: "Unknown tool" },
    requestedName: r.requestedName,
    reason: r.reason,
    status: r.status,
    open: r.status === "approved" && !!r.expiresAt && r.expiresAt.getTime() > now,
    item: r.entityType && r.entityId != null ? (items.get(`${r.entityType}:${r.entityId}`) ?? null) : null,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    expiresAt: r.expiresAt,
  }));
}

export interface AccessRequestList {
  pending: AccessRequestView[];
  open: AccessRequestView[];
  recent: AccessRequestView[];
}

/** The approval queue, live approvals, and the last week's decisions. */
export async function listAccessRequests(): Promise<AccessRequestList> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [pending, open, recent] = await Promise.all([
    db.select().from(accessRequestsTable).where(eq(accessRequestsTable.status, "pending")).orderBy(desc(accessRequestsTable.createdAt)),
    db
      .select()
      .from(accessRequestsTable)
      .where(and(eq(accessRequestsTable.status, "approved"), gt(accessRequestsTable.expiresAt, now)))
      .orderBy(desc(accessRequestsTable.expiresAt)),
    db
      .select()
      .from(accessRequestsTable)
      .where(
        and(
          gte(accessRequestsTable.decidedAt, weekAgo),
          or(
            inArray(accessRequestsTable.status, ["declined", "expired"]),
            and(eq(accessRequestsTable.status, "approved"), lte(accessRequestsTable.expiresAt, now)),
          ),
        ),
      )
      .orderBy(desc(accessRequestsTable.decidedAt))
      .limit(10),
  ]);
  const [p, o, r] = await Promise.all([toRequestViews(pending), toRequestViews(open), toRequestViews(recent)]);
  return { pending: p, open: o, recent: r };
}

async function loadRequest(id: number): Promise<AccessRequest> {
  const [row] = await db.select().from(accessRequestsTable).where(eq(accessRequestsTable.id, id));
  if (!row) throw new NotFoundError("That request does not exist");
  return row;
}

async function itemExists(type: GrantType, id: number): Promise<boolean> {
  const found = await describeRefs([`${type}:${id}`]);
  return found.size > 0;
}

/**
 * Allow for 1 hour. A request whose name matched nothing needs Ollie to pick the item first (question 13).
 * The approval applies to the requesting client only.
 */
export async function approveRequest(id: number, match?: { entityType?: string | null; entityId?: number | null }): Promise<AccessRequestView> {
  const row = await loadRequest(id);
  if (row.status !== "pending") throw new ConflictError("That request has already been answered");
  let entityType = row.entityType as GrantType | null;
  let entityId = row.entityId;
  if (match?.entityType && match.entityId != null) {
    if (!(GRANT_TYPES as readonly string[]).includes(match.entityType)) throw new ValidationError("Choose a project, person, organisation, task, decision or note");
    entityType = match.entityType as GrantType;
    entityId = match.entityId;
  }
  if (!entityType || entityId == null) throw new ValidationError("Choose which item this request is for first");
  if (!(await itemExists(entityType, entityId))) throw new NotFoundError("That item does not exist");

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(accessRequestsTable)
      .set({ status: "approved", entityType, entityId, decidedAt: now, expiresAt: new Date(now.getTime() + GRANT_MS) })
      .where(eq(accessRequestsTable.id, id));
    await writeAudit(tx, {
      actor: ACTOR,
      action: "approve_access",
      entityType,
      entityId,
      clientId: row.clientId,
      payload: { requestId: id, requested: row.requestedName, minutes: GRANT_MS / 60000 },
    });
  });
  return (await toRequestViews([await loadRequest(id)]))[0];
}

export async function declineRequest(id: number): Promise<AccessRequestView> {
  const row = await loadRequest(id);
  if (row.status !== "pending") throw new ConflictError("That request has already been answered");
  await db.transaction(async (tx) => {
    await tx.update(accessRequestsTable).set({ status: "declined", decidedAt: new Date() }).where(eq(accessRequestsTable.id, id));
    await writeAudit(tx, {
      actor: ACTOR,
      action: "decline_access",
      entityType: row.entityType,
      entityId: row.entityId,
      clientId: row.clientId,
      payload: { requestId: id, requested: row.requestedName },
    });
  });
  return (await toRequestViews([await loadRequest(id)]))[0];
}

/** Closes a live approval before its hour is up. */
export async function endAccess(id: number): Promise<AccessRequestView> {
  const row = await loadRequest(id);
  const now = new Date();
  if (row.status !== "approved" || !row.expiresAt || row.expiresAt <= now) throw new ConflictError("That access has already ended");
  await db.transaction(async (tx) => {
    await tx.update(accessRequestsTable).set({ status: "expired", expiresAt: now }).where(eq(accessRequestsTable.id, id));
    await writeAudit(tx, {
      actor: ACTOR,
      action: "end_access",
      entityType: row.entityType,
      entityId: row.entityId,
      clientId: row.clientId,
      payload: { requestId: id },
    });
  });
  return (await toRequestViews([await loadRequest(id)]))[0];
}

/**
 * Ollie granting access directly, without a request from the AI (Ask's "Allow for this question").
 * Stored as approved requests so they show, expire and log exactly like approved requests.
 */
export async function grantDirect(
  client: { id: number; name: string },
  items: { type: GrantType; id: number; name: string }[],
  reason: string,
): Promise<void> {
  if (!items.length) return;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + GRANT_MS);
  await db.transaction(async (tx) => {
    for (const it of items) {
      const [created] = await tx
        .insert(accessRequestsTable)
        .values({
          clientId: client.id,
          entityType: it.type,
          entityId: it.id,
          requestedName: it.name.slice(0, 200),
          reason,
          status: "approved",
          decidedAt: now,
          expiresAt,
        })
        .returning({ id: accessRequestsTable.id });
      await writeAudit(tx, {
        actor: ACTOR,
        action: "approve_access",
        entityType: it.type,
        entityId: it.id,
        clientId: client.id,
        payload: { requestId: created.id, requested: it.name, minutes: GRANT_MS / 60000, direct: true },
      });
    }
  });
}

/* ---------- Settings: AI access ---------- */

export interface AiClientView {
  id: number;
  name: string;
  kind: string;
  auth: string;
  builtIn: boolean;
  scopes: string[];
  connectedAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function listAiClients(): Promise<AiClientView[]> {
  // Tools that registered but were never approved on the consent screen are not shown.
  const rows = await db
    .select()
    .from(aiClientsTable)
    .where(sql`${aiClientsTable.connectedAt} is not null`)
    .orderBy(aiClientsTable.id);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    auth: r.auth,
    builtIn: r.auth === "internal",
    scopes: r.scopes,
    connectedAt: r.connectedAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  }));
}

export interface AiAccessSummary {
  connectedTools: number;
  pendingRequests: number;
  openGrants: number;
  readsToday: number;
  hidden: { projects: number; people: number; organisations: number };
}

export async function aiAccessSummary(): Promise<AiAccessSummary> {
  const today = londonRange(todayLondon(), 1);
  const now = new Date();
  const hiddenWhere = (t: typeof projectsTable | typeof peopleTable | typeof organisationsTable) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(t)
      .where(sql`${t.confidential} or not ${t.aiAccess}`);
  const [clients, pending, open, reads, hp, hpe, ho] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(aiClientsTable)
      .where(and(isNull(aiClientsTable.revokedAt), sql`${aiClientsTable.connectedAt} is not null`)),
    db.select({ n: sql<number>`count(*)::int` }).from(accessRequestsTable).where(eq(accessRequestsTable.status, "pending")),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(accessRequestsTable)
      .where(and(eq(accessRequestsTable.status, "approved"), gt(accessRequestsTable.expiresAt, now))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditEventsTable)
      .where(
        and(
          sql`${auditEventsTable.clientId} is not null`,
          eq(auditEventsTable.action, "read"),
          gte(auditEventsTable.createdAt, today.start),
        ),
      ),
    hiddenWhere(projectsTable),
    hiddenWhere(peopleTable),
    hiddenWhere(organisationsTable),
  ]);
  return {
    connectedTools: clients[0]?.n ?? 0,
    pendingRequests: pending[0]?.n ?? 0,
    openGrants: open[0]?.n ?? 0,
    readsToday: reads[0]?.n ?? 0,
    hidden: { projects: hp[0]?.n ?? 0, people: hpe[0]?.n ?? 0, organisations: ho[0]?.n ?? 0 },
  };
}

export interface AiActivityView {
  key: string;
  at: Date;
  actor: string;
  kind: "read" | "search" | "request" | "write";
  action: string;
  count: number;
  items: ItemView[];
  /** What the read was for: the Ask question, a search query, or the name an AI asked for */
  context: string | null;
}

const KIND: Record<string, AiActivityView["kind"]> = { read: "read", search: "search", request_access: "request" };

/** The last AI actions, newest first. Reads from one call are grouped into one action. */
export async function listAiActivity(limit = 100): Promise<AiActivityView[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 100, 1), 100);
  const res = await db.execute(sql`
    with recent as materialized (
      select key, at from ai_activity_groups order by at desc, key desc limit ${n}
    )
    select r.key as grp, r.at, totals.*,
      array(
        select a.entity_type::text || ':' || a.entity_id
        from audit_events a
        where a.client_id is not null and a.actor <> 'ollie'
          and coalesce(a.payload->>'batch', 'e' || a.id::text) = r.key and a.entity_id is not null
        order by a.id limit 3
      ) as refs
    from recent r
    cross join lateral (
      select coalesce(min(c.name), min(a.actor)) as actor, min(a.action) as action, count(*)::int as count,
        min(coalesce(a.payload->>'question', a.payload->>'query', a.payload->>'requested')) as context,
        max(a.payload->>'count') as n
      from audit_events a left join ai_clients c on c.id = a.client_id
      where a.client_id is not null and a.actor <> 'ollie'
        and coalesce(a.payload->>'batch', 'e' || a.id::text) = r.key
    ) totals
    order by r.at desc, r.key desc`);
  const rows = res.rows as { grp: string; at: string | Date; actor: string; action: string; count: number; refs: string[] | null; context: string | null; n: string | null }[];
  const labels = await describeRefs(rows.flatMap((r) => r.refs ?? []));
  return rows.map((r) => ({
    key: r.grp,
    at: new Date(r.at),
    actor: r.actor,
    kind: KIND[r.action] ?? "write",
    action: r.action,
    count: Number(r.count),
    items: (r.refs ?? []).map((ref) => labels.get(ref)).filter((x): x is ItemView => !!x),
    context: r.context ?? actionLabel(r.action, r.n),
  }));
}

/** Words for writes that have no single item to name. */
function actionLabel(action: string, n: string | null): string | null {
  if (action === "sweep_start") return "Started a sweep";
  if (action === "sweep_finish") return "Finished a sweep";
  if (action === "replace") return n == null ? "Replaced the calendar" : `Replaced the calendar with ${n} ${n === "1" ? "event" : "events"}`;
  return null;
}
