/**
 * Playbooks (Part M): how something is done, as ordered steps with an owner. Ollie writes them;
 * AI only proposes a new one or a change through the Knowledge Inbox. Linked to projects,
 * organisations, products and documents through `links`, stored from the playbook.
 * Only In use playbooks reach AI tools, and then under the usual switches.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, documentsTable, peopleTable, playbooksTable, type Playbook, type PlaybookStep } from "@workspace/db";
import { PLAYBOOK_STEPS_MAX, type PlaybookState } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { playbookVisible } from "../lib/ai-data/visibility";
import { ACTOR, cleanText } from "./knowledge/common";
import { NotFoundError, ValidationError } from "./tasks";
import { assertTargets, linkMap, linkMapTo, names, pickNames, setLinks, type NamedLink, type TargetType } from "./library";

/** Longest a single step may be */
export const STEP_MAX = 600;
/** Furthest "days after starting" a step may be */
export const AFTER_DAYS_MAX = 3650;

export interface PlaybookStepView extends PlaybookStep {
  personName: string | null;
  personSlug: string | null;
}

export interface PlaybookView extends Omit<Playbook, "search" | "suggestionId" | "steps"> {
  steps: PlaybookStepView[];
  owner: NamedLink | null;
  projects: NamedLink[];
  organisations: NamedLink[];
  products: NamedLink[];
  documents: { id: number; title: string }[];
  /** True when AI tools cannot read it: not In use, its own flag, or a hidden project or product */
  hiddenFromAi: boolean;
  /** Where it came from when it was approved from a suggestion */
  source: string | null;
}

/** A step as given by Ollie or a proposal; a missing id gets a new one. */
export interface StepInput {
  id?: string | null;
  text: string;
  personId?: number | null;
  afterDays?: number | null;
}

async function personNames(ids: number[]): Promise<Map<number, NamedLink>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug }).from(peopleTable).where(inArray(peopleTable.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

async function toViews(rows: Playbook[]): Promise<PlaybookView[]> {
  const ids = rows.map((r) => r.id);
  const [projectLinks, orgLinks, productLinks, docLinks, hidden, people] = await Promise.all([
    linkMap("playbook", ids, "project"),
    linkMap("playbook", ids, "organisation"),
    linkMap("playbook", ids, "product"),
    linkMap("playbook", ids, "document"),
    ids.length
      ? db.select({ id: playbooksTable.id }).from(playbooksTable).where(and(inArray(playbooksTable.id, ids), sql.raw(`not ${playbookVisible("process_playbooks")}`)))
      : [],
    personNames(rows.flatMap((r) => [r.ownerId, ...r.steps.map((s) => s.personId)]).filter((x): x is number => x != null)),
  ]);
  const all = (m: Map<number, number[]>) => [...new Set([...m.values()].flat())];
  const docIds = all(docLinks);
  const [projectNames, orgNames, productNames, docs, sources] = await Promise.all([
    names("project", all(projectLinks)),
    names("organisation", all(orgLinks)),
    names("product", all(productLinks)),
    docIds.length ? db.select({ id: documentsTable.id, title: documentsTable.title }).from(documentsTable).where(inArray(documentsTable.id, docIds)) : [],
    sourceLabels(rows.map((r) => r.suggestionId).filter((x): x is number => x != null)),
  ]);
  const docMap = new Map(docs.map((d) => [d.id, d]));
  const hiddenSet = new Set(hidden.map((h) => h.id));
  return rows.map(({ search: _s, suggestionId, steps, ...r }) => ({
    ...r,
    steps: steps.map((st) => ({ ...st, personName: st.personId ? (people.get(st.personId)?.name ?? null) : null, personSlug: st.personId ? (people.get(st.personId)?.slug ?? null) : null })),
    owner: r.ownerId ? (people.get(r.ownerId) ?? null) : null,
    projects: pickNames(projectNames, projectLinks.get(r.id)),
    organisations: pickNames(orgNames, orgLinks.get(r.id)),
    products: pickNames(productNames, productLinks.get(r.id)),
    documents: (docLinks.get(r.id) ?? [])
      .map((d) => docMap.get(d))
      .filter((d): d is { id: number; title: string } => !!d)
      .sort((a, b) => a.title.localeCompare(b.title, "en-GB")),
    hiddenFromAi: hiddenSet.has(r.id),
    source: suggestionId != null ? (sources.get(suggestionId) ?? null) : null,
  }));
}

/** "Claude", "Capture sweep, email" and so on, for the approved suggestions given. */
async function sourceLabels(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const res = await db.execute(sql`select id, proposed_by, source_label from suggestions where id in (${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )})`);
  return new Map((res.rows as { id: number; proposed_by: string; source_label: string | null }[]).map((r) => [Number(r.id), [r.proposed_by, r.source_label].filter(Boolean).join(", ")]));
}

const STATE_ORDER = sql`case ${playbooksTable.state} when 'in_use' then 0 when 'draft' then 1 else 2 end`;

export async function listPlaybooks(): Promise<PlaybookView[]> {
  const rows = await db.select().from(playbooksTable).orderBy(STATE_ORDER, asc(playbooksTable.title));
  return toViews(rows);
}

/** Playbooks linked to a project, organisation, product or document, for that item's page. */
export async function playbooksFor(target: TargetType | "document", id: number): Promise<PlaybookView[]> {
  const ids = await linkMapTo(target, id, "playbook");
  if (!ids.length) return [];
  const rows = await db.select().from(playbooksTable).where(inArray(playbooksTable.id, ids)).orderBy(STATE_ORDER, asc(playbooksTable.title));
  return toViews(rows);
}

export async function loadPlaybook(id: number, conn: DbOrTx = db): Promise<Playbook> {
  const [row] = await conn.select().from(playbooksTable).where(eq(playbooksTable.id, id));
  if (!row) throw new NotFoundError("That playbook does not exist");
  return row;
}

export async function getPlaybook(id: number): Promise<PlaybookView> {
  return (await toViews([await loadPlaybook(id)]))[0];
}

async function assertPeople(ids: (number | null | undefined)[]): Promise<void> {
  const list = [...new Set(ids.filter((x): x is number => x != null))];
  if (!list.length) return;
  const found = await personNames(list);
  if (found.size !== list.length) throw new NotFoundError("That person does not exist");
}

/** Checks and tidies steps. Ids are kept when given, so a change can be shown against the old steps. */
export function cleanSteps(input: StepInput[]): PlaybookStep[] {
  if (input.length > PLAYBOOK_STEPS_MAX) throw new ValidationError(`A playbook can have up to ${PLAYBOOK_STEPS_MAX} steps`);
  const seen = new Set<string>();
  return input.map((s, i) => {
    const text = cleanText(s.text);
    if (!text) throw new ValidationError(`Step ${i + 1} needs some text`);
    if (text.length > STEP_MAX) throw new ValidationError(`Keep step ${i + 1} to ${STEP_MAX} characters or fewer`);
    const afterDays = s.afterDays ?? null;
    if (afterDays != null && (!Number.isInteger(afterDays) || afterDays < 0 || afterDays > AFTER_DAYS_MAX)) {
      throw new ValidationError(`Days after starting for step ${i + 1} must be a whole number from 0 to ${AFTER_DAYS_MAX}`);
    }
    let id = cleanText(s.id) ?? randomUUID().slice(0, 8);
    if (seen.has(id)) id = randomUUID().slice(0, 8);
    seen.add(id);
    return { id, text, personId: s.personId ?? null, afterDays };
  });
}

export interface PlaybookInput {
  title: string;
  whenToUse: string;
  purpose?: string | null;
  ownerId?: number | null;
  steps?: StepInput[];
  notes?: string | null;
  state?: PlaybookState;
  confidential?: boolean | null;
  projectIds?: number[];
  organisationIds?: number[];
  productIds?: number[];
  documentIds?: number[];
}

async function assertDocuments(ids: number[]): Promise<void> {
  const list = [...new Set(ids)];
  if (!list.length) return;
  const rows = await db.select({ id: documentsTable.id }).from(documentsTable).where(inArray(documentsTable.id, list));
  if (rows.length !== list.length) throw new NotFoundError("That document does not exist");
}

async function assertLinks(input: Partial<PlaybookInput>): Promise<void> {
  await Promise.all([
    assertTargets("project", input.projectIds ?? []),
    assertTargets("organisation", input.organisationIds ?? []),
    assertTargets("product", input.productIds ?? []),
    assertDocuments(input.documentIds ?? []),
  ]);
}

/** Inserts a playbook inside the caller's transaction. Used directly when approving a suggestion. */
export async function insertPlaybook(tx: DbOrTx, input: PlaybookInput, createdBy: string, suggestionId: number | null = null): Promise<number> {
  const title = cleanText(input.title);
  if (!title) throw new ValidationError("A playbook needs a title");
  const whenToUse = cleanText(input.whenToUse);
  if (!whenToUse) throw new ValidationError("Say when to use the playbook");
  const steps = cleanSteps(input.steps ?? []);
  await Promise.all([assertPeople([input.ownerId, ...steps.map((s) => s.personId)]), assertLinks(input)]);
  const [row] = await tx
    .insert(playbooksTable)
    .values({
      title,
      whenToUse,
      purpose: cleanText(input.purpose),
      ownerId: input.ownerId ?? null,
      steps,
      notes: cleanText(input.notes),
      state: input.state ?? "in_use",
      confidential: input.confidential ?? null,
      createdBy,
      suggestionId,
    })
    .returning({ id: playbooksTable.id });
  await setLinks(tx, "playbook", row.id, "project", input.projectIds ?? []);
  await setLinks(tx, "playbook", row.id, "organisation", input.organisationIds ?? []);
  await setLinks(tx, "playbook", row.id, "product", input.productIds ?? []);
  await setLinks(tx, "playbook", row.id, "document", input.documentIds ?? []);
  await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "playbook", entityId: row.id, payload: { title, steps: steps.length, suggestionId } });
  return row.id;
}

export async function createPlaybook(input: PlaybookInput): Promise<PlaybookView> {
  const id = await db.transaction((tx) => insertPlaybook(tx, input, ACTOR));
  return getPlaybook(id);
}

export interface PlaybookUpdate extends Partial<PlaybookInput> {
  /** Ollie checked it is still how things are done */
  checked?: boolean;
}

/** Applies an update inside the caller's transaction. Returns what changed, for the audit. */
export async function applyPlaybookUpdate(tx: DbOrTx, id: number, input: PlaybookUpdate, now = new Date()): Promise<Record<string, unknown>> {
  const current = await loadPlaybook(id, tx);
  const set: Partial<typeof playbooksTable.$inferInsert> = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title);
    if (!title) throw new ValidationError("A playbook needs a title");
    set.title = title;
  }
  if (input.whenToUse !== undefined) {
    const whenToUse = cleanText(input.whenToUse);
    if (!whenToUse) throw new ValidationError("Say when to use the playbook");
    set.whenToUse = whenToUse;
  }
  if (input.purpose !== undefined) set.purpose = cleanText(input.purpose);
  if (input.notes !== undefined) set.notes = cleanText(input.notes);
  if (input.ownerId !== undefined) set.ownerId = input.ownerId;
  if (input.state !== undefined) set.state = input.state;
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.steps !== undefined) set.steps = cleanSteps(input.steps);
  if (input.checked) set.lastCheckedAt = now;
  await Promise.all([assertPeople([set.ownerId, ...(set.steps ?? []).map((s) => s.personId)]), assertLinks(input)]);
  if (Object.keys(set).length) await tx.update(playbooksTable).set(set).where(eq(playbooksTable.id, id));
  const payload: Record<string, unknown> = { fields: Object.keys(set).filter((k) => k !== "lastCheckedAt") };
  if (input.projectIds) payload.projects = await setLinks(tx, "playbook", id, "project", input.projectIds);
  if (input.organisationIds) payload.organisations = await setLinks(tx, "playbook", id, "organisation", input.organisationIds);
  if (input.productIds) payload.products = await setLinks(tx, "playbook", id, "product", input.productIds);
  if (input.documentIds) payload.documents = await setLinks(tx, "playbook", id, "document", input.documentIds);
  if (set.state !== undefined && set.state !== current.state) payload.state = { from: current.state, to: set.state };
  if (set.confidential !== undefined && set.confidential !== current.confidential) payload.confidential = { from: current.confidential, to: set.confidential };
  if (input.checked) payload.checked = true;
  return payload;
}

export async function updatePlaybook(id: number, input: PlaybookUpdate): Promise<PlaybookView> {
  await db.transaction(async (tx) => {
    const payload = await applyPlaybookUpdate(tx, id, input);
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "playbook", entityId: id, payload });
  });
  return getPlaybook(id);
}

export async function deletePlaybook(id: number): Promise<void> {
  const current = await loadPlaybook(id);
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from links where (from_type = 'playbook' and from_id = ${id}) or (to_type = 'playbook' and to_id = ${id})`);
    await tx.delete(playbooksTable).where(eq(playbooksTable.id, id));
    await writeAudit(tx, { actor: ACTOR, action: "delete", entityType: "playbook", entityId: id, payload: { title: current.title } });
  });
}
