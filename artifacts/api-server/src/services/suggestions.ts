/**
 * Knowledge Inbox (feature 01). AI tools propose; Ollie approves, edits then approves, or rejects.
 * Nothing an AI proposes becomes a fact, decision, person, organisation or project until approved.
 * Tasks, promises, activity, notes and the calendar still write directly (build plan 24 and 26).
 */
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  decisionsTable,
  documentsTable,
  factReviewsTable,
  factsTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  suggestionsTable,
  FACT_ATTRIBUTES,
  type Suggestion,
} from "@workspace/db";
import { PLAYBOOK_RULE_MAX, type Cadence } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { ACTOR, cleanText, resolveEntity, touch, uniqueSlug, type EntityKind } from "./knowledge/common";
import { ConflictError, NotFoundError, ValidationError } from "./tasks";
import { insertDocument, insertPlaybook } from "./library";

export { FACT_ATTRIBUTES };
export type FactAttribute = (typeof FACT_ATTRIBUTES)[number];
/** Where a suggestion came from. */
export const SUGGESTION_SOURCES = ["email", "meeting", "chat", "recording", "voice", "calendar", "slack", "document"] as const;
export type SuggestionKind = Suggestion["kind"];

/** How long a rejected suggestion blocks the same one coming back. */
export const REJECTED_MEMORY_DAYS = 30;

/* ---------- Payloads ---------- */

export interface FactPayload {
  text: string;
  attribute?: FactAttribute | null;
  /** Id of the current fact this one replaces */
  supersedes?: number | null;
  source?: string | null;
}
export interface DecisionPayload {
  text: string;
  decided_at: string;
  decided_by?: string | null;
  source?: string | null;
  confidential?: boolean | null;
}
export interface PersonPayload {
  name: string;
  email?: string | null;
  role?: string | null;
  organisation_id?: number | null;
  organisation_name?: string | null;
  relationship_summary?: string | null;
}
export interface DocumentPayload {
  url: string;
  title: string;
  summary?: string | null;
  project_ids?: number[];
  /** Project names when proposed, for the card */
  project_names?: string[];
  /** Set when the proposer thinks the file is sensitive; the document is then always hidden from AI */
  confidential?: boolean | null;
}
export interface PlaybookPayload {
  title: string;
  applies_when: string;
  rule: string;
  project_ids?: number[];
  organisation_ids?: number[];
  /** Names when proposed, for the card */
  link_names?: string[];
}
export interface CadencePayload {
  cadence: Cadence;
  /** What it was when proposed, for the card */
  before?: Cadence | null;
  reason?: string | null;
}
export interface OrganisationPayload {
  name: string;
  type?: string | null;
  summary?: string | null;
}
export interface ProjectPayload {
  name: string;
  area?: string | null;
  status?: string | null;
  summary?: string | null;
}
/** Changes to an existing person, project or organisation. Values are the proposed text. */
export interface SummaryChangePayload {
  fields: Record<string, string>;
  /** What the fields said when it was proposed, for the card */
  before: Record<string, string | null>;
  /** When the change moves a person to another organisation */
  organisation_id?: number | null;
}

export type Proposal =
  | { kind: "fact"; entityType: EntityKind; entityId: number; payload: FactPayload }
  | { kind: "decision"; entityType: "project"; entityId: number; payload: DecisionPayload }
  | { kind: "person"; payload: PersonPayload }
  | { kind: "organisation"; payload: OrganisationPayload }
  | { kind: "project"; payload: ProjectPayload }
  | { kind: "summary_change"; entityType: EntityKind; entityId: number; payload: SummaryChangePayload }
  | { kind: "document"; payload: DocumentPayload }
  | { kind: "playbook"; payload: PlaybookPayload }
  | { kind: "cadence"; entityType: "person"; entityId: number; payload: CadencePayload };

export interface ProposeMeta {
  /** Client name: "Capture sweep", "Claude" */
  proposedBy: string;
  clientId: number | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
}

export type ProposeResult =
  | { status: "suggested"; suggestionId: number; hidden: boolean }
  | { status: "conflict"; suggestionId: number; reviewId: number }
  | { status: "duplicate"; suggestionId?: number; factId?: number }
  | { status: "previously_rejected"; suggestionId: number };

/** The editable fields for each kind, with their labels. */
export const FIELD_LABELS: Record<string, string> = {
  text: "Text",
  name: "Name",
  email: "Email",
  role: "Role",
  relationship_summary: "Relationship",
  organisation: "Organisation",
  type: "Type",
  area: "Area",
  status: "Status",
  summary: "Summary",
  decided_by: "Decided by",
  title: "Title",
  url: "Link",
  applies_when: "Applies when",
  rule: "Rule",
};
const EDITABLE: Record<Exclude<SuggestionKind, "summary_change">, string[]> = {
  fact: ["text"],
  decision: ["text", "decided_by"],
  person: ["name", "role", "email", "relationship_summary"],
  organisation: ["name", "type", "summary"],
  project: ["name", "area", "status", "summary"],
  document: ["title", "summary"],
  playbook: ["title", "applies_when", "rule"],
  cadence: [],
};
const REQUIRED = new Set(["text", "name", "title", "applies_when", "rule"]);
/** Columns a summary change may set on each kind of record. */
const CHANGEABLE: Record<EntityKind, string[]> = {
  person: ["role", "email", "relationship_summary", "organisation"],
  project: ["area", "status", "summary"],
  organisation: ["type", "summary"],
};

export function changeableFields(type: EntityKind): string[] {
  return CHANGEABLE[type];
}

export function editableFields(s: Pick<Suggestion, "kind" | "payload">): string[] {
  if (s.kind === "summary_change") return Object.keys((s.payload as SummaryChangePayload).fields).filter((k) => k !== "organisation");
  return EDITABLE[s.kind];
}

/** Lower case, single spaces, no trailing full stop: what "the same text" means. */
export function normalise(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s.!;,:]+$/, "");
}

function mainText(p: Proposal): string {
  switch (p.kind) {
    case "fact":
    case "decision":
      return p.payload.text;
    case "person":
      return p.payload.name;
    case "organisation":
    case "project":
      return p.payload.name;
    case "summary_change":
      return Object.keys(p.payload.fields)
        .sort()
        .map((k) => `${k}=${p.payload.fields[k]}`)
        .join("; ");
    case "document":
      return p.payload.url;
    case "playbook":
      return `${p.payload.title}: ${p.payload.rule}`;
    case "cadence":
      return p.payload.cadence;
  }
}

const entityOf = (p: Proposal): { entityType: EntityKind | null; entityId: number | null } =>
  "entityType" in p ? { entityType: p.entityType, entityId: p.entityId } : { entityType: null, entityId: null };

/** Current facts (not replaced or retired) on an entity. */
async function currentFacts(conn: DbOrTx, entityType: string, entityId: number) {
  return conn
    .select()
    .from(factsTable)
    .where(and(eq(factsTable.entityType, entityType as EntityKind), eq(factsTable.entityId, entityId), isNull(factsTable.supersededBy)));
}

/**
 * Records a proposal from an AI client. Returns "duplicate" when the same thing is already
 * pending or already a current fact, "previously_rejected" when Ollie rejected the same thing in
 * the last 30 days, and "conflict" when a fact disagrees with a current fact on the same attribute.
 */
export async function propose(meta: ProposeMeta, p: Proposal, now = new Date()): Promise<ProposeResult> {
  const text = cleanText(mainText(p));
  if (!text) throw new ValidationError(p.kind === "fact" || p.kind === "decision" ? "A suggestion needs some text" : "A suggestion needs a name");
  if (p.kind === "summary_change" && !Object.keys(p.payload.fields).length) throw new ValidationError("Nothing to change");
  if (p.kind === "playbook" && p.payload.rule.length > PLAYBOOK_RULE_MAX) throw new ValidationError(`Keep the rule to ${PLAYBOOK_RULE_MAX} characters or fewer`);
  const norm = normalise(text);
  const { entityType, entityId } = entityOf(p);
  const sameTarget = and(
    eq(suggestionsTable.kind, p.kind),
    eq(suggestionsTable.normalisedText, norm),
    entityType ? and(eq(suggestionsTable.entityType, entityType), eq(suggestionsTable.entityId, entityId!)) : isNull(suggestionsTable.entityType),
  );

  const [pending] = await db.select({ id: suggestionsTable.id }).from(suggestionsTable).where(and(sameTarget, eq(suggestionsTable.status, "pending")));
  if (pending) return { status: "duplicate", suggestionId: pending.id };
  const since = new Date(now.getTime() - REJECTED_MEMORY_DAYS * 86_400_000);
  const [rejected] = await db
    .select({ id: suggestionsTable.id })
    .from(suggestionsTable)
    .where(and(sameTarget, eq(suggestionsTable.status, "rejected"), gte(suggestionsTable.decidedAt, since)));
  if (rejected) return { status: "previously_rejected", suggestionId: rejected.id };

  if (p.kind === "cadence") {
    const [person] = await db.select({ cadence: peopleTable.cadence, isSelf: peopleTable.isSelf }).from(peopleTable).where(eq(peopleTable.id, p.entityId));
    if (!person) throw new ValidationError("That person does not exist");
    if (person.isSelf) throw new ValidationError("Ollie's own record has no cadence");
    // AI only suggests a cadence where there is none; it never changes one Ollie set (question 49).
    if (person.cadence !== "none") throw new ValidationError("This person already has a cadence. Only Ollie changes it.");
    p.payload.before = person.cadence;
  }
  if (p.kind === "document") {
    const [doc] = await db.select({ id: documentsTable.id }).from(documentsTable).where(eq(documentsTable.url, p.payload.url));
    if (doc) return { status: "duplicate" };
  }

  let conflictWith: number[] = [];
  if (p.kind === "fact") {
    const facts = await currentFacts(db, p.entityType, p.entityId);
    const same = facts.find((f) => normalise(f.text) === norm);
    if (same) return { status: "duplicate", factId: same.id };
    if (p.payload.attribute) {
      conflictWith = facts
        .filter((f) => f.attribute === p.payload.attribute && f.id !== p.payload.supersedes)
        .map((f) => f.id);
    }
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(suggestionsTable)
      .values({
        kind: p.kind,
        entityType,
        entityId,
        payload: p.payload,
        normalisedText: norm,
        sourceType: cleanText(meta.sourceType),
        sourceRef: cleanText(meta.sourceRef),
        sourceUrl: cleanText(meta.sourceUrl),
        sourceLabel: cleanText(meta.sourceLabel),
        proposedBy: meta.proposedBy,
        clientId: meta.clientId,
        createdAt: now,
      })
      .returning();
    await writeAudit(tx, {
      actor: meta.proposedBy,
      clientId: meta.clientId,
      action: "suggest",
      entityType: "suggestion",
      entityId: row.id,
      payload: { kind: p.kind, on: entityType ? `${entityType}:${entityId}` : null },
    });
    if (conflictWith.length) {
      const [review] = await tx.insert(factReviewsTable).values({ kind: "conflict", factIds: conflictWith, suggestionId: row.id, createdAt: now }).returning();
      await tx.update(factsTable).set({ needsCheck: true }).where(inArray(factsTable.id, conflictWith));
      await writeAudit(tx, {
        actor: meta.proposedBy,
        clientId: meta.clientId,
        action: "create",
        entityType: "fact_review",
        entityId: review.id,
        payload: { kind: "conflict", facts: conflictWith, suggestionId: row.id },
      });
      return { status: "conflict" as const, suggestionId: row.id, reviewId: review.id };
    }
    const hidden = (p.kind === "decision" || p.kind === "document") && p.payload.confidential === true;
    return { status: "suggested" as const, suggestionId: row.id, hidden };
  });
}

/* ---------- Approve and reject (Ollie) ---------- */

async function loadPending(conn: DbOrTx, id: number): Promise<Suggestion> {
  const [s] = await conn.select().from(suggestionsTable).where(eq(suggestionsTable.id, id));
  if (!s) throw new NotFoundError("That suggestion does not exist");
  if (s.status !== "pending") throw new ValidationError(s.status === "approved" ? "That suggestion was already approved" : "That suggestion was already rejected");
  return s;
}

async function inPendingConflict(conn: DbOrTx, suggestionId: number): Promise<boolean> {
  const [r] = await conn
    .select({ id: factReviewsTable.id })
    .from(factReviewsTable)
    .where(and(eq(factReviewsTable.suggestionId, suggestionId), eq(factReviewsTable.status, "pending")));
  return !!r;
}

/** Applies Ollie's edits to a payload. Only the editable fields for the kind are accepted. */
function withEdits(s: Suggestion, edits: Record<string, string> | undefined): Record<string, unknown> {
  const payload = structuredClone(s.payload) as Record<string, unknown>;
  if (!edits || !Object.keys(edits).length) return payload;
  const allowed = new Set(editableFields(s));
  for (const [k, raw] of Object.entries(edits)) {
    if (!allowed.has(k)) throw new ValidationError(`${FIELD_LABELS[k] ?? k} cannot be edited here`);
    const v = cleanText(raw);
    if (s.kind === "summary_change") {
      if (!v) throw new ValidationError(`${FIELD_LABELS[k] ?? k} needs some text`);
      (payload.fields as Record<string, string>)[k] = v;
    } else {
      if (!v && REQUIRED.has(k)) throw new ValidationError(`${FIELD_LABELS[k]} needs some text`);
      payload[k] = v;
    }
  }
  return payload;
}

const str = (v: unknown): string | null => (typeof v === "string" ? cleanText(v) : null);

/**
 * Writes what a suggestion proposes. Facts approved here replace the fact named in supersedes and
 * any current fact with the same attribute, plus any extra ids given (a conflict being resolved).
 */
export async function applySuggestion(
  tx: DbOrTx,
  s: Suggestion,
  payload: Record<string, unknown>,
  now: Date,
  extraSuperseded: number[] = [],
): Promise<{ type: "fact" | "decision" | "person" | "organisation" | "project" | "document" | "playbook"; id: number }> {
  const audit = (action: string, entityType: "fact" | "decision" | "person" | "organisation" | "project", entityId: number, extra: Record<string, unknown> = {}) =>
    writeAudit(tx, { actor: ACTOR, action, entityType, entityId, payload: { suggestionId: s.id, proposedBy: s.proposedBy, ...extra } });

  switch (s.kind) {
    case "fact": {
      const p = payload as unknown as FactPayload;
      await resolveEntity(s.entityType!, s.entityId!, tx);
      const [created] = await tx
        .insert(factsTable)
        .values({
          entityType: s.entityType!,
          entityId: s.entityId!,
          text: p.text,
          attribute: p.attribute ?? null,
          source: cleanText(p.source) ?? s.sourceLabel ?? s.sourceType ?? null,
          createdBy: s.proposedBy,
          lastConfirmedAt: now,
          approvedAt: now,
          suggestionId: s.id,
        })
        .returning();
      const current = await currentFacts(tx, s.entityType!, s.entityId!);
      const replace = current
        .filter((f) => f.id !== created.id && (f.id === p.supersedes || (p.attribute && f.attribute === p.attribute) || extraSuperseded.includes(f.id)))
        .map((f) => f.id);
      if (replace.length) {
        await tx.update(factsTable).set({ supersededBy: created.id }).where(and(inArray(factsTable.id, replace), isNull(factsTable.supersededBy)));
      }
      await touch(tx, s.entityType!, s.entityId!);
      await audit("create", "fact", created.id, { on: `${s.entityType}:${s.entityId}`, replaced: replace });
      return { type: "fact", id: created.id };
    }
    case "decision": {
      const p = payload as unknown as DecisionPayload;
      await resolveEntity("project", s.entityId!, tx);
      const [created] = await tx
        .insert(decisionsTable)
        .values({
          projectId: s.entityId!,
          text: p.text,
          decidedAt: p.decided_at,
          decidedBy: str(p.decided_by),
          source: cleanText(p.source) ?? s.sourceLabel ?? s.sourceType ?? null,
          confidential: p.confidential ?? null,
          createdBy: s.proposedBy,
          approvedAt: now,
          suggestionId: s.id,
        })
        .returning();
      await touch(tx, "project", s.entityId!);
      await audit("create", "decision", created.id, { projectId: s.entityId });
      return { type: "decision", id: created.id };
    }
    case "person": {
      const p = payload as unknown as PersonPayload;
      let email = str(p.email)?.toLowerCase() ?? null;
      if (email) {
        // Never reuse an address someone else already has; that could merge two people.
        const [taken] = await tx.select({ id: peopleTable.id }).from(peopleTable).where(sql`lower(${peopleTable.email}) = ${email}`);
        if (taken) email = null;
      }
      let organisationId = p.organisation_id ?? null;
      if (organisationId != null) {
        const [org] = await tx.select({ id: organisationsTable.id }).from(organisationsTable).where(eq(organisationsTable.id, organisationId));
        if (!org) organisationId = null;
      }
      const slug = await uniqueSlug(tx, "person", p.name);
      const [row] = await tx
        .insert(peopleTable)
        .values({ name: p.name, slug, email, organisationId, role: str(p.role), relationshipSummary: str(p.relationship_summary) })
        .returning({ id: peopleTable.id });
      await audit("create", "person", row.id, { name: p.name });
      return { type: "person", id: row.id };
    }
    case "organisation": {
      const p = payload as unknown as OrganisationPayload;
      const slug = await uniqueSlug(tx, "organisation", p.name);
      const [row] = await tx
        .insert(organisationsTable)
        .values({ name: p.name, slug, type: str(p.type), summary: str(p.summary) })
        .returning({ id: organisationsTable.id });
      await audit("create", "organisation", row.id, { name: p.name });
      return { type: "organisation", id: row.id };
    }
    case "project": {
      const p = payload as unknown as ProjectPayload;
      const slug = await uniqueSlug(tx, "project", p.name);
      const [row] = await tx
        .insert(projectsTable)
        .values({ name: p.name, slug, area: str(p.area), status: str(p.status), summary: str(p.summary) })
        .returning({ id: projectsTable.id });
      await audit("create", "project", row.id, { name: p.name });
      return { type: "project", id: row.id };
    }
    case "summary_change": {
      const p = payload as unknown as SummaryChangePayload;
      const type = s.entityType as EntityKind;
      const id = s.entityId!;
      await resolveEntity(type, id, tx);
      const f = p.fields;
      if (type === "person") {
        const set: Partial<typeof peopleTable.$inferInsert> = {};
        if (f.role !== undefined) set.role = f.role;
        if (f.relationship_summary !== undefined) set.relationshipSummary = f.relationship_summary;
        if (f.email !== undefined) {
          const email = f.email.toLowerCase();
          const [taken] = await tx.select({ id: peopleTable.id }).from(peopleTable).where(sql`lower(${peopleTable.email}) = ${email}`);
          if (taken && taken.id !== id) throw new ValidationError("Someone else already has that email address");
          set.email = email;
        }
        if (f.organisation !== undefined && p.organisation_id != null) set.organisationId = p.organisation_id;
        if (Object.keys(set).length) await tx.update(peopleTable).set(set).where(eq(peopleTable.id, id));
      } else if (type === "project") {
        const set: Partial<typeof projectsTable.$inferInsert> = {};
        if (f.area !== undefined) set.area = f.area;
        if (f.status !== undefined) set.status = f.status;
        if (f.summary !== undefined) set.summary = f.summary;
        if (Object.keys(set).length) await tx.update(projectsTable).set(set).where(eq(projectsTable.id, id));
      } else {
        const set: Partial<typeof organisationsTable.$inferInsert> = {};
        if (f.type !== undefined) set.type = f.type;
        if (f.summary !== undefined) set.summary = f.summary;
        if (Object.keys(set).length) await tx.update(organisationsTable).set(set).where(eq(organisationsTable.id, id));
      }
      await audit("update", type, id, { fields: Object.keys(f) });
      return { type, id };
    }
    case "document": {
      const p = payload as unknown as DocumentPayload;
      try {
        const id = await insertDocument(tx, { url: p.url, title: p.title, summary: str(p.summary), confidential: p.confidential === true ? true : null, projectIds: p.project_ids ?? [] }, s.proposedBy, s.id);
        return { type: "document", id };
      } catch (err) {
        if (err instanceof ConflictError) throw new ValidationError(err.message);
        throw err;
      }
    }
    case "playbook": {
      // Created enabled: approving is what makes it active (feature 07 rule 4).
      const p = payload as unknown as PlaybookPayload;
      const id = await insertPlaybook(
        tx,
        { title: p.title, appliesWhen: p.applies_when, rule: p.rule, enabled: true, projectIds: p.project_ids ?? [], organisationIds: p.organisation_ids ?? [] },
        s.id,
      );
      return { type: "playbook", id };
    }
    case "cadence": {
      const p = payload as unknown as CadencePayload;
      const [person] = await tx.select({ id: peopleTable.id, isSelf: peopleTable.isSelf, cadence: peopleTable.cadence }).from(peopleTable).where(eq(peopleTable.id, s.entityId!));
      if (!person) throw new NotFoundError("That person no longer exists");
      if (person.isSelf) throw new ValidationError("Your own record has no cadence");
      await tx.update(peopleTable).set({ cadence: p.cadence }).where(eq(peopleTable.id, person.id));
      await audit("update", "person", person.id, { fields: ["cadence"], cadence: { from: person.cadence, to: p.cadence } });
      return { type: "person", id: person.id };
    }
  }
}

export async function approveSuggestion(id: number, edits?: Record<string, string>, now = new Date()) {
  return db.transaction(async (tx) => {
    const s = await loadPending(tx, id);
    if (await inPendingConflict(tx, id)) throw new ValidationError("This one disagrees with a current fact. Choose on the Conflicts tab.");
    const payload = withEdits(s, edits);
    const result = await applySuggestion(tx, s, payload, now);
    const done = await tx
      .update(suggestionsTable)
      .set({ status: "approved", decidedAt: now, resultType: result.type, resultId: result.id })
      .where(and(eq(suggestionsTable.id, id), eq(suggestionsTable.status, "pending")))
      .returning({ id: suggestionsTable.id });
    if (!done.length) throw new ValidationError("That suggestion was already decided");
    await writeAudit(tx, {
      actor: ACTOR,
      action: "approve",
      entityType: "suggestion",
      entityId: id,
      payload: { kind: s.kind, result: `${result.type}:${result.id}`, edited: edits && Object.keys(edits).length ? Object.keys(edits) : [] },
    });
    return { id, status: "approved" as const, result };
  });
}

export async function rejectSuggestion(id: number, now = new Date()) {
  return db.transaction(async (tx) => {
    const s = await loadPending(tx, id);
    if (await inPendingConflict(tx, id)) throw new ValidationError("This one disagrees with a current fact. Choose on the Conflicts tab.");
    await markRejected(tx, s.id, now);
    await writeAudit(tx, { actor: ACTOR, action: "reject", entityType: "suggestion", entityId: id, payload: { kind: s.kind } });
    return { id, status: "rejected" as const, result: null };
  });
}

export async function markRejected(tx: DbOrTx, id: number, now: Date) {
  await tx
    .update(suggestionsTable)
    .set({ status: "rejected", decidedAt: now })
    .where(and(eq(suggestionsTable.id, id), eq(suggestionsTable.status, "pending")));
}

/** Clears rejected suggestions once they are past the 30 days they are kept for. */
export async function clearOldRejected(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - REJECTED_MEMORY_DAYS * 86_400_000);
  const rows = await db
    .delete(suggestionsTable)
    .where(and(eq(suggestionsTable.status, "rejected"), lt(suggestionsTable.decidedAt, before)))
    .returning({ id: suggestionsTable.id });
  return rows.length;
}
