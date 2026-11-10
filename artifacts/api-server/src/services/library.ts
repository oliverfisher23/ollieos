/**
 * Library: the document index (feature 06) and rules (feature 07; called playbooks before Part M).
 * Documents are links with a summary, or text kept in OllieOS (pasted, uploaded or saved by Claude).
 * Rules are short rules every AI tool reads before drafting; Ollie writes them, AI only proposes.
 * Both link to projects (and rules to organisations and products) through `links`, stored from the item.
 * Playbooks (Part M) are in playbooks.ts and use the link helpers here.
 */
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  documentContentsTable,
  documentsTable,
  knowledgeSourcesTable,
  linksTable,
  organisationsTable,
  productsTable,
  rulesTable,
  projectsTable,
  type Document,
  type Rule,
} from "@workspace/db";
import { RULE_MAX, type DocLocation } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { documentVisible, ruleVisible } from "../lib/ai-data/visibility";
import { ACTOR, cleanText } from "./knowledge/common";
import { ConflictError, NotFoundError, ValidationError } from "./tasks";
import { ensureSeeds } from "./seeds";
import { enqueueDocument } from "./documents/enqueue";
import { describeCounts } from "./documents/counts";

export type ItemType = "document" | "rule" | "playbook";
export type TargetType = "project" | "organisation" | "product";

export interface NamedLink {
  id: number;
  name: string;
  slug: string;
}

/* ---------- Links ---------- */

/** Ids of `other` linked to each item, either way round. */
export async function linkMap(type: ItemType, ids: number[], other: TargetType | "document"): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!ids.length) return out;
  const rows = await db
    .select()
    .from(linksTable)
    .where(
      or(
        and(eq(linksTable.fromType, type), inArray(linksTable.fromId, ids), eq(linksTable.toType, other)),
        and(eq(linksTable.toType, type), inArray(linksTable.toId, ids), eq(linksTable.fromType, other)),
      ),
    );
  for (const r of rows) {
    const [item, target] = r.fromType === type ? [r.fromId, r.toId] : [r.toId, r.fromId];
    if (!out.has(item)) out.set(item, []);
    if (!out.get(item)!.includes(target)) out.get(item)!.push(target);
  }
  return out;
}

const TARGET_TABLES = { project: projectsTable, organisation: organisationsTable, product: productsTable } as const;

export async function names(other: TargetType, ids: number[]): Promise<Map<number, NamedLink>> {
  if (!ids.length) return new Map();
  const table = TARGET_TABLES[other];
  const rows = await db.select({ id: table.id, name: table.name, slug: table.slug }).from(table).where(inArray(table.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

export async function assertTargets(other: TargetType, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const found = await names(other, ids);
  if (found.size !== new Set(ids).size) throw new NotFoundError(`That ${other} does not exist`);
}

/** Sorted names for the ids an item links to. */
export function pickNames(m: Map<number, NamedLink>, xs: number[] | undefined): NamedLink[] {
  return (xs ?? [])
    .map((x) => m.get(x))
    .filter((x): x is NamedLink => !!x)
    .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
}

/** Replaces the item's links to one kind of target. Returns what was added and removed, for the audit. */
export async function setLinks(tx: DbOrTx, type: ItemType, id: number, other: TargetType | "document", ids: number[]) {
  const wanted = [...new Set(ids)];
  const existing = await tx
    .select()
    .from(linksTable)
    .where(
      or(
        and(eq(linksTable.fromType, type), eq(linksTable.fromId, id), eq(linksTable.toType, other)),
        and(eq(linksTable.toType, type), eq(linksTable.toId, id), eq(linksTable.fromType, other)),
      ),
    );
  const have = existing.map((r) => (r.fromType === type ? r.toId : r.fromId));
  const removed = have.filter((x) => !wanted.includes(x));
  const added = wanted.filter((x) => !have.includes(x));
  for (const x of removed) {
    await tx
      .delete(linksTable)
      .where(
        or(
          and(eq(linksTable.fromType, type), eq(linksTable.fromId, id), eq(linksTable.toType, other), eq(linksTable.toId, x)),
          and(eq(linksTable.toType, type), eq(linksTable.toId, id), eq(linksTable.fromType, other), eq(linksTable.fromId, x)),
        ),
      );
  }
  if (added.length) {
    await tx.insert(linksTable).values(added.map((x) => ({ fromType: type, fromId: id, toType: other, toId: x, createdBy: ACTOR }))).onConflictDoNothing();
  }
  return { added, removed };
}

/* ---------- Documents ---------- */

/** Where a link lives, from its host. */
export function locationOf(url: URL): DocLocation {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "dropbox.com" || host.endsWith(".dropbox.com") || host === "db.tt" || host.endsWith("dropboxusercontent.com")) return "dropbox";
  if (host === "drive.google.com" || host === "docs.google.com") return "gdrive";
  if (host === "claude.ai" && url.pathname.startsWith("/project")) return "claude_project";
  return "other";
}

const GOOGLE_KINDS: Record<string, string> = {
  document: "Google Doc",
  spreadsheets: "Google Sheet",
  presentation: "Google Slides",
  forms: "Google Form",
};

/**
 * A title from the link alone, since OllieOS cannot open private files (question 44): the file name
 * in the URL without its extension, or the kind of Google file. Ollie can edit it.
 */
export function titleFromUrl(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "docs.google.com") {
    const kind = url.pathname.split("/").filter(Boolean)[0] ?? "";
    return GOOGLE_KINDS[kind] ?? "Google Drive file";
  }
  if (host === "claude.ai") return "Claude project";
  const segments = url.pathname.split("/").filter(Boolean);
  const named = [...segments].reverse().find((s) => /[a-z]/i.test(s) && /\.[a-z0-9]{2,5}$/i.test(s)) ?? null;
  let base = named;
  if (!base && host === "drive.google.com") return "Google Drive file";
  base ??= segments.at(-1) ?? null;
  if (!base) return host;
  let text = base;
  try {
    text = decodeURIComponent(base);
  } catch {
    // keep the raw segment
  }
  text = text.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[+_]+/g, " ").replace(/\s+/g, " ").trim();
  return text || host;
}

export function parseLink(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError("That does not look like a link");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ValidationError("Paste a web link starting with https://");
  return url;
}

export type TextOrigin = "gdrive" | "dropbox" | "pasted" | "upload" | "claude" | "email";

export interface KnowledgeView {
  status: "idle" | "queued" | "reading" | "failed";
  lastReadAt: Date | null;
  /** What the last read proposed, in words */
  lastResult: string | null;
  error: string | null;
}

export interface DocumentView extends Omit<Document, "search" | "suggestionId"> {
  projects: NamedLink[];
  /** Products it is linked to (Part M) */
  products: NamedLink[];
  /** AI tools cannot read it (own flag or inherited from a project) */
  hiddenFromAi: boolean;
  /** When OllieOS last read or was given the text */
  contentsReadAt: Date | null;
  /** Where the kept text came from, or null when OllieOS has none */
  textOrigin: TextOrigin | null;
  /** The knowledge step for this document, or null when it was never asked for */
  knowledge: KnowledgeView | null;
}

async function toDocumentViews(rows: Omit<Document, "search">[]): Promise<DocumentView[]> {
  const ids = rows.map((r) => r.id);
  const [links, productLinks, hidden, contents, reads] = await Promise.all([
    linkMap("document", ids, "project"),
    linkMap("document", ids, "product"),
    ids.length
      ? db.select({ id: documentsTable.id }).from(documentsTable).where(and(inArray(documentsTable.id, ids), sql.raw(`not ${documentVisible("documents")}`)))
      : [],
    ids.length
      ? db
          .select({ id: documentContentsTable.documentId, readAt: documentContentsTable.readAt, origin: documentContentsTable.origin })
          .from(documentContentsTable)
          .where(inArray(documentContentsTable.documentId, ids))
      : [],
    ids.length ? db.select().from(knowledgeSourcesTable).where(inArray(knowledgeSourcesTable.documentId, ids)) : [],
  ]);
  const readAt = new Map(contents.map((c) => [c.id, c]));
  const knowledge = new Map(
    reads.map((k) => [
      k.documentId!,
      { status: k.status, lastReadAt: k.lastReadAt, lastResult: k.lastCounts ? describeCounts(k.lastCounts) : null, error: k.status === "failed" ? k.lastError : null } satisfies KnowledgeView,
    ]),
  );
  const [projectNames, productNames] = await Promise.all([
    names("project", [...new Set([...links.values()].flat())]),
    names("product", [...new Set([...productLinks.values()].flat())]),
  ]);
  const hiddenSet = new Set(hidden.map((h) => h.id));
  return rows.map(({ suggestionId: _s, ...r }) => ({
    ...r,
    projects: pickNames(projectNames, links.get(r.id)),
    products: pickNames(productNames, productLinks.get(r.id)),
    hiddenFromAi: hiddenSet.has(r.id),
    contentsReadAt: readAt.get(r.id)?.readAt ?? null,
    textOrigin: readAt.get(r.id)?.origin ?? null,
    knowledge: knowledge.get(r.id) ?? null,
  }));
}

const documentColumns = {
  id: documentsTable.id,
  title: documentsTable.title,
  url: documentsTable.url,
  location: documentsTable.location,
  summary: documentsTable.summary,
  confidential: documentsTable.confidential,
  lastConfirmedAt: documentsTable.lastConfirmedAt,
  createdBy: documentsTable.createdBy,
  suggestionId: documentsTable.suggestionId,
  createdAt: documentsTable.createdAt,
};

export async function listDocuments(projectId?: number): Promise<DocumentView[]> {
  let where;
  if (projectId != null) {
    const linked = await db.execute(sql`
      select to_id as id from links where to_type = 'document' and from_type = 'project' and from_id = ${projectId}
      union select from_id from links where from_type = 'document' and to_type = 'project' and to_id = ${projectId}`);
    const ids = (linked.rows as { id: number }[]).map((r) => Number(r.id));
    if (!ids.length) return [];
    where = inArray(documentsTable.id, ids);
  }
  const rows = await db.select(documentColumns).from(documentsTable).where(where).orderBy(desc(documentsTable.lastConfirmedAt), asc(documentsTable.title));
  return toDocumentViews(rows);
}

/** Documents linked to a product (Part M). */
export async function documentsForProduct(productId: number): Promise<DocumentView[]> {
  const ids = await linkMapTo("product", productId, "document");
  if (!ids.length) return [];
  const rows = await db.select(documentColumns).from(documentsTable).where(inArray(documentsTable.id, ids)).orderBy(asc(documentsTable.title));
  return toDocumentViews(rows);
}

export async function loadDocument(id: number) {
  const [row] = await db.select(documentColumns).from(documentsTable).where(eq(documentsTable.id, id));
  if (!row) throw new NotFoundError("That document does not exist");
  return row;
}

export interface DocumentInput {
  /** Null for text kept in OllieOS */
  url?: string | null;
  title?: string | null;
  summary?: string | null;
  location?: DocLocation;
  confidential?: boolean | null;
  projectIds?: number[];
}

/**
 * Inserts a document inside the caller's transaction, filling the title and location from the link
 * when not given. Used directly when approving a suggestion.
 */
export async function insertDocument(tx: DbOrTx, input: DocumentInput, createdBy: string, suggestionId: number | null = null): Promise<number> {
  const url = input.url ? parseLink(input.url) : null;
  const href = url?.toString() ?? null;
  const projectIds = input.projectIds ?? [];
  await assertTargets("project", projectIds);
  if (href) {
    const [taken] = await tx.select({ id: documentsTable.id, title: documentsTable.title }).from(documentsTable).where(eq(documentsTable.url, href));
    if (taken) throw new ConflictError(`That link is already in the Library as "${taken.title}"`);
  }
  const title = cleanText(input.title) ?? (url ? titleFromUrl(url) : null);
  if (!title) throw new ValidationError("A document needs a title");
  const [row] = await tx
    .insert(documentsTable)
    .values({
      title,
      url: href,
      location: url ? (input.location ?? locationOf(url)) : "ollieos",
      summary: cleanText(input.summary),
      confidential: input.confidential ?? null,
      createdBy,
      suggestionId,
    })
    .returning({ id: documentsTable.id });
  await setLinks(tx, "document", row.id, "project", projectIds);
  await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "document", entityId: row.id, payload: { projects: projectIds, suggestionId } });
  return row.id;
}

/** Adds a document from a pasted link. */
export async function createDocument(input: DocumentInput): Promise<DocumentView> {
  if (!input.url) throw new ValidationError("Paste a link, or paste the text instead");
  const id = await db.transaction((tx) => insertDocument(tx, input, ACTOR));
  return documentView(id);
}

export async function documentView(id: number): Promise<DocumentView> {
  return (await toDocumentViews([await loadDocument(id)]))[0];
}

/** Longest text kept for one document */
export const KEPT_TEXT_CHARS = 200_000;

/** Keeps a document's text, replacing what was kept before. */
export async function keepDocumentText(
  conn: DbOrTx,
  documentId: number,
  text: string,
  origin: TextOrigin,
  opts: { fileId?: string | null; originName?: string | null; fileModifiedAt?: Date | null; now?: Date } = {},
): Promise<void> {
  const kept = text.slice(0, KEPT_TEXT_CHARS);
  const values = {
    fileId: opts.fileId ?? null,
    origin,
    originName: opts.originName ?? null,
    text: kept,
    truncated: text.length > KEPT_TEXT_CHARS,
    fileModifiedAt: opts.fileModifiedAt ?? null,
    readAt: opts.now ?? new Date(),
  };
  await conn
    .insert(documentContentsTable)
    .values({ documentId, ...values })
    .onConflictDoUpdate({ target: documentContentsTable.documentId, set: values });
}

export interface TextDocumentInput {
  title: string;
  text: string;
  summary?: string | null;
  confidential?: boolean | null;
  projectIds?: number[];
  origin: "pasted" | "upload";
  /** The uploaded file's name */
  fileName?: string | null;
  /** Read it for knowledge straight away */
  buildKnowledge?: boolean;
}

/** Adds a document whose text is kept in OllieOS: pasted, or read from an uploaded file. */
export async function createTextDocument(input: TextDocumentInput): Promise<DocumentView> {
  const text = input.text.trim();
  if (!text) throw new ValidationError("There is no text to keep");
  const id = await db.transaction(async (tx) => {
    const id = await insertDocument(tx, { title: input.title, summary: input.summary, confidential: input.confidential, projectIds: input.projectIds }, ACTOR);
    await keepDocumentText(tx, id, text, input.origin, { originName: input.fileName ?? null });
    if (input.buildKnowledge) {
      const [d] = await tx.select({ title: documentsTable.title }).from(documentsTable).where(eq(documentsTable.id, id));
      await enqueueDocument(tx, { id, title: d.title, url: null });
    }
    return id;
  });
  return documentView(id);
}

/** Adds project links without removing any, for an approved link suggestion. */
export async function addDocumentProjects(tx: DbOrTx, id: number, projectIds: number[]): Promise<void> {
  await assertTargets("project", projectIds);
  const [doc] = await tx.select({ id: documentsTable.id }).from(documentsTable).where(eq(documentsTable.id, id));
  if (!doc) throw new NotFoundError("That document is no longer in the Library");
  const have = (await linkMap("document", [id], "project")).get(id) ?? [];
  const added = projectIds.filter((p) => !have.includes(p));
  if (added.length) await setLinks(tx, "document", id, "project", [...have, ...added]);
  await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "document", entityId: id, payload: { projects: { added, removed: [] } } });
}

export interface DocumentUpdate {
  title?: string;
  summary?: string | null;
  location?: DocLocation;
  url?: string;
  confidential?: boolean | null;
  projectIds?: number[];
  /** Ollie checked it is still current: moves "Updated" to now */
  confirm?: boolean;
}

export async function updateDocument(id: number, input: DocumentUpdate): Promise<DocumentView> {
  const current = await loadDocument(id);
  const set: Partial<Document> = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title);
    if (!title) throw new ValidationError("A document needs a title");
    set.title = title;
  }
  if (input.url !== undefined) {
    if (current.url == null) throw new ValidationError("This document's text is kept in OllieOS, so it has no link to change");
    const href = parseLink(input.url).toString();
    if (href !== current.url) {
      const [taken] = await db.select({ id: documentsTable.id }).from(documentsTable).where(eq(documentsTable.url, href));
      if (taken) throw new ConflictError("That link is already in the Library");
      set.url = href;
    }
  }
  if (input.summary !== undefined) set.summary = cleanText(input.summary);
  if (input.location !== undefined) set.location = input.location;
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.confirm || set.title !== undefined || set.summary !== undefined || set.url !== undefined) set.lastConfirmedAt = new Date();
  if (input.projectIds) await assertTargets("project", input.projectIds);
  await db.transaction(async (tx) => {
    if (Object.keys(set).length) await tx.update(documentsTable).set(set).where(eq(documentsTable.id, id));
    const links = input.projectIds ? await setLinks(tx, "document", id, "project", input.projectIds) : null;
    const payload: Record<string, unknown> = { fields: Object.keys(set).filter((k) => k !== "lastConfirmedAt") };
    if (links && (links.added.length || links.removed.length)) payload.projects = links;
    if (set.confidential !== undefined && set.confidential !== current.confidential) payload.confidential = { from: current.confidential, to: set.confidential };
    if (input.confirm) payload.confirmed = true;
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "document", entityId: id, payload });
  });
  return documentView(id);
}

/* ---------- Rules ---------- */

export interface RuleView extends Omit<Rule, "suggestionId"> {
  projects: NamedLink[];
  organisations: NamedLink[];
  products: NamedLink[];
  /** True when AI tools receive it: enabled, and global or linked to something visible */
  sentToAi: boolean;
}

async function toRuleViews(rows: Rule[]): Promise<RuleView[]> {
  const ids = rows.map((r) => r.id);
  const [projectLinks, orgLinks, productLinks, visible] = await Promise.all([
    linkMap("rule", ids, "project"),
    linkMap("rule", ids, "organisation"),
    linkMap("rule", ids, "product"),
    ids.length ? db.select({ id: rulesTable.id }).from(rulesTable).where(and(inArray(rulesTable.id, ids), sql.raw(ruleVisible("rules")))) : [],
  ]);
  const all = (m: Map<number, number[]>) => [...new Set([...m.values()].flat())];
  const [projectNames, orgNames, productNames] = await Promise.all([
    names("project", all(projectLinks)),
    names("organisation", all(orgLinks)),
    names("product", all(productLinks)),
  ]);
  const visibleSet = new Set(visible.map((v) => v.id));
  return rows.map(({ suggestionId: _s, ...r }) => ({
    ...r,
    projects: pickNames(projectNames, projectLinks.get(r.id)),
    organisations: pickNames(orgNames, orgLinks.get(r.id)),
    products: pickNames(productNames, productLinks.get(r.id)),
    sentToAi: visibleSet.has(r.id),
  }));
}

export async function listRules(): Promise<RuleView[]> {
  await ensureSeeds();
  const rows = await db.select().from(rulesTable).orderBy(asc(rulesTable.id));
  return toRuleViews(rows);
}

/**
 * Rules shown on a project page: global ones and those linked to the project or to an
 * organisation or product linked to it. Paused ones are included and marked.
 */
export async function rulesForProject(projectId: number): Promise<RuleView[]> {
  const res = await db.execute(sql`
    select pb.id from rules pb
    where not exists (select 1 from links l where (l.from_type = 'rule' and l.from_id = pb.id and l.to_type in ('project', 'organisation', 'product'))
                                              or (l.to_type = 'rule' and l.to_id = pb.id and l.from_type in ('project', 'organisation', 'product')))
      or exists (select 1 from links l where (l.from_type = 'rule' and l.from_id = pb.id and l.to_type = 'project' and l.to_id = ${projectId})
                                          or (l.to_type = 'rule' and l.to_id = pb.id and l.from_type = 'project' and l.from_id = ${projectId}))
      or exists (select 1 from links l, links po where
                   ((l.from_type = 'rule' and l.from_id = pb.id and l.to_type in ('organisation', 'product')) or (l.to_type = 'rule' and l.to_id = pb.id and l.from_type in ('organisation', 'product')))
                   and ((po.from_type = 'project' and po.from_id = ${projectId}
                         and po.to_type = case when l.from_type = 'rule' then l.to_type else l.from_type end
                         and po.to_id = case when l.from_type = 'rule' then l.to_id else l.from_id end)
                     or (po.to_type = 'project' and po.to_id = ${projectId}
                         and po.from_type = case when l.from_type = 'rule' then l.to_type else l.from_type end
                         and po.from_id = case when l.from_type = 'rule' then l.to_id else l.from_id end)))`);
  const ids = (res.rows as { id: number }[]).map((r) => Number(r.id));
  if (!ids.length) return [];
  const rows = await db.select().from(rulesTable).where(inArray(rulesTable.id, ids)).orderBy(asc(rulesTable.id));
  return toRuleViews(rows);
}

/** Rules linked to a product: "What to say and not say" on its page. Paused ones are included and marked. */
export async function rulesForProduct(productId: number): Promise<RuleView[]> {
  const ids = await linkMapTo("product", productId, "rule");
  if (!ids.length) return [];
  const rows = await db.select().from(rulesTable).where(inArray(rulesTable.id, ids)).orderBy(asc(rulesTable.id));
  return toRuleViews(rows);
}

/** Ids of one kind linked to a single target, either way round. */
export async function linkMapTo(target: TargetType | "document", targetId: number, type: ItemType): Promise<number[]> {
  const rows = await db
    .select()
    .from(linksTable)
    .where(
      or(
        and(eq(linksTable.fromType, type), eq(linksTable.toType, target), eq(linksTable.toId, targetId)),
        and(eq(linksTable.toType, type), eq(linksTable.fromType, target), eq(linksTable.fromId, targetId)),
      ),
    );
  return [...new Set(rows.map((r) => (r.fromType === type ? r.fromId : r.toId)))];
}

async function loadRule(id: number): Promise<Rule> {
  const [row] = await db.select().from(rulesTable).where(eq(rulesTable.id, id));
  if (!row) throw new NotFoundError("That rule does not exist");
  return row;
}

export interface RuleInput {
  title: string;
  appliesWhen: string;
  rule: string;
  enabled?: boolean;
  projectIds?: number[];
  organisationIds?: number[];
  productIds?: number[];
}

function checkRule(rule: string): string {
  const r = cleanText(rule);
  if (!r) throw new ValidationError("Write the rule itself");
  if (r.length > RULE_MAX) throw new ValidationError(`Keep the rule to ${RULE_MAX} characters or fewer`);
  return r;
}

/** Inserts a rule inside the caller's transaction. Used directly when approving a suggestion. */
export async function insertRule(tx: DbOrTx, input: RuleInput, suggestionId: number | null = null): Promise<number> {
  const title = cleanText(input.title);
  if (!title) throw new ValidationError("A rule needs a title");
  const appliesWhen = cleanText(input.appliesWhen);
  if (!appliesWhen) throw new ValidationError("Say when the rule applies");
  const rule = checkRule(input.rule);
  const projectIds = input.projectIds ?? [];
  const organisationIds = input.organisationIds ?? [];
  const productIds = input.productIds ?? [];
  await Promise.all([assertTargets("project", projectIds), assertTargets("organisation", organisationIds), assertTargets("product", productIds)]);
  const [row] = await tx
    .insert(rulesTable)
    .values({ title, appliesWhen, rule, enabled: input.enabled ?? true, createdBy: ACTOR, suggestionId })
    .returning({ id: rulesTable.id });
  await setLinks(tx, "rule", row.id, "project", projectIds);
  await setLinks(tx, "rule", row.id, "organisation", organisationIds);
  await setLinks(tx, "rule", row.id, "product", productIds);
  await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "rule", entityId: row.id, payload: { title, suggestionId } });
  return row.id;
}

export async function createRule(input: RuleInput): Promise<RuleView> {
  const id = await db.transaction((tx) => insertRule(tx, input));
  return (await toRuleViews([await loadRule(id)]))[0];
}

export async function updateRule(id: number, input: Partial<RuleInput>): Promise<RuleView> {
  const current = await loadRule(id);
  const set: Partial<Rule> = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title);
    if (!title) throw new ValidationError("A rule needs a title");
    set.title = title;
  }
  if (input.appliesWhen !== undefined) {
    const appliesWhen = cleanText(input.appliesWhen);
    if (!appliesWhen) throw new ValidationError("Say when the rule applies");
    set.appliesWhen = appliesWhen;
  }
  if (input.rule !== undefined) set.rule = checkRule(input.rule);
  if (input.enabled !== undefined) set.enabled = input.enabled;
  await Promise.all([
    assertTargets("project", input.projectIds ?? []),
    assertTargets("organisation", input.organisationIds ?? []),
    assertTargets("product", input.productIds ?? []),
  ]);
  await db.transaction(async (tx) => {
    if (Object.keys(set).length) await tx.update(rulesTable).set(set).where(eq(rulesTable.id, id));
    const payload: Record<string, unknown> = { fields: Object.keys(set) };
    if (input.projectIds) payload.projects = await setLinks(tx, "rule", id, "project", input.projectIds);
    if (input.organisationIds) payload.organisations = await setLinks(tx, "rule", id, "organisation", input.organisationIds);
    if (input.productIds) payload.products = await setLinks(tx, "rule", id, "product", input.productIds);
    if (set.enabled !== undefined && set.enabled !== current.enabled) payload.enabled = { from: current.enabled, to: set.enabled };
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "rule", entityId: id, payload });
  });
  return (await toRuleViews([await loadRule(id)]))[0];
}
