import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  db,
  decisionsTable,
  factsTable,
  linksTable,
  notesTable,
  projectsTable,
  type Decision as DecisionRow,
  type Fact as FactRow,
  type Note as NoteRow,
} from "@workspace/db";
import { writeAudit, type EntityType } from "../../lib/audit";
import { NotFoundError, ValidationError } from "../tasks";
import {
  ACTOR,
  cleanText,
  hiddenIds,
  resolveEntities,
  resolveEntity,
  touch,
  type EntityKind,
  type EntityRefView,
  type EntitySummary,
} from "./common";

/* ---------- Facts ---------- */

export interface FactView {
  id: number;
  entityType: string;
  entityId: number;
  text: string;
  source: string | null;
  attribute: string | null;
  createdBy: string;
  createdAt: Date;
  lastConfirmedAt: Date;
  /** Stale or in conflict: shown as "Needs a check" */
  needsCheck: boolean;
  approvedAt: Date | null;
  /** Earlier versions this fact replaced, newest first */
  history: { id: number; text: string; createdAt: Date; createdBy: string }[];
}

/** Current facts for an entity, each with the chain of versions it superseded. */
export async function factsFor(entityType: EntityKind, entityId: number): Promise<FactView[]> {
  const rows = await db
    .select()
    .from(factsTable)
    .where(and(eq(factsTable.entityType, entityType), eq(factsTable.entityId, entityId)))
    .orderBy(asc(factsTable.createdAt), asc(factsTable.id));
  // A fact can replace several (a resolved conflict); a retired fact points at itself and has no successor.
  const replaced = new Map<number, FactRow[]>();
  for (const r of rows) if (r.supersededBy && r.supersededBy !== r.id) replaced.set(r.supersededBy, [...(replaced.get(r.supersededBy) ?? []), r]);
  return rows
    .filter((r) => r.supersededBy === null)
    .map((r) => {
      const history: FactView["history"] = [];
      const queue = [...(replaced.get(r.id) ?? [])];
      const seen = new Set<number>([r.id]);
      while (queue.length && history.length < 50) {
        const prev = queue.shift()!;
        if (seen.has(prev.id)) continue;
        seen.add(prev.id);
        history.push({ id: prev.id, text: prev.text, createdAt: prev.createdAt, createdBy: prev.createdBy });
        queue.push(...(replaced.get(prev.id) ?? []));
      }
      history.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
      return toFactView(r, history);
    });
}

function toFactView(r: FactRow, history: FactView["history"]): FactView {
  return {
    id: r.id,
    entityType: r.entityType,
    entityId: r.entityId,
    text: r.text,
    source: r.source,
    attribute: r.attribute,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    lastConfirmedAt: r.lastConfirmedAt,
    needsCheck: r.needsCheck,
    approvedAt: r.approvedAt,
    history,
  };
}

export interface FactInput {
  entityType: EntityKind;
  entityId: number;
  text: string;
  source?: string | null;
  attribute?: FactRow["attribute"];
}

/**
 * Ollie's own fact applies at once. With an attribute, it replaces any current fact with the
 * same attribute on the same item (build plan 42), so the two never conflict.
 */
export async function createFact(input: FactInput): Promise<FactView> {
  const text = cleanText(input.text);
  if (!text) throw new ValidationError("A fact needs some text");
  await resolveEntity(input.entityType, input.entityId);
  const attribute = input.attribute ?? null;
  const createdId = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(factsTable)
      .values({ entityType: input.entityType, entityId: input.entityId, text, attribute, source: cleanText(input.source), createdBy: ACTOR })
      .returning();
    let replaced: number[] = [];
    if (attribute) {
      const rows = await tx
        .update(factsTable)
        .set({ supersededBy: created.id })
        .where(
          and(
            eq(factsTable.entityType, input.entityType),
            eq(factsTable.entityId, input.entityId),
            eq(factsTable.attribute, attribute),
            isNull(factsTable.supersededBy),
            ne(factsTable.id, created.id),
          ),
        )
        .returning({ id: factsTable.id });
      replaced = rows.map((r) => r.id);
    }
    await touch(tx, input.entityType, input.entityId);
    await writeAudit(tx, {
      actor: ACTOR,
      action: replaced.length ? "supersede" : "create",
      entityType: "fact",
      entityId: created.id,
      payload: { on: `${input.entityType}:${input.entityId}`, ...(replaced.length ? { replaced } : {}) },
    });
    return created.id;
  });
  const current = (await factsFor(input.entityType, input.entityId)).find((f) => f.id === createdId);
  if (!current) throw new NotFoundError("That fact does not exist");
  return current;
}

/** Replaces a fact: inserts the new text as a new row and points the old one at it. The old row is never edited otherwise. */
export async function supersedeFact(id: number, input: { text: string; source?: string | null }): Promise<FactView> {
  const text = cleanText(input.text);
  if (!text) throw new ValidationError("A fact needs some text");
  const [old] = await db.select().from(factsTable).where(eq(factsTable.id, id));
  if (!old) throw new NotFoundError("That fact does not exist");
  if (old.supersededBy !== null) throw new ValidationError("That fact has already been replaced. Refresh to see the current version.");
  if (text === old.text) {
    const current = (await factsFor(old.entityType as FactInput["entityType"], old.entityId)).find((f) => f.id === id);
    if (current) return current;
  }
  await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(factsTable)
      .values({
        entityType: old.entityType,
        entityId: old.entityId,
        text,
        attribute: old.attribute,
        source: input.source === undefined ? old.source : cleanText(input.source),
        createdBy: ACTOR,
      })
      .returning();
    const updated = await tx
      .update(factsTable)
      .set({ supersededBy: created.id })
      .where(and(eq(factsTable.id, id), isNull(factsTable.supersededBy)))
      .returning({ id: factsTable.id });
    if (!updated.length) throw new ValidationError("That fact has already been replaced. Refresh to see the current version.");
    await touch(tx, old.entityType, old.entityId);
    await writeAudit(tx, {
      actor: ACTOR,
      action: "supersede",
      entityType: "fact",
      entityId: created.id,
      payload: { replaced: id, from: old.text, to: text },
    });
    return created;
  });
  const facts = await factsFor(old.entityType as FactInput["entityType"], old.entityId);
  const current = facts.find((f) => f.history.some((h) => h.id === id));
  if (!current) throw new NotFoundError("That fact does not exist");
  return current;
}

/* ---------- Decisions ---------- */

export interface DecisionView {
  id: number;
  text: string;
  decidedAt: string;
  decidedBy: string | null;
  source: string | null;
  confidential: boolean | null;
  hiddenFromAi: boolean;
  /** Null for a decision that stands on its own */
  project: EntitySummary | null;
  createdBy: string;
  createdAt: Date;
}

export async function toDecisionViews(rows: DecisionRow[]): Promise<DecisionView[]> {
  if (!rows.length) return [];
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((id): id is number => id != null))];
  const [projects, hidden] = await Promise.all([
    !projectIds.length
      ? []
      : db
      .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, confidential: projectsTable.confidential })
      .from(projectsTable)
      .where(inArray(projectsTable.id, projectIds)),
    hiddenIds(
      "decision",
      rows.map((r) => r.id),
    ),
  ]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    decidedAt: r.decidedAt,
    decidedBy: r.decidedBy,
    source: r.source,
    confidential: r.confidential,
    hiddenFromAi: hidden.has(r.id),
    project: r.projectId != null ? (byId.get(r.projectId) ?? null) : null,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }));
}

export async function listDecisions(projectId?: number): Promise<DecisionView[]> {
  const rows = await db
    .select()
    .from(decisionsTable)
    .where(projectId ? eq(decisionsTable.projectId, projectId) : undefined)
    .orderBy(desc(decisionsTable.decidedAt), desc(decisionsTable.id));
  return toDecisionViews(rows);
}

export async function getDecision(id: number): Promise<DecisionView> {
  const [row] = await db.select().from(decisionsTable).where(eq(decisionsTable.id, id));
  if (!row) throw new NotFoundError("That decision does not exist");
  return (await toDecisionViews([row]))[0];
}

export interface DecisionInput {
  /** Optional: a decision can stand on its own */
  projectId?: number | null;
  text: string;
  decidedAt: string;
  decidedBy?: string | null;
  source?: string | null;
  confidential?: boolean | null;
}

export async function createDecision(input: DecisionInput): Promise<DecisionView> {
  const text = cleanText(input.text);
  if (!text) throw new ValidationError("A decision needs some text");
  const projectId = input.projectId ?? null;
  if (projectId != null) await resolveEntity("project", projectId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(decisionsTable)
      .values({
        projectId,
        text,
        decidedAt: input.decidedAt,
        decidedBy: cleanText(input.decidedBy),
        source: cleanText(input.source),
        confidential: input.confidential ?? null,
        createdBy: ACTOR,
      })
      .returning();
    if (projectId != null) await touch(tx, "project", projectId);
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "decision", entityId: created.id, payload: { projectId } });
    return created;
  });
  return (await toDecisionViews([row]))[0];
}

/** projectId null takes the decision off its project */
export type DecisionUpdate = Partial<Omit<DecisionInput, "projectId">> & { projectId?: number | null };

export async function updateDecision(id: number, input: DecisionUpdate): Promise<DecisionView> {
  const [current] = await db.select().from(decisionsTable).where(eq(decisionsTable.id, id));
  if (!current) throw new NotFoundError("That decision does not exist");
  const set: Partial<DecisionRow> = {};
  if (input.text !== undefined) {
    const text = cleanText(input.text);
    if (!text) throw new ValidationError("A decision needs some text");
    set.text = text;
  }
  if (input.decidedAt !== undefined) set.decidedAt = input.decidedAt;
  if (input.decidedBy !== undefined) set.decidedBy = cleanText(input.decidedBy);
  if (input.source !== undefined) set.source = cleanText(input.source);
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.projectId !== undefined) {
    if (input.projectId != null) await resolveEntity("project", input.projectId);
    set.projectId = input.projectId;
  }
  if (!Object.keys(set).length) return getDecision(id);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(decisionsTable).set(set).where(eq(decisionsTable.id, id)).returning();
    if (updated.projectId != null) await touch(tx, "project", updated.projectId);
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "decision", entityId: id, payload: { fields: Object.keys(set) } });
    return updated;
  });
  return (await toDecisionViews([row]))[0];
}

/* ---------- Notes ---------- */

export interface NoteView {
  id: number;
  title: string | null;
  body: string;
  confidential: boolean | null;
  hiddenFromAi: boolean;
  entity: EntityRefView;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function toNoteViews(rows: NoteRow[]): Promise<NoteView[]> {
  if (!rows.length) return [];
  const [entities, hidden] = await Promise.all([
    resolveEntities(rows.map((r) => ({ type: r.entityType, id: r.entityId }))),
    hiddenIds(
      "note",
      rows.map((r) => r.id),
    ),
  ]);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    confidential: r.confidential,
    hiddenFromAi: hidden.has(r.id),
    entity: entities.get(`${r.entityType}:${r.entityId}`) ?? { type: r.entityType, id: r.entityId, name: "Removed item", slug: null },
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function notesFor(entityType: string, entityId: number): Promise<NoteView[]> {
  const rows = await db
    .select()
    .from(notesTable)
    .where(and(eq(notesTable.entityType, entityType as NoteRow["entityType"]), eq(notesTable.entityId, entityId)))
    .orderBy(desc(notesTable.updatedAt));
  return toNoteViews(rows);
}

export async function listNotes(): Promise<NoteView[]> {
  const rows = await db.select().from(notesTable).orderBy(desc(notesTable.updatedAt)).limit(500);
  return toNoteViews(rows);
}

export async function getNote(id: number): Promise<NoteView> {
  const [row] = await db.select().from(notesTable).where(eq(notesTable.id, id));
  if (!row) throw new NotFoundError("That note does not exist");
  return (await toNoteViews([row]))[0];
}

export interface NoteInput {
  entityType: "project" | "person" | "organisation" | "product" | "task" | "decision";
  entityId: number;
  title?: string | null;
  body: string;
  confidential?: boolean | null;
}

export async function createNote(input: NoteInput): Promise<NoteView> {
  const body = cleanText(input.body);
  if (!body) throw new ValidationError("A note needs some text");
  await resolveEntity(input.entityType, input.entityId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(notesTable)
      .values({
        entityType: input.entityType,
        entityId: input.entityId,
        title: cleanText(input.title),
        body,
        confidential: input.confidential ?? null,
        createdBy: ACTOR,
      })
      .returning();
    await touch(tx, input.entityType, input.entityId);
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "note", entityId: created.id, payload: { on: `${input.entityType}:${input.entityId}` } });
    return created;
  });
  return (await toNoteViews([row]))[0];
}

export async function updateNote(id: number, input: { title?: string | null; body?: string; confidential?: boolean | null }): Promise<NoteView> {
  const [current] = await db.select().from(notesTable).where(eq(notesTable.id, id));
  if (!current) throw new NotFoundError("That note does not exist");
  const set: Partial<NoteRow> = {};
  if (input.title !== undefined) set.title = cleanText(input.title);
  if (input.body !== undefined) {
    const body = cleanText(input.body);
    if (!body) throw new ValidationError("A note needs some text");
    set.body = body;
  }
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (!Object.keys(set).length) return getNote(id);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(notesTable).set(set).where(eq(notesTable.id, id)).returning();
    await touch(tx, updated.entityType, updated.entityId);
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "note", entityId: id, payload: { fields: Object.keys(set) } });
    return updated;
  });
  return (await toNoteViews([row]))[0];
}

/* ---------- Links ---------- */

export const LINKABLE = ["task", "project", "person", "organisation", "decision", "note", "product", "document", "rule", "playbook"] as const;
export type Linkable = (typeof LINKABLE)[number];

export interface LinkInput {
  fromType: Linkable;
  fromId: number;
  toType: Linkable;
  toId: number;
}

/** Links are undirected in meaning; this finds one stored either way round. */
function linkWhere(i: LinkInput) {
  return or(
    and(eq(linksTable.fromType, i.fromType), eq(linksTable.fromId, i.fromId), eq(linksTable.toType, i.toType), eq(linksTable.toId, i.toId)),
    and(eq(linksTable.fromType, i.toType), eq(linksTable.fromId, i.toId), eq(linksTable.toType, i.fromType), eq(linksTable.toId, i.fromId)),
  );
}

async function assertExists(type: Linkable, id: number) {
  if (type === "note") {
    const [n] = await db.select({ id: notesTable.id }).from(notesTable).where(eq(notesTable.id, id));
    if (!n) throw new NotFoundError("That note does not exist");
    return;
  }
  await resolveEntity(type, id);
}

export async function createLink(input: LinkInput): Promise<{ linked: true }> {
  if (input.fromType === input.toType && input.fromId === input.toId) throw new ValidationError("An item cannot be linked to itself");
  await Promise.all([assertExists(input.fromType, input.fromId), assertExists(input.toType, input.toId)]);
  await db.transaction(async (tx) => {
    const existing = await tx.select().from(linksTable).where(linkWhere(input));
    if (existing.length) return;
    await tx.insert(linksTable).values({ ...input, createdBy: ACTOR });
    await touch(tx, input.fromType, input.fromId);
    await touch(tx, input.toType, input.toId);
    await writeAudit(tx, {
      actor: ACTOR,
      action: "link",
      entityType: input.fromType as EntityType,
      entityId: input.fromId,
      payload: { to: `${input.toType}:${input.toId}` },
    });
  });
  return { linked: true };
}

export async function removeLink(input: LinkInput): Promise<{ linked: false }> {
  await db.transaction(async (tx) => {
    const removed = await tx.delete(linksTable).where(linkWhere(input)).returning();
    if (!removed.length) return;
    await touch(tx, input.fromType, input.fromId);
    await touch(tx, input.toType, input.toId);
    await writeAudit(tx, {
      actor: ACTOR,
      action: "unlink",
      entityType: input.fromType as EntityType,
      entityId: input.fromId,
      payload: { to: `${input.toType}:${input.toId}` },
    });
  });
  return { linked: false };
}

/** Ids of the given type linked to an item, either way round. */
export async function linkedIds(type: Linkable, id: number, otherType: Linkable): Promise<number[]> {
  const rows = await db
    .select()
    .from(linksTable)
    .where(
      or(
        and(eq(linksTable.fromType, type), eq(linksTable.fromId, id), eq(linksTable.toType, otherType)),
        and(eq(linksTable.toType, type), eq(linksTable.toId, id), eq(linksTable.fromType, otherType)),
      ),
    );
  return [...new Set(rows.map((r) => (r.fromType === type && r.fromId === id ? r.toId : r.fromId)))];
}
