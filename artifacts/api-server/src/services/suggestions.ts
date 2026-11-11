/**
 * Knowledge Inbox (feature 01). AI tools propose; Ollie approves, edits then approves, or rejects.
 * Nothing an AI proposes becomes a fact, decision, person, organisation, project, product, rule or
 * playbook until approved.
 * Tasks, promises, activity, notes and the calendar still write directly (build plan 24 and 26).
 */
import { queueContradictionCheck } from "./contradictionQueue";
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  decisionsTable,
  documentsTable,
  factReviewsTable,
  factsTable,
  linksTable,
  organisationsTable,
  peopleTable,
  productsTable,
  projectsTable,
  suggestionsTable,
  FACT_ATTRIBUTES,
  type Suggestion,
} from "@workspace/db";
import { hasEmail } from "./personMatch";
import { RULE_MAX, RELATIONSHIPS, isBusinessFunction, type BusinessFunction, isClientOrgType, isProductUser, type Cadence, type ProductState, type ProductUser, type Relationship } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { ACTOR, cleanText, resolveEntity, touch, uniqueSlug, type EntityKind } from "./knowledge/common";
import { ConflictError, NotFoundError, ValidationError } from "./tasks";
import { addDocumentProjects, insertDocument, insertRule, keepDocumentText } from "./library";
import { enqueueDocument } from "./documents/enqueue";
import { assertDecidesOn, existingRelationship, sameRelationship, setRelationship } from "./relationships";
import { applyPlaybookUpdate, cleanSteps, insertPlaybook, loadPlaybook } from "./playbooks";
import { insertProduct } from "./products";

export { FACT_ATTRIBUTES };
export type FactAttribute = (typeof FACT_ATTRIBUTES)[number];
/** Where a suggestion came from. */
export const SUGGESTION_SOURCES = ["email", "meeting", "chat", "recording", "voice", "calendar", "slack", "document"] as const;
export type SuggestionKind = Suggestion["kind"];

/** Who proposes what a Granola look back finds, so the Knowledge Inbox can mark and filter them. */
export const LOOK_BACK_PROPOSER = "Granola look back";

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
  /** What the decision is about when no project matched, so Ollie can file it under a project on approval */
  project_hint?: string | null;
}
export interface PersonPayload {
  name: string;
  email?: string | null;
  role?: string | null;
  organisation_id?: number | null;
  organisation_name?: string | null;
  relationship_summary?: string | null;
}
/**
 * Three shapes: a new document from a link; a new document whose text Claude saved (content, no
 * link); or links from a document already in the Library (document_id) to more projects.
 */
export interface DocumentPayload {
  url?: string | null;
  title: string;
  /** Set when proposing links for a document already in the Library */
  document_id?: number | null;
  /** The text, when Claude saved it with save_document */
  content?: string | null;
  /** What Claude called it: artifact, notes, plan and so on */
  doc_kind?: string | null;
  summary?: string | null;
  project_ids?: number[];
  /** Project names when proposed, for the card */
  project_names?: string[];
  /** Set when the proposer thinks the file is sensitive; the document is then always hidden from AI */
  confidential?: boolean | null;
}
export interface RulePayload {
  title: string;
  applies_when: string;
  rule: string;
  project_ids?: number[];
  organisation_ids?: number[];
  /** Names when proposed, for the card */
  link_names?: string[];
}
/** A step in a proposed playbook. An id that matches a current step means that step, changed or not. */
export interface PlaybookStepPayload {
  id?: string | null;
  text: string;
  person_id?: number | null;
  /** Name when proposed, for the card */
  person_name?: string | null;
  after_days?: number | null;
}
/**
 * Two shapes: a new playbook, or (playbook_id set) the whole proposed new version of one already in
 * OllieOS. `before` keeps what it said when proposed, so the card can show the change.
 */
export interface PlaybookPayload {
  playbook_id?: number | null;
  title: string;
  when_to_use: string;
  purpose?: string | null;
  owner_id?: number | null;
  owner_name?: string | null;
  steps: PlaybookStepPayload[];
  notes?: string | null;
  /** What changed and why, in a line, for a change */
  reason?: string | null;
  project_ids?: number[];
  organisation_ids?: number[];
  product_ids?: number[];
  document_ids?: number[];
  /** Names when proposed, for the card */
  link_names?: string[];
  before?: {
    title: string;
    when_to_use: string;
    purpose: string | null;
    owner_name: string | null;
    steps: PlaybookStepPayload[];
  } | null;
}
/** A product OllieOS does not know yet, with any facts found about it in the same read. */
export interface ProductPayload {
  name: string;
  description?: string | null;
  state?: ProductState | null;
  /** Who it is mainly for, from the fixed list */
  primary_user?: ProductUser | null;
  summary?: string | null;
  /** Facts found about it in the same read; they become facts on the product when approved */
  facts?: string[];
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
  /** Projects it is the client of; approving links them */
  client_of_project_ids?: number[];
  /** Their names when proposed, for the card */
  client_of_project_names?: string[];
}
export interface ProjectPayload {
  name: string;
  area?: string | null;
  status?: string | null;
  summary?: string | null;
  /** The part of the business it belongs to */
  function?: BusinessFunction | null;
  /** A known organisation it is for, linked as its client when approved */
  client_id?: number | null;
  client_name?: string | null;
}
/** A stated relationship from the suggestion's item to another one (Part G), read "from <relationship> to". */
export interface RelationshipPayload {
  relationship: Relationship;
  to_type: EntityKind;
  to_id: number;
  /** Names when proposed, for the card */
  from_name?: string | null;
  to_name?: string | null;
  /** The evidence, kept as the relationship's note */
  note?: string | null;
}
/** Changes to an existing person, project or organisation. Values are the proposed text. */
export interface SummaryChangePayload {
  fields: Record<string, string>;
  /** What the fields said when it was proposed, for the card */
  before: Record<string, string | null>;
  /** When the change moves a person to another organisation */
  organisation_id?: number | null;
  /** When the change gives a project a client: the organisation to link */
  client_id?: number | null;
  /** Why AI suggests it, in a line, when it says (a product's primary user) */
  reason?: string | null;
}

export type Proposal =
  | { kind: "fact"; entityType: EntityKind; entityId: number; payload: FactPayload }
  /** A decision with no project can be filed under one when Ollie approves it, or stand on its own. */
  | { kind: "decision"; entityType: "project" | null; entityId: number | null; payload: DecisionPayload }
  | { kind: "person"; payload: PersonPayload }
  | { kind: "organisation"; payload: OrganisationPayload }
  | { kind: "project"; payload: ProjectPayload }
  | { kind: "summary_change"; entityType: EntityKind; entityId: number; payload: SummaryChangePayload }
  | { kind: "document"; payload: DocumentPayload }
  | { kind: "rule"; payload: RulePayload }
  | { kind: "playbook"; payload: PlaybookPayload }
  | { kind: "product"; payload: ProductPayload }
  | { kind: "cadence"; entityType: "person"; entityId: number; payload: CadencePayload }
  | { kind: "relationship"; entityType: EntityKind; entityId: number; payload: RelationshipPayload };

export interface ProposeMeta {
  /** Client name: "Capture sweep", "Claude" */
  proposedBy: string;
  clientId: number | null;
  sourceType?: string | null;
  sourceRef?: string | null;
  sourceUrl?: string | null;
  sourceLabel?: string | null;
  /** Part N: who made the claim and when. Matched to a person by id, email or exact name. */
  saidBy?: SaidBy | null;
}

export interface SaidBy {
  name?: string | null;
  email?: string | null;
  personId?: number | null;
  at?: Date | null;
}

/** Who said a claim, matched to a person in People where one fits. */
export async function resolveSaidBy(s: SaidBy | null | undefined): Promise<{ saidByName: string | null; saidById: number | null; saidAt: Date | null }> {
  if (!s) return { saidByName: null, saidById: null, saidAt: null };
  const at = s.at && !Number.isNaN(s.at.getTime()) ? s.at : null;
  const name = cleanText(s.name)?.slice(0, 200) ?? null;
  const email = cleanText(s.email)?.toLowerCase() ?? null;
  let person: { id: number; name: string } | null = null;
  const cols = { id: peopleTable.id, name: peopleTable.name };
  if (s.personId != null) [person = null] = await db.select(cols).from(peopleTable).where(eq(peopleTable.id, s.personId));
  if (!person && email) [person = null] = await db.select(cols).from(peopleTable).where(hasEmail(email)).limit(1);
  if (!person && name) {
    const hits = await db.select(cols).from(peopleTable).where(sql`lower(${peopleTable.name}) = ${name.toLowerCase()}`).limit(2);
    if (hits.length === 1) person = hits[0];
  }
  return { saidByName: name ?? person?.name ?? email, saidById: person?.id ?? null, saidAt: at };
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
  note: "Note",
  when_to_use: "When to use it",
  purpose: "What it is for",
  notes: "Notes",
  description: "Description",
  owner: "Owner",
  primary_user: "Primary user",
  function: "Function",
  client: "Client",
};
const EDITABLE: Record<Exclude<SuggestionKind, "summary_change">, string[]> = {
  fact: ["text"],
  decision: ["text", "decided_by"],
  person: ["name", "role", "email", "relationship_summary"],
  organisation: ["name", "type", "summary"],
  project: ["name", "area", "status", "summary"],
  document: ["title", "summary"],
  rule: ["title", "applies_when", "rule"],
  playbook: ["title", "when_to_use", "purpose"],
  product: ["name", "description", "summary"],
  cadence: [],
  relationship: ["note"],
};
const REQUIRED = new Set(["text", "name", "title", "applies_when", "rule", "when_to_use"]);
/** Columns a summary change may set on each kind of record. */
const CHANGEABLE: Record<EntityKind, string[]> = {
  person: ["role", "email", "relationship_summary", "organisation"],
  project: ["area", "status", "summary", "function", "client"],
  organisation: ["type", "summary"],
  product: ["description", "summary", "primary_user"],
};

/** Fields on a change card that are picked from a fixed list, so they are approved or rejected but not typed over. */
const FIXED_FIELDS = new Set(["organisation", "primary_user", "function", "client"]);

export function changeableFields(type: EntityKind): string[] {
  return CHANGEABLE[type];
}

export function editableFields(s: Pick<Suggestion, "kind" | "payload">): string[] {
  if (s.kind === "summary_change") return Object.keys((s.payload as SummaryChangePayload).fields).filter((k) => !FIXED_FIELDS.has(k));
  if (s.kind === "document" && (s.payload as DocumentPayload).document_id != null) return [];
  return EDITABLE[s.kind];
}

/**
 * Makes an organisation a project's client: links them (if not already) and, when the organisation
 * is not yet typed as a client, types it "customer". Skips a project or organisation that has gone.
 */
async function linkClient(tx: DbOrTx, projectId: number, orgId: number): Promise<void> {
  const [[project], [org]] = await Promise.all([
    tx.select({ id: projectsTable.id }).from(projectsTable).where(eq(projectsTable.id, projectId)),
    tx.select({ id: organisationsTable.id, type: organisationsTable.type }).from(organisationsTable).where(eq(organisationsTable.id, orgId)),
  ]);
  if (!project || !org) return;
  const [linked] = await tx
    .select({ fromId: linksTable.fromId })
    .from(linksTable)
    .where(
      sql`(${linksTable.fromType} = 'project' and ${linksTable.fromId} = ${projectId} and ${linksTable.toType} = 'organisation' and ${linksTable.toId} = ${orgId})
        or (${linksTable.toType} = 'project' and ${linksTable.toId} = ${projectId} and ${linksTable.fromType} = 'organisation' and ${linksTable.fromId} = ${orgId})`,
    );
  if (!linked) await tx.insert(linksTable).values({ fromType: "project", fromId: projectId, toType: "organisation", toId: orgId, createdBy: ACTOR });
  if (!isClientOrgType(org.type)) await tx.update(organisationsTable).set({ type: "customer" }).where(eq(organisationsTable.id, orgId));
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
      if (p.payload.document_id != null) return `link ${p.payload.document_id} to ${[...(p.payload.project_ids ?? [])].sort((a, b) => a - b).join(",")}`;
      return p.payload.url ?? `saved: ${p.payload.title}`;
    case "rule":
      return `${p.payload.title}: ${p.payload.rule}`;
    case "playbook":
      return p.payload.playbook_id != null
        ? `change ${p.payload.playbook_id}: ${p.payload.steps.map((s) => s.text).join(" / ")}`
        : `${p.payload.title}: ${p.payload.when_to_use}`;
    case "product":
      return p.payload.name;
    case "cadence":
      return p.payload.cadence;
    case "relationship":
      return `${p.payload.relationship} ${p.payload.to_type}:${p.payload.to_id}`;
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
  if (p.kind === "summary_change" && "primary_user" in p.payload.fields && (p.entityType !== "product" || !isProductUser(p.payload.fields.primary_user))) {
    throw new ValidationError("Choose a primary user from the list");
  }
  if (p.kind === "summary_change" && "function" in p.payload.fields && (p.entityType !== "project" || !isBusinessFunction(p.payload.fields.function))) {
    throw new ValidationError("Choose a function from the list");
  }
  if (p.kind === "summary_change" && "client" in p.payload.fields) {
    const id = p.payload.client_id;
    const [org] = p.entityType === "project" && id != null ? await db.select({ name: organisationsTable.name }).from(organisationsTable).where(eq(organisationsTable.id, id)) : [];
    if (!org) throw new ValidationError("Choose a client organisation OllieOS knows");
    p.payload.fields.client = org.name;
  }
  if (p.kind === "project" && p.payload.function != null && !isBusinessFunction(p.payload.function)) throw new ValidationError("Choose a function from the list");
  if (p.kind === "product" && p.payload.primary_user != null && !isProductUser(p.payload.primary_user)) throw new ValidationError("Choose a primary user from the list");
  if (p.kind === "rule" && p.payload.rule.length > RULE_MAX) throw new ValidationError(`Keep the rule to ${RULE_MAX} characters or fewer`);
  const norm = normalise(text);
  const { entityType, entityId } = entityOf(p);
  const sameTarget = and(
    eq(suggestionsTable.kind, p.kind),
    eq(suggestionsTable.normalisedText, norm),
    entityType ? and(eq(suggestionsTable.entityType, entityType), eq(suggestionsTable.entityId, entityId!)) : isNull(suggestionsTable.entityType),
  );

  const [pending] = await db.select({ id: suggestionsTable.id }).from(suggestionsTable).where(and(sameTarget, inArray(suggestionsTable.status, ["pending", "merged"])));
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
  if (p.kind === "relationship") {
    const { to_type, to_id, relationship } = p.payload;
    if (!RELATIONSHIPS.includes(relationship)) throw new ValidationError("Choose a relationship");
    assertDecidesOn({ type: p.entityType, id: p.entityId }, { type: to_type, id: to_id }, relationship);
    if (p.entityType === to_type && p.entityId === to_id) throw new ValidationError("An item cannot be related to itself");
    const [from, to] = await Promise.all([resolveEntity(p.entityType, p.entityId), resolveEntity(to_type, to_id)]);
    p.payload.from_name = from.name;
    p.payload.to_name = to.name;
    const row = await existingRelationship({ type: p.entityType, id: p.entityId }, { type: to_type, id: to_id });
    if (row && sameRelationship(row, { type: p.entityType, id: p.entityId }, relationship)) return { status: "duplicate" };
  }
  if (p.kind === "playbook") await preparePlaybook(p.payload);
  if (p.kind === "product") {
    const [same] = await db.select({ id: productsTable.id }).from(productsTable).where(sql`lower(${productsTable.name}) = ${norm}`);
    if (same) return { status: "duplicate" };
    p.payload.facts = (p.payload.facts ?? []).map((f) => cleanText(f)).filter((f): f is string => !!f).slice(0, 20);
  }
  if (p.kind === "document" && p.payload.document_id == null && p.payload.url) {
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

  const said = await resolveSaidBy(meta.saidBy);
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(suggestionsTable)
      .values({
        ...said,
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
  if (result.status === "suggested" && (p.kind === "fact" || p.kind === "decision" || p.kind === "rule")) queueContradictionCheck();
  return result;
}

/**
 * Checks a proposed playbook, fills in names for the card, and for a change keeps what the
 * playbook says now. Throws when the change would leave it as it is.
 */
async function preparePlaybook(p: PlaybookPayload): Promise<void> {
  if (!cleanText(p.when_to_use) && p.playbook_id == null) throw new ValidationError("Say when to use the playbook");
  const steps = cleanSteps((p.steps ?? []).map((s) => ({ id: s.id, text: s.text, personId: s.person_id ?? null, afterDays: s.after_days ?? null })));
  const personIds = [p.owner_id, ...steps.map((s) => s.personId)].filter((x): x is number => x != null);
  const people = personIds.length
    ? new Map((await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, personIds))).map((r) => [r.id, r.name]))
    : new Map<number, string>();
  if (p.owner_id != null && !people.has(p.owner_id)) p.owner_id = null;
  p.owner_name = p.owner_id != null ? people.get(p.owner_id)! : null;
  p.steps = steps.map((s) => {
    const personId = s.personId != null && people.has(s.personId) ? s.personId : null;
    return { id: s.id, text: s.text, person_id: personId, person_name: personId ? people.get(personId)! : null, after_days: s.afterDays };
  });
  if (p.playbook_id == null) return;
  const current = await loadPlaybook(p.playbook_id);
  const ownerName = current.ownerId
    ? ((await db.select({ name: peopleTable.name }).from(peopleTable).where(eq(peopleTable.id, current.ownerId)))[0]?.name ?? null)
    : null;
  const stepPeople = current.steps.map((s) => s.personId).filter((x): x is number => x != null);
  const currentPeople = stepPeople.length
    ? new Map((await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, stepPeople))).map((r) => [r.id, r.name]))
    : new Map<number, string>();
  p.title = cleanText(p.title) ?? current.title;
  p.when_to_use = cleanText(p.when_to_use) ?? current.whenToUse;
  if (p.purpose === undefined) p.purpose = current.purpose;
  if (p.owner_id === undefined) {
    p.owner_id = current.ownerId;
    p.owner_name = ownerName;
  }
  p.before = {
    title: current.title,
    when_to_use: current.whenToUse,
    purpose: current.purpose,
    owner_name: ownerName,
    steps: current.steps.map((s) => ({ id: s.id, text: s.text, person_id: s.personId, person_name: s.personId ? (currentPeople.get(s.personId) ?? null) : null, after_days: s.afterDays })),
  };
  const sameSteps =
    p.steps.length === current.steps.length &&
    p.steps.every((s, i) => normalise(s.text) === normalise(current.steps[i].text) && (s.person_id ?? null) === current.steps[i].personId && (s.after_days ?? null) === current.steps[i].afterDays);
  if (sameSteps && p.title === current.title && p.when_to_use === current.whenToUse && (p.purpose ?? null) === current.purpose && (p.owner_id ?? null) === current.ownerId) {
    throw new ValidationError("That is what the playbook already says");
  }
}

/* ---------- Approve and reject (Ollie) ---------- */

async function loadPending(conn: DbOrTx, id: number): Promise<Suggestion> {
  const [s] = await conn.select().from(suggestionsTable).where(eq(suggestionsTable.id, id));
  if (!s) throw new NotFoundError("That suggestion does not exist");
  if (s.status !== "pending") throw new ValidationError(s.status === "approved" ? "That suggestion was already approved" : s.status === "merged" ? "That suggestion was already marked as the same as an existing item" : "That suggestion was already rejected");
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
): Promise<{ type: "fact" | "decision" | "person" | "organisation" | "project" | "product" | "document" | "rule" | "playbook"; id: number }> {
  const audit = (action: string, entityType: "fact" | "decision" | "person" | "organisation" | "project" | "product" | "playbook", entityId: number, extra: Record<string, unknown> = {}) =>
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
      // A decision proposed without a project, and approved without one, stands on its own.
      const projectId = s.entityId ?? null;
      if (projectId != null) await resolveEntity("project", projectId, tx);
      const [created] = await tx
        .insert(decisionsTable)
        .values({
          projectId,
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
      if (projectId != null) await touch(tx, "project", projectId);
      await audit("create", "decision", created.id, { projectId });
      return { type: "decision", id: created.id };
    }
    case "person": {
      const p = payload as unknown as PersonPayload;
      let email = str(p.email)?.toLowerCase() ?? null;
      if (email) {
        // Never reuse an address someone else already has; that could merge two people.
        const [taken] = await tx.select({ id: peopleTable.id }).from(peopleTable).where(hasEmail(email));
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
      for (const projectId of p.client_of_project_ids ?? []) await linkClient(tx, projectId, row.id);
      return { type: "organisation", id: row.id };
    }
    case "project": {
      const p = payload as unknown as ProjectPayload;
      const slug = await uniqueSlug(tx, "project", p.name);
      const [row] = await tx
        .insert(projectsTable)
        .values({ name: p.name, slug, area: str(p.area), status: str(p.status), summary: str(p.summary), function: isBusinessFunction(p.function) ? p.function : null })
        .returning({ id: projectsTable.id });
      await audit("create", "project", row.id, { name: p.name });
      if (p.client_id != null) await linkClient(tx, row.id, p.client_id);
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
          const [taken] = await tx.select({ id: peopleTable.id }).from(peopleTable).where(hasEmail(email));
          if (taken && taken.id !== id) throw new ValidationError("Someone else already has that email address");
          set.email = email;
        }
        if (f.organisation !== undefined && p.organisation_id != null) set.organisationId = p.organisation_id;
        if (Object.keys(set).length) await tx.update(peopleTable).set(set).where(eq(peopleTable.id, id));
      } else if (type === "product") {
        const set: Partial<typeof productsTable.$inferInsert> = {};
        if (f.description !== undefined) set.description = f.description;
        if (f.summary !== undefined) set.summary = f.summary;
        if (isProductUser(f.primary_user)) set.primaryUser = f.primary_user;
        if (Object.keys(set).length) await tx.update(productsTable).set(set).where(eq(productsTable.id, id));
      } else if (type === "project") {
        const set: Partial<typeof projectsTable.$inferInsert> = {};
        if (f.area !== undefined) set.area = f.area;
        if (f.status !== undefined) set.status = f.status;
        if (f.summary !== undefined) set.summary = f.summary;
        if (isBusinessFunction(f.function)) {
          const [row] = await tx.select({ isFunction: projectsTable.isFunction }).from(projectsTable).where(eq(projectsTable.id, id));
          if (row?.isFunction) throw new ValidationError("This is a function, so it cannot move to another one");
          set.function = f.function;
        }
        if (Object.keys(set).length) await tx.update(projectsTable).set(set).where(eq(projectsTable.id, id));
        if (f.client !== undefined && p.client_id != null) await linkClient(tx, id, p.client_id);
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
      if (p.document_id != null) {
        await addDocumentProjects(tx, p.document_id, p.project_ids ?? []);
        return { type: "document", id: p.document_id };
      }
      try {
        const id = await insertDocument(
          tx,
          { url: p.url ?? null, title: p.title, summary: str(p.summary), confidential: p.confidential === true ? true : null, projectIds: p.project_ids ?? [] },
          s.proposedBy,
          s.id,
        );
        // Text Claude saved is kept and goes through the knowledge step like any other document.
        if (p.content) {
          await keepDocumentText(tx, id, p.content, "claude", { originName: str(p.doc_kind), now });
          const [d] = await tx.select({ title: documentsTable.title }).from(documentsTable).where(eq(documentsTable.id, id));
          await enqueueDocument(tx, { id, title: d.title, url: null }, now);
        }
        return { type: "document", id };
      } catch (err) {
        if (err instanceof ConflictError) throw new ValidationError(err.message);
        throw err;
      }
    }
    case "rule": {
      // Created enabled: approving is what makes it active (feature 07 rule 4).
      const p = payload as unknown as RulePayload;
      const id = await insertRule(
        tx,
        { title: p.title, appliesWhen: p.applies_when, rule: p.rule, enabled: true, projectIds: p.project_ids ?? [], organisationIds: p.organisation_ids ?? [] },
        s.id,
      );
      return { type: "rule", id };
    }
    case "playbook": {
      const p = payload as unknown as PlaybookPayload;
      const steps = (p.steps ?? []).map((st) => ({ id: st.id, text: st.text, personId: st.person_id ?? null, afterDays: st.after_days ?? null }));
      if (p.playbook_id != null) {
        // Approving a change is also a check that the playbook is how things are done now.
        const change = await applyPlaybookUpdate(
          tx,
          p.playbook_id,
          { title: p.title, whenToUse: p.when_to_use, purpose: str(p.purpose), ownerId: p.owner_id ?? null, steps, checked: true },
          now,
        );
        await audit("update", "playbook", p.playbook_id, change);
        return { type: "playbook", id: p.playbook_id };
      }
      // Created In use: approving is what makes it active, as with rules.
      const id = await insertPlaybook(
        tx,
        {
          title: p.title,
          whenToUse: p.when_to_use,
          purpose: str(p.purpose),
          ownerId: p.owner_id ?? null,
          steps,
          notes: str(p.notes),
          state: "in_use",
          projectIds: p.project_ids ?? [],
          organisationIds: p.organisation_ids ?? [],
          productIds: p.product_ids ?? [],
          documentIds: p.document_ids ?? [],
        },
        s.proposedBy,
        s.id,
      );
      return { type: "playbook", id };
    }
    case "product": {
      const p = payload as unknown as ProductPayload;
      const id = await insertProduct(
        tx,
        { name: p.name, description: str(p.description), state: p.state ?? "live", primaryUser: isProductUser(p.primary_user) ? p.primary_user : null, summary: str(p.summary) },
        s.proposedBy,
        s.id,
      );
      const source = s.sourceLabel ?? s.sourceType ?? null;
      for (const text of p.facts ?? []) {
        const [f] = await tx
          .insert(factsTable)
          .values({ entityType: "product", entityId: id, text, source, createdBy: s.proposedBy, lastConfirmedAt: now, approvedAt: now, suggestionId: s.id })
          .returning({ id: factsTable.id });
        await audit("create", "fact", f.id, { on: `product:${id}` });
      }
      return { type: "product", id };
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
    case "relationship": {
      const p = payload as unknown as RelationshipPayload;
      await setRelationship(
        { from: { type: s.entityType as EntityKind, id: s.entityId! }, to: { type: p.to_type, id: p.to_id }, relationship: p.relationship, note: p.note ?? null },
        { conn: tx, source: s.sourceLabel ?? s.proposedBy, suggestionId: s.id },
      );
      return { type: s.entityType as EntityKind, id: s.entityId! };
    }
  }
}

/** For a decision proposed without a project: a project Ollie chose, a new one he named, or none. */
export interface ApproveProject {
  projectId?: number;
  newProjectName?: string;
}

async function projectForDecision(tx: DbOrTx, choice: ApproveProject | undefined): Promise<number | null> {
  const name = cleanText(choice?.newProjectName);
  if (name) {
    const slug = await uniqueSlug(tx, "project", name);
    const [row] = await tx.insert(projectsTable).values({ name, slug }).returning({ id: projectsTable.id });
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "project", entityId: row.id, payload: { name, via: "decision_approval" } });
    return row.id;
  }
  if (choice?.projectId == null) return null;
  const [p] = await tx.select({ id: projectsTable.id, archived: projectsTable.archived }).from(projectsTable).where(eq(projectsTable.id, choice.projectId));
  if (!p) throw new ValidationError("That project does not exist");
  if (p.archived) throw new ValidationError("That project is archived");
  return p.id;
}

export async function approveSuggestion(id: number, edits?: Record<string, string>, now = new Date(), project?: ApproveProject) {
  return db.transaction(async (tx) => {
    let s = await loadPending(tx, id);
    if (await inPendingConflict(tx, id)) throw new ValidationError("This one disagrees with something already approved. Choose on the Conflicts tab.");
    if (s.kind === "decision" && s.entityId == null) {
      const projectId = await projectForDecision(tx, project);
      if (projectId != null) {
        await tx.update(suggestionsTable).set({ entityType: "project", entityId: projectId }).where(eq(suggestionsTable.id, id));
        s = { ...s, entityType: "project", entityId: projectId };
      }
    } else if (project?.projectId != null || cleanText(project?.newProjectName)) {
      throw new ValidationError("Only a decision without a project takes a project here");
    }
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
    if (await inPendingConflict(tx, id)) throw new ValidationError("This one disagrees with something already approved. Choose on the Conflicts tab.");
    await markRejected(tx, s.id, now);
    await writeAudit(tx, { actor: ACTOR, action: "reject", entityType: "suggestion", entityId: id, payload: { kind: s.kind } });
    return { id, status: "rejected" as const, result: null };
  });
}

/**
 * Rejects everything still waiting that came from one document or Dropbox file, except items
 * waiting on the Conflicts tab. Returns how many were rejected.
 */
export async function rejectFromSource(sourceRef: string, now = new Date()): Promise<number> {
  const rows = await db
    .select({ id: suggestionsTable.id })
    .from(suggestionsTable)
    .where(and(eq(suggestionsTable.status, "pending"), eq(suggestionsTable.sourceRef, sourceRef)));
  let n = 0;
  for (const r of rows) {
    await db.transaction(async (tx) => {
      if (await inPendingConflict(tx, r.id)) return;
      await markRejected(tx, r.id, now);
      await writeAudit(tx, { actor: ACTOR, action: "reject", entityType: "suggestion", entityId: r.id, payload: { sourceRef } });
      n++;
    });
  }
  return n;
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
