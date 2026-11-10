/**
 * Library: the document index (feature 06) and playbooks (feature 07).
 * Documents are links with a summary; OllieOS never stores or opens the file.
 * Playbooks are short rules every AI tool reads before drafting; Ollie writes them, AI only proposes.
 * Both link to projects (and playbooks to organisations) through `links`, stored from the item.
 */
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  db,
  documentContentsTable,
  documentsTable,
  linksTable,
  organisationsTable,
  playbooksTable,
  projectsTable,
  type Document,
  type Playbook,
} from "@workspace/db";
import { PLAYBOOK_RULE_MAX, type DocLocation } from "@workspace/shared";
import { writeAudit, type DbOrTx } from "../lib/audit";
import { documentVisible, playbookVisible } from "../lib/ai-data/visibility";
import { ACTOR, cleanText } from "./knowledge/common";
import { ConflictError, NotFoundError, ValidationError } from "./tasks";
import { ensureSeeds } from "./seeds";

type ItemType = "document" | "playbook";
type TargetType = "project" | "organisation";

export interface NamedLink {
  id: number;
  name: string;
  slug: string;
}

/* ---------- Links ---------- */

/** Ids of `other` linked to each item, either way round. */
async function linkMap(type: ItemType, ids: number[], other: TargetType): Promise<Map<number, number[]>> {
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

async function names(other: TargetType, ids: number[]): Promise<Map<number, NamedLink>> {
  if (!ids.length) return new Map();
  const table = other === "project" ? projectsTable : organisationsTable;
  const rows = await db.select({ id: table.id, name: table.name, slug: table.slug }).from(table).where(inArray(table.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

async function assertTargets(other: TargetType, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const found = await names(other, ids);
  if (found.size !== new Set(ids).size) throw new NotFoundError(other === "project" ? "That project does not exist" : "That organisation does not exist");
}

/** Replaces the item's links to one kind of target. Returns what was added and removed, for the audit. */
async function setLinks(tx: DbOrTx, type: ItemType, id: number, other: TargetType, ids: number[]) {
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

export interface DocumentView extends Omit<Document, "search" | "suggestionId"> {
  projects: NamedLink[];
  /** AI tools cannot read it (own flag or inherited from a project) */
  hiddenFromAi: boolean;
  /** When OllieOS last read the file's text from Google Drive */
  contentsReadAt: Date | null;
}

async function toDocumentViews(rows: Omit<Document, "search">[]): Promise<DocumentView[]> {
  const ids = rows.map((r) => r.id);
  const [links, hidden, contents] = await Promise.all([
    linkMap("document", ids, "project"),
    ids.length
      ? db.select({ id: documentsTable.id }).from(documentsTable).where(and(inArray(documentsTable.id, ids), sql.raw(`not ${documentVisible("documents")}`)))
      : [],
    ids.length
      ? db.select({ id: documentContentsTable.documentId, readAt: documentContentsTable.readAt }).from(documentContentsTable).where(inArray(documentContentsTable.documentId, ids))
      : [],
  ]);
  const readAt = new Map(contents.map((c) => [c.id, c.readAt]));
  const projectNames = await names("project", [...new Set([...links.values()].flat())]);
  const hiddenSet = new Set(hidden.map((h) => h.id));
  return rows.map(({ suggestionId: _s, ...r }) => ({
    ...r,
    projects: (links.get(r.id) ?? []).map((p) => projectNames.get(p)).filter((p): p is NamedLink => !!p).sort((a, b) => a.name.localeCompare(b.name, "en-GB")),
    hiddenFromAi: hiddenSet.has(r.id),
    contentsReadAt: readAt.get(r.id) ?? null,
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

async function loadDocument(id: number) {
  const [row] = await db.select(documentColumns).from(documentsTable).where(eq(documentsTable.id, id));
  if (!row) throw new NotFoundError("That document does not exist");
  return row;
}

export interface DocumentInput {
  url: string;
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
  const url = parseLink(input.url);
  const href = url.toString();
  const projectIds = input.projectIds ?? [];
  await assertTargets("project", projectIds);
  const [taken] = await tx.select({ id: documentsTable.id, title: documentsTable.title }).from(documentsTable).where(eq(documentsTable.url, href));
  if (taken) throw new ConflictError(`That link is already in the Library as "${taken.title}"`);
  const [row] = await tx
    .insert(documentsTable)
    .values({
      title: cleanText(input.title) ?? titleFromUrl(url),
      url: href,
      location: input.location ?? locationOf(url),
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
  const id = await db.transaction((tx) => insertDocument(tx, input, ACTOR));
  return (await toDocumentViews([await loadDocument(id)]))[0];
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
  return (await toDocumentViews([await loadDocument(id)]))[0];
}

/* ---------- Playbooks ---------- */

export interface PlaybookView extends Omit<Playbook, "suggestionId"> {
  projects: NamedLink[];
  organisations: NamedLink[];
  /** True when AI tools receive it: enabled, and global or linked to something visible */
  sentToAi: boolean;
}

async function toPlaybookViews(rows: Playbook[]): Promise<PlaybookView[]> {
  const ids = rows.map((r) => r.id);
  const [projectLinks, orgLinks, visible] = await Promise.all([
    linkMap("playbook", ids, "project"),
    linkMap("playbook", ids, "organisation"),
    ids.length ? db.select({ id: playbooksTable.id }).from(playbooksTable).where(and(inArray(playbooksTable.id, ids), sql.raw(playbookVisible("playbooks")))) : [],
  ]);
  const [projectNames, orgNames] = await Promise.all([
    names("project", [...new Set([...projectLinks.values()].flat())]),
    names("organisation", [...new Set([...orgLinks.values()].flat())]),
  ]);
  const visibleSet = new Set(visible.map((v) => v.id));
  const pick = (m: Map<number, NamedLink>, xs: number[] | undefined) =>
    (xs ?? []).map((x) => m.get(x)).filter((x): x is NamedLink => !!x).sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
  return rows.map(({ suggestionId: _s, ...r }) => ({
    ...r,
    projects: pick(projectNames, projectLinks.get(r.id)),
    organisations: pick(orgNames, orgLinks.get(r.id)),
    sentToAi: visibleSet.has(r.id),
  }));
}

export async function listPlaybooks(): Promise<PlaybookView[]> {
  await ensureSeeds();
  const rows = await db.select().from(playbooksTable).orderBy(asc(playbooksTable.id));
  return toPlaybookViews(rows);
}

/**
 * Playbooks shown on a project page: global ones and those linked to the project or to an
 * organisation linked to it. Paused ones are included and marked.
 */
export async function playbooksForProject(projectId: number): Promise<PlaybookView[]> {
  const res = await db.execute(sql`
    select pb.id from playbooks pb
    where not exists (select 1 from links l where (l.from_type = 'playbook' and l.from_id = pb.id and l.to_type in ('project', 'organisation'))
                                              or (l.to_type = 'playbook' and l.to_id = pb.id and l.from_type in ('project', 'organisation')))
      or exists (select 1 from links l where (l.from_type = 'playbook' and l.from_id = pb.id and l.to_type = 'project' and l.to_id = ${projectId})
                                          or (l.to_type = 'playbook' and l.to_id = pb.id and l.from_type = 'project' and l.from_id = ${projectId}))
      or exists (select 1 from links l, links po where
                   ((l.from_type = 'playbook' and l.from_id = pb.id and l.to_type = 'organisation') or (l.to_type = 'playbook' and l.to_id = pb.id and l.from_type = 'organisation'))
                   and ((po.from_type = 'project' and po.from_id = ${projectId} and po.to_type = 'organisation' and po.to_id = case when l.to_type = 'organisation' then l.to_id else l.from_id end)
                     or (po.to_type = 'project' and po.to_id = ${projectId} and po.from_type = 'organisation' and po.from_id = case when l.to_type = 'organisation' then l.to_id else l.from_id end)))`);
  const ids = (res.rows as { id: number }[]).map((r) => Number(r.id));
  if (!ids.length) return [];
  const rows = await db.select().from(playbooksTable).where(inArray(playbooksTable.id, ids)).orderBy(asc(playbooksTable.id));
  return toPlaybookViews(rows);
}

async function loadPlaybook(id: number): Promise<Playbook> {
  const [row] = await db.select().from(playbooksTable).where(eq(playbooksTable.id, id));
  if (!row) throw new NotFoundError("That playbook does not exist");
  return row;
}

export interface PlaybookInput {
  title: string;
  appliesWhen: string;
  rule: string;
  enabled?: boolean;
  projectIds?: number[];
  organisationIds?: number[];
}

function checkRule(rule: string): string {
  const r = cleanText(rule);
  if (!r) throw new ValidationError("A playbook needs a rule");
  if (r.length > PLAYBOOK_RULE_MAX) throw new ValidationError(`Keep the rule to ${PLAYBOOK_RULE_MAX} characters or fewer`);
  return r;
}

/** Inserts a playbook inside the caller's transaction. Used directly when approving a suggestion. */
export async function insertPlaybook(tx: DbOrTx, input: PlaybookInput, suggestionId: number | null = null): Promise<number> {
  const title = cleanText(input.title);
  if (!title) throw new ValidationError("A playbook needs a title");
  const appliesWhen = cleanText(input.appliesWhen);
  if (!appliesWhen) throw new ValidationError("Say when the playbook applies");
  const rule = checkRule(input.rule);
  const projectIds = input.projectIds ?? [];
  const organisationIds = input.organisationIds ?? [];
  await Promise.all([assertTargets("project", projectIds), assertTargets("organisation", organisationIds)]);
  const [row] = await tx
    .insert(playbooksTable)
    .values({ title, appliesWhen, rule, enabled: input.enabled ?? true, createdBy: ACTOR, suggestionId })
    .returning({ id: playbooksTable.id });
  await setLinks(tx, "playbook", row.id, "project", projectIds);
  await setLinks(tx, "playbook", row.id, "organisation", organisationIds);
  await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "playbook", entityId: row.id, payload: { title, suggestionId } });
  return row.id;
}

export async function createPlaybook(input: PlaybookInput): Promise<PlaybookView> {
  const id = await db.transaction((tx) => insertPlaybook(tx, input));
  return (await toPlaybookViews([await loadPlaybook(id)]))[0];
}

export async function updatePlaybook(id: number, input: Partial<PlaybookInput>): Promise<PlaybookView> {
  const current = await loadPlaybook(id);
  const set: Partial<Playbook> = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title);
    if (!title) throw new ValidationError("A playbook needs a title");
    set.title = title;
  }
  if (input.appliesWhen !== undefined) {
    const appliesWhen = cleanText(input.appliesWhen);
    if (!appliesWhen) throw new ValidationError("Say when the playbook applies");
    set.appliesWhen = appliesWhen;
  }
  if (input.rule !== undefined) set.rule = checkRule(input.rule);
  if (input.enabled !== undefined) set.enabled = input.enabled;
  await Promise.all([assertTargets("project", input.projectIds ?? []), assertTargets("organisation", input.organisationIds ?? [])]);
  await db.transaction(async (tx) => {
    if (Object.keys(set).length) await tx.update(playbooksTable).set(set).where(eq(playbooksTable.id, id));
    const payload: Record<string, unknown> = { fields: Object.keys(set) };
    if (input.projectIds) payload.projects = await setLinks(tx, "playbook", id, "project", input.projectIds);
    if (input.organisationIds) payload.organisations = await setLinks(tx, "playbook", id, "organisation", input.organisationIds);
    if (set.enabled !== undefined && set.enabled !== current.enabled) payload.enabled = { from: current.enabled, to: set.enabled };
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "playbook", entityId: id, payload });
  });
  return (await toPlaybookViews([await loadPlaybook(id)]))[0];
}
