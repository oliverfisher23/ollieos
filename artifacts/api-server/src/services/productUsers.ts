/**
 * Primary users for products. Ollie asked (11th November 2026) for AI to suggest who each product is
 * mainly for, from his fixed list, using what OllieOS already knows: the product's own details and
 * facts, the documents linked to it, and documents, notes, sessions and decisions that mention it.
 * Haiku only reads what AI may see, and each answer becomes a "Changed details" card in the
 * Knowledge Inbox. Nothing changes until Ollie approves it.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, factsTable, productsTable, suggestionsTable } from "@workspace/db";
import { PRODUCT_USERS, PRODUCT_USER_LABELS, isProductUser, toRef, type ProductUser, type RefType } from "@workspace/shared";
import { productVisible } from "../lib/ai-data/visibility";
import { loadVisibleDocs } from "../lib/ai-data/retrieve";
import { defaultScope } from "../lib/ai-data/scope";
import { searchItems } from "../lib/ai-data/search";
import { logger } from "../lib/logger";
import { haikuJson } from "./connectors/sorter";
import { linkedIds } from "./knowledge/items";
import { propose, type ProposeMeta, type ProposeResult } from "./suggestions";

export const PRODUCT_USER_ACTOR = "Primary user check";

/** How much of what OllieOS knows goes to the model for one product */
const MAX_ITEMS = 24;
const MAX_CHARS = 40_000;

/** Sends a primary user for an existing product to the Knowledge Inbox, unless it already has that one. */
export async function proposeProductUser(meta: ProposeMeta, productId: number, user: ProductUser, reason: string | null): Promise<ProposeResult | { status: "unchanged" }> {
  const [row] = await db.select({ primaryUser: productsTable.primaryUser }).from(productsTable).where(eq(productsTable.id, productId));
  if (!row || row.primaryUser === user) return { status: "unchanged" };
  return propose(meta, {
    kind: "summary_change",
    entityType: "product",
    entityId: productId,
    payload: { fields: { primary_user: user }, before: { primary_user: row.primaryUser }, reason: reason?.trim().slice(0, 300) || null },
  });
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reasoning", "primary_user", "why"],
  properties: {
    reasoning: { type: "string" },
    primary_user: { type: "string", enum: [...PRODUCT_USERS, "unclear"] },
    why: { type: "string" },
  },
} as const;

function system(): string {
  const list = PRODUCT_USERS.map((u) => `"${u}" (${PRODUCT_USER_LABELS[u]})`).join(", ");
  return [
    "You help Ollie Fisher at Springpod record who each product is mainly for.",
    "You get one product in <product> and what his knowledge base says about it in <known>, each item with a ref.",
    `Pick the product's primary user: the one group it is mainly built for and used by. Choose from ${list}.`,
    "Students means young people themselves; Schools, Colleges and Universities mean the institutions and their staff; Employers means companies.",
    'The buyer is not always the user: a product an employer pays for so students can do it is for "students". Pick who mainly uses it.',
    '"reasoning" comes first: a line or two on what the known items say about who uses it. Then "primary_user". Use "unclear" when the items do not say, or only guess, or point equally at two groups. Never pick from the name alone.',
    '"why" is one short line in plain British English, under 160 characters, saying what in the items shows it, for example "The brief describes it as a programme students complete online." No em dashes.',
  ].join("\n");
}

/** What AI may see about a product: itself, its facts, its documents, and items that mention it. */
async function knownAbout(product: { id: number; name: string }): Promise<string> {
  const scope = defaultScope();
  const refs: string[] = [toRef("product", product.id)];
  const facts = await db
    .select({ id: factsTable.id })
    .from(factsTable)
    .where(and(eq(factsTable.entityType, "product"), eq(factsTable.entityId, product.id), isNull(factsTable.supersededBy)));
  refs.push(...facts.map((f) => toRef("fact", f.id)));
  refs.push(...(await linkedIds("product", product.id, "document")).map((id) => toRef("document", id)));
  const hits = await searchItems({ q: product.name, types: ["document", "fact", "note", "session", "decision"], mode: "user", visibleOnly: true, scope, limitPerType: 6 });
  refs.push(...hits.sort((a, b) => b.rank - a.rank).map((h) => toRef(h.type as RefType, h.id)));
  const docs = await loadVisibleDocs(scope, [...new Set(refs)].slice(0, MAX_ITEMS));
  let out = "";
  for (const d of docs) {
    if (out.length + d.text.length > MAX_CHARS) break;
    out += d.text + "\n\n";
  }
  return out.trim();
}

export interface SuggestProductUsersResult {
  checked: number;
  suggested: number;
  unclear: number;
}

/**
 * Asks Haiku for the primary user of every product AI may see that has none and no card already
 * waiting for one. Runs three products at a time.
 */
export async function suggestProductUsers(): Promise<SuggestProductUsersResult> {
  const products = await db
    .select({ id: productsTable.id, name: productsTable.name, description: productsTable.description })
    .from(productsTable)
    .where(
      and(
        isNull(productsTable.primaryUser),
        sql`${sql.raw(productVisible("products"))}`,
        sql`not exists (select 1 from ${suggestionsTable} s where s.kind = 'summary_change' and s.status = 'pending' and s.entity_type = 'product'
          and s.entity_id = ${productsTable.id} and s.payload->'fields' ? 'primary_user')`,
      ),
    );
  const result: SuggestProductUsersResult = { checked: products.length, suggested: 0, unclear: 0 };
  const meta: ProposeMeta = { proposedBy: PRODUCT_USER_ACTOR, clientId: null, sourceType: "documents", sourceLabel: "What OllieOS knows about the product" };
  const queue = [...products];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const known = await knownAbout(p);
        if (!known) {
          result.unclear++;
          continue;
        }
        const content = [`<product>`, `${p.name}${p.description ? `: ${p.description}` : ""}`, `</product>`, `<known>`, known, `</known>`].join("\n");
        const r = await haikuJson<{ primary_user?: string; why?: string }>(system(), content, SCHEMA, 1024);
        if (!isProductUser(r.primary_user)) {
          result.unclear++;
          continue;
        }
        const why = (r.why ?? "").replace(/\s*—\s*/g, ", ").trim();
        const out = await proposeProductUser(meta, p.id, r.primary_user, why);
        if (out.status === "suggested") result.suggested++;
      } catch (err) {
        logger.error({ err, product: p.id }, "Primary user check failed");
        result.unclear++;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return result;
}
