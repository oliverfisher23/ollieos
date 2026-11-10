/**
 * Reads Claude's folder in Ollie's Dropbox through the Replit Dropbox connector, read-only
 * (build plan 13, Part E). OllieOS only lists and downloads; it never writes to Dropbox.
 *
 * Each check lists the whole folder and compares every readable file (Markdown, text, Word, PDF)
 * with what was seen before. New and changed files are put in line for the knowledge step; the
 * reader then proposes suggestions for what is new. When a file changed that was never read, the
 * version seen before is downloaded first, so only the change is read.
 *
 * Dropbox's proxy only reaches api.dropboxapi.com, so files are downloaded through a temporary
 * link that Dropbox gives for each one.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, knowledgeSourcesTable } from "@workspace/db";
import { MAX_FILE_BYTES, isReadableName, textFromFile, titleFromFileName } from "../documents/fileText";
import { ConnectorError, proxyReadPost } from "./http";

const CONNECTOR = "dropbox";
const NAME = "Dropbox";

/** Earlier versions downloaded in one check, so a changed file is read only for what changed */
const OLD_VERSIONS_PER_RUN = 30;

export interface DropboxState {
  /** The folder Ollie chose, as Dropbox shows it */
  folder: string | null;
  /** What to do with files already there at the first check */
  existing: "all" | "new";
  /** False until the first check has listed the folder */
  listed: boolean;
}

export const DEFAULT_DROPBOX_STATE: DropboxState = { folder: null, existing: "new", listed: false };

export interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_lower: string;
  path_display: string;
  id?: string;
  rev?: string;
  content_hash?: string;
  size?: number;
  server_modified?: string;
}

export const dropboxKey = (pathLower: string) => `dropbox:${pathLower}`;

/** A file the knowledge step reads: a readable kind, not too large, not in a hidden or tool folder. */
export function isReadableEntry(e: DropboxEntry): boolean {
  if (e[".tag"] !== "file") return false;
  if (!isReadableName(e.name)) return false;
  if ((e.size ?? 0) > MAX_FILE_BYTES || (e.size ?? 0) === 0) return false;
  return !e.path_lower.split("/").some((seg) => seg.startsWith(".") || seg === "node_modules" || seg === "__pycache__");
}

/** Where Ollie can open the file in Dropbox on the web. */
export function dropboxWebUrl(pathDisplay: string): string {
  const i = pathDisplay.lastIndexOf("/");
  const folder = pathDisplay.slice(0, i) || "/";
  const name = pathDisplay.slice(i + 1);
  return `https://www.dropbox.com/home${folder.split("/").map(encodeURIComponent).join("/")}?preview=${encodeURIComponent(name)}`;
}

/** "/Cowork/Springpod" style: a leading slash, no trailing one. Dropbox's root is "". */
export function normaliseFolder(raw: string): string {
  const t = raw.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  if (!t) return "";
  return t.startsWith("/") ? t : `/${t}`;
}

export async function dropboxAccount(): Promise<string | null> {
  const j = await proxyReadPost(CONNECTOR, NAME, "/2/users/get_current_account", null);
  return typeof j?.email === "string" ? j.email : null;
}

/** Every entry under a folder, all the way down. Null when the folder is not there. */
export async function listFolder(folder: string): Promise<DropboxEntry[] | null> {
  let j = await proxyReadPost(CONNECTOR, NAME, "/2/files/list_folder", { path: folder, recursive: true, include_deleted: false, limit: 2000 });
  if (!j) return null;
  const out = [...((j.entries as DropboxEntry[]) ?? [])];
  for (let page = 0; j.has_more && page < 50; page++) {
    j = await proxyReadPost(CONNECTOR, NAME, "/2/files/list_folder/continue", { cursor: j.cursor });
    if (!j) break;
    out.push(...((j.entries as DropboxEntry[]) ?? []));
  }
  return out;
}

/** Details of one file or folder, or null when it is not there. */
export async function metadata(path: string): Promise<DropboxEntry | null> {
  return (await proxyReadPost(CONNECTOR, NAME, "/2/files/get_metadata", { path })) as DropboxEntry | null;
}

/**
 * The text of a file, by path or by "rev:<revision>" for an earlier version. Null when the file is
 * gone. `name` decides how the file is read.
 */
export async function dropboxText(pathOrRev: string, name: string): Promise<string | null> {
  const j = await proxyReadPost(CONNECTOR, NAME, "/2/files/get_temporary_link", { path: pathOrRev });
  const link = typeof j?.link === "string" ? j.link : null;
  if (!link) return null;
  const res = await fetch(link);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new ConnectorError(`Could not download a file from Dropbox (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return textFromFile(name, bytes);
}

/** The Dropbox path in a Library link to dropbox.com/home, or null for shared and other links. */
export function pathFromDropboxLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (!/(^|\.)dropbox\.com$/.test(url.hostname)) return null;
  const m = /^\/home(\/.*)?$/.exec(url.pathname);
  if (!m) return null;
  const folder = decodeURIComponent(m[1] ?? "");
  const preview = url.searchParams.get("preview");
  return preview ? `${folder}/${preview}` : folder || null;
}

/* ---------- The check ---------- */

export interface DropboxCounts {
  /** Readable files in the folder */
  files: number;
  added: number;
  changed: number;
  /** Put in line for the knowledge step this check */
  queued: number;
  removed: number;
  /** Files of other kinds, too large, or in hidden folders */
  left_out: number;
}

export interface DropboxRead {
  account: string | null;
  found: number;
  counts: DropboxCounts;
  state: DropboxState;
}

export async function readDropbox(saved: DropboxState, now: Date): Promise<DropboxRead> {
  const counts: DropboxCounts = { files: 0, added: 0, changed: 0, queued: 0, removed: 0, left_out: 0 };
  const account = await dropboxAccount();
  if (saved.folder == null) return { account, found: 0, counts, state: saved };
  const entries = await listFolder(saved.folder);
  if (!entries) throw new ConnectorError(`There is no folder called ${saved.folder} in Dropbox. Choose the folder again in Settings.`);

  const files = entries.filter((e) => e[".tag"] === "file");
  const readable = files.filter(isReadableEntry);
  counts.files = readable.length;
  counts.left_out = files.length - readable.length;

  const rows = await db
    .select({ id: knowledgeSourcesTable.id, key: knowledgeSourcesTable.key, contentHash: knowledgeSourcesTable.contentHash, rev: knowledgeSourcesTable.rev, hasText: sql<boolean>`${knowledgeSourcesTable.readText} is not null`, status: knowledgeSourcesTable.status })
    .from(knowledgeSourcesTable)
    .where(eq(knowledgeSourcesTable.kind, "dropbox"));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const seen = new Set<string>();
  // The first check of a folder either reads everything once or only notes what is there.
  const firstQueue = saved.listed || saved.existing === "all";
  let oldVersions = 0;

  for (const e of readable) {
    const key = dropboxKey(e.path_lower);
    seen.add(key);
    const row = byKey.get(key);
    const common = {
      title: titleFromFileName(e.name),
      path: e.path_display,
      url: dropboxWebUrl(e.path_display),
      contentHash: e.content_hash ?? null,
      rev: e.rev ?? null,
      modifiedAt: e.server_modified ? new Date(e.server_modified) : null,
    };
    if (!row) {
      await db.insert(knowledgeSourcesTable).values({ kind: "dropbox", key, ...common, status: firstQueue ? "queued" : "idle", queuedAt: firstQueue ? now : null }).onConflictDoNothing();
      counts.added++;
      if (firstQueue) counts.queued++;
      continue;
    }
    if (row.contentHash && row.contentHash === e.content_hash) continue;
    counts.changed++;
    // Never read before: keep the version seen last time, so only the change is read.
    let readText: string | undefined;
    if (!row.hasText && row.rev && oldVersions < OLD_VERSIONS_PER_RUN) {
      oldVersions++;
      readText = (await dropboxText(`rev:${row.rev}`, e.name).catch(() => null)) ?? undefined;
    }
    await db
      .update(knowledgeSourcesTable)
      .set({ ...common, ...(readText !== undefined ? { readText } : {}), status: row.status === "reading" ? "reading" : "queued", queuedAt: now, lastError: null })
      .where(eq(knowledgeSourcesTable.id, row.id));
    counts.queued++;
  }

  // Files deleted or moved out of the folder are forgotten; what was approved from them stays.
  const gone = rows.filter((r) => !seen.has(r.key)).map((r) => r.id);
  if (gone.length) {
    await db.delete(knowledgeSourcesTable).where(and(eq(knowledgeSourcesTable.kind, "dropbox"), inArray(knowledgeSourcesTable.id, gone)));
    counts.removed = gone.length;
  }
  return { account, found: readable.length, counts, state: { ...saved, listed: true } };
}

/** How many readable files a folder holds, for Settings before Ollie chooses it. */
export async function countReadable(folder: string): Promise<{ readable: number; other: number } | null> {
  const entries = await listFolder(folder);
  if (!entries) return null;
  const files = entries.filter((e) => e[".tag"] === "file");
  const readable = files.filter(isReadableEntry).length;
  return { readable, other: files.length - readable };
}

/** Removes every Dropbox file OllieOS was keeping track of, when the folder changes. */
export async function forgetDropboxFiles(): Promise<void> {
  await db.delete(knowledgeSourcesTable).where(and(eq(knowledgeSourcesTable.kind, "dropbox"), like(knowledgeSourcesTable.key, "dropbox:%")));
}
