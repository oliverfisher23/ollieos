/**
 * Products (Part M): a Knowledge section next to projects, people and organisations. Ollie adds
 * them; AI only proposes a product or a fact about one. A product carries facts, rules ("What to
 * say and not say"), and links to documents, projects, organisations, playbooks and decisions.
 * Hidden from AI when confidential or AI access is off, which hides its facts too.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";
import { db, decisionsTable, organisationsTable, peopleTable, productsTable, projectsTable, type Product } from "@workspace/db";
import type { ProductState, ProductUser } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { productVisible } from "../lib/ai-data/visibility";
import { ACTOR, cleanText, uniqueSlug, type EntitySummary } from "./knowledge/common";
import { factsFor, linkedIds, notesFor, toDecisionViews, type DecisionView, type FactView, type NoteView } from "./knowledge/items";
import { documentsForProduct, rulesForProduct, type DocumentView, type NamedLink, type RuleView } from "./library";
import { playbooksFor, type PlaybookView } from "./playbooks";
import { NotFoundError, ValidationError } from "./tasks";

export type ProductView = Omit<Product, "search" | "suggestionId"> & { owner: NamedLink | null };

export interface ProductListItem extends EntitySummary {
  description: string | null;
  state: ProductState;
  primaryUser: ProductUser | null;
  aiAccess: boolean;
  ownerName: string | null;
  factCount: number;
  updatedAt: Date;
}

export interface LinkedSummary extends EntitySummary {
  linked: boolean;
}

export interface ProductDetail {
  product: ProductView;
  facts: FactView[];
  rules: RuleView[];
  documents: DocumentView[];
  projects: LinkedSummary[];
  organisations: LinkedSummary[];
  playbooks: PlaybookView[];
  decisions: DecisionView[];
  notes: NoteView[];
  /** Hidden from AI tools by its own switches */
  hiddenFromAi: boolean;
}

const STATE_ORDER = sql`case ${productsTable.state} when 'live' then 0 when 'pilot' then 1 when 'in_development' then 2 else 3 end`;

export async function listProducts(): Promise<ProductListItem[]> {
  const rows = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      slug: productsTable.slug,
      description: productsTable.description,
      state: productsTable.state,
      primaryUser: productsTable.primaryUser,
      confidential: productsTable.confidential,
      aiAccess: productsTable.aiAccess,
      ownerName: peopleTable.name,
      updatedAt: productsTable.updatedAt,
      factCount: sql<number>`(select count(*)::int from facts f where f.entity_type = 'product' and f.entity_id = ${productsTable.id} and f.superseded_by is null)`,
    })
    .from(productsTable)
    .leftJoin(peopleTable, eq(peopleTable.id, productsTable.ownerId))
    .orderBy(STATE_ORDER, asc(productsTable.name));
  return rows.map((r) => ({ ...r, factCount: Number(r.factCount) }));
}

async function loadProduct(slug: string): Promise<Product> {
  const [row] = await db.select().from(productsTable).where(eq(productsTable.slug, slug));
  if (!row) throw new NotFoundError("That product does not exist");
  return row;
}

async function toView(row: Product): Promise<ProductView> {
  const { search: _s, suggestionId: _g, ...rest } = row;
  let owner: NamedLink | null = null;
  if (row.ownerId) {
    const [p] = await db.select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug }).from(peopleTable).where(eq(peopleTable.id, row.ownerId));
    owner = p ?? null;
  }
  return { ...rest, owner };
}

async function summaries(table: typeof projectsTable | typeof organisationsTable, ids: number[]): Promise<LinkedSummary[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: table.id, name: table.name, slug: table.slug, confidential: table.confidential })
    .from(table)
    .where(inArray(table.id, ids))
    .orderBy(asc(table.name));
  return rows.map((r) => ({ ...r, linked: true }));
}

export async function getProduct(slug: string): Promise<ProductDetail> {
  const row = await loadProduct(slug);
  const id = row.id;
  const [product, facts, rules, documents, projectIds, orgIds, decisionIds, playbooks, notes] = await Promise.all([
    toView(row),
    factsFor("product", id),
    rulesForProduct(id),
    documentsForProduct(id),
    linkedIds("product", id, "project"),
    linkedIds("product", id, "organisation"),
    linkedIds("product", id, "decision"),
    playbooksFor("product", id),
    notesFor("product", id),
  ]);
  const [projects, organisations, decisionRows] = await Promise.all([
    summaries(projectsTable, projectIds),
    summaries(organisationsTable, orgIds),
    decisionIds.length ? db.select().from(decisionsTable).where(inArray(decisionsTable.id, decisionIds)) : [],
  ]);
  const decisions = (await toDecisionViews(decisionRows)).sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
  const [vis] = await db.select({ ok: sql<boolean>`${sql.raw(productVisible("products"))}` }).from(productsTable).where(eq(productsTable.id, id));
  return { product, facts, rules, documents, projects, organisations, playbooks, decisions, notes, hiddenFromAi: !vis?.ok };
}

/** Products linked to a project or organisation, for its page and for briefs. */
export async function productsLinkedTo(type: "project" | "organisation", id: number): Promise<LinkedSummary[]> {
  const ids = await linkedIds(type, id, "product");
  if (!ids.length) return [];
  const rows = await db
    .select({ id: productsTable.id, name: productsTable.name, slug: productsTable.slug, confidential: productsTable.confidential })
    .from(productsTable)
    .where(inArray(productsTable.id, ids))
    .orderBy(asc(productsTable.name));
  return rows.map((r) => ({ ...r, linked: true }));
}

export interface ProductInput {
  name: string;
  description?: string | null;
  state?: ProductState;
  primaryUser?: ProductUser | null;
  ownerId?: number | null;
  summary?: string | null;
  confidential?: boolean;
  aiAccess?: boolean;
}

async function assertOwner(id: number | null | undefined): Promise<void> {
  if (id == null) return;
  const [p] = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.id, id));
  if (!p) throw new NotFoundError("That person does not exist");
}

/** Inserts a product inside the caller's transaction. Used directly when approving a suggestion. */
export async function insertProduct(tx: DbOrTx, input: ProductInput, createdBy: string, suggestionId: number | null = null): Promise<number> {
  const name = cleanText(input.name);
  if (!name) throw new ValidationError("A product needs a name");
  await assertOwner(input.ownerId);
  const slug = await uniqueSlug(tx, "product", name);
  const [row] = await tx
    .insert(productsTable)
    .values({
      name,
      slug,
      description: cleanText(input.description),
      state: input.state ?? "live",
      primaryUser: input.primaryUser ?? null,
      ownerId: input.ownerId ?? null,
      summary: cleanText(input.summary),
      confidential: input.confidential ?? false,
      aiAccess: input.aiAccess ?? true,
      createdBy,
      suggestionId,
    })
    .returning({ id: productsTable.id });
  await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "product", entityId: row.id, payload: { name, suggestionId } });
  return row.id;
}

export async function createProduct(input: ProductInput): Promise<ProductView> {
  const id = await db.transaction((tx) => insertProduct(tx, input, ACTOR));
  const [row] = await db.select().from(productsTable).where(eq(productsTable.id, id));
  return toView(row);
}

export async function updateProduct(slug: string, input: Partial<ProductInput>): Promise<ProductView> {
  const current = await loadProduct(slug);
  const set: Partial<typeof productsTable.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) throw new ValidationError("A product needs a name");
    set.name = name;
  }
  if (input.description !== undefined) set.description = cleanText(input.description);
  if (input.state !== undefined) set.state = input.state;
  if (input.primaryUser !== undefined) set.primaryUser = input.primaryUser;
  if (input.ownerId !== undefined) {
    await assertOwner(input.ownerId);
    set.ownerId = input.ownerId;
  }
  if (input.summary !== undefined) set.summary = cleanText(input.summary);
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.aiAccess !== undefined) set.aiAccess = input.aiAccess;
  if (!Object.keys(set).length) return toView(current);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(productsTable).set(set).where(eq(productsTable.id, current.id)).returning();
    const payload: Record<string, unknown> = { fields: Object.keys(set) };
    if (set.confidential !== undefined && set.confidential !== current.confidential) payload.confidential = { from: current.confidential, to: set.confidential };
    if (set.aiAccess !== undefined && set.aiAccess !== current.aiAccess) payload.aiAccess = { from: current.aiAccess, to: set.aiAccess };
    if (set.state !== undefined && set.state !== current.state) payload.state = { from: current.state, to: set.state };
    if (set.primaryUser !== undefined && set.primaryUser !== current.primaryUser) payload.primaryUser = { from: current.primaryUser, to: set.primaryUser };
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "product", entityId: current.id, payload });
    return updated;
  });
  return toView(row);
}
