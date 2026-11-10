/**
 * The background reader for the knowledge step (build plan 13, Part E). Library documents Ollie
 * asks about and files in Claude's Dropbox folder wait in `knowledge_sources`; this reads them one
 * at a time per worker and turns what it finds into Knowledge Inbox suggestions.
 *
 * Library documents go before Dropbox files, so a document Ollie just asked about is not stuck
 * behind a folder being read for the first time. A read is claimed in the database first, so two
 * server instances never read the same thing.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db, documentContentsTable, documentsTable, knowledgeSourcesTable, type KnowledgeSource } from "@workspace/db";
import { logger } from "../../lib/logger";
import { documentVisible } from "../../lib/ai-data/visibility";
import { ConnectorError } from "../connectors/http";
import { cleanDriveLink, driveFile, driveFileId, driveFileText, driveFolderId, folderFiles, canReadText, CONTENT_CHARS } from "../connectors/drive";
import { dropboxText, pathFromDropboxLink } from "../connectors/dropbox";
import { documentView, insertDocument, keepDocumentText, parseLink, type DocumentView } from "../library";
import { ACTOR } from "../knowledge/common";
import { NotFoundError, ValidationError } from "../tasks";
import { emptyKnowledgeCounts, type KnowledgeCounts } from "./counts";
import { enqueueDocument } from "./enqueue";
import { changedLines, DOCUMENT_PROPOSER, extractKnowledge, proposeExtracted } from "./knowledge";

const WORKERS = 2;
const POLL_MS = 30_000;
/** A read still marked as running after this long was cut short (a restart) and is tried again */
const STALE_MS = 20 * 60_000;
/** Most documents taken from one Drive folder */
export const FOLDER_MAX = 100;

/** A problem with one document that Ollie can act on; shown on the Library card. */
class ReadError extends Error {}

/* ---------- Text for each kind of source ---------- */

interface Source {
  text: string;
  where: string;
  label: string;
  url: string | null;
  document: { id: number; title: string; url: string | null } | null;
}

async function documentSource(row: KnowledgeSource, now: Date): Promise<Source> {
  const id = row.documentId!;
  const [doc] = await db
    .select({ id: documentsTable.id, title: documentsTable.title, url: documentsTable.url, location: documentsTable.location, visible: sql<boolean>`${sql.raw(documentVisible("documents"))}` })
    .from(documentsTable)
    .where(eq(documentsTable.id, id));
  if (!doc) throw new ReadError("The document is no longer in the Library.");
  if (!doc.visible) throw new ReadError("This document is hidden from AI, so OllieOS does not read it for knowledge.");
  const [kept] = await db.select().from(documentContentsTable).where(eq(documentContentsTable.documentId, id));
  let text: string | null = kept && ["pasted", "upload", "claude"].includes(kept.origin) ? kept.text : null;

  if (text == null && doc.url) {
    const fileId = driveFileId(doc.url);
    const dropboxPath = pathFromDropboxLink(doc.url);
    if (fileId) {
      const f = await driveFile(fileId);
      if (!f || f.trashed) throw new ReadError("Google Drive no longer has this file, or this account cannot open it.");
      if (!canReadText(f.mimeType)) throw new ReadError("OllieOS cannot read this kind of file. Paste its text into the Library instead.");
      text = await driveFileText(f, CONTENT_CHARS);
      if (text) await keepDocumentText(db, id, text, "gdrive", { fileId, fileModifiedAt: f.modifiedTime ? new Date(f.modifiedTime) : null, now });
    } else if (dropboxPath) {
      text = await dropboxText(dropboxPath, dropboxPath.split("/").pop() ?? dropboxPath);
      if (text) await keepDocumentText(db, id, text, "dropbox", { fileId: dropboxPath, now });
    } else if (kept) {
      text = kept.text;
    }
  }
  if (text == null) {
    throw new ReadError(doc.url ? "OllieOS cannot open this link. Paste the text into the Library instead." : "There is no text kept for this document.");
  }
  return { text, where: doc.url ? `Library document at ${doc.url}` : "Library document kept in OllieOS", label: `Library: ${doc.title}`, url: doc.url, document: { id: doc.id, title: doc.title, url: doc.url } };
}

async function dropboxSource(row: KnowledgeSource): Promise<Source> {
  const path = row.path!;
  const text = await dropboxText(path, path.split("/").pop() ?? path);
  if (text == null) throw new ReadError("The file is no longer in Dropbox.");
  return { text, where: `Dropbox file ${path}`, label: `Dropbox: ${path}`, url: row.url, document: null };
}

/* ---------- Reading one ---------- */

/** Takes the next waiting read, Library documents first. */
async function claimNext(now: Date): Promise<KnowledgeSource | null> {
  const res = await db.execute(sql`
    update knowledge_sources set status = 'reading', started_at = ${now.toISOString()}::timestamptz
    where id = (
      select id from knowledge_sources where status = 'queued'
      order by (kind = 'document') desc, queued_at asc nulls first, id asc
      limit 1 for update skip locked)
    returning id`);
  const id = (res.rows[0] as { id?: number } | undefined)?.id;
  if (id == null) return null;
  const [row] = await db.select().from(knowledgeSourcesTable).where(eq(knowledgeSourcesTable.id, Number(id)));
  return row ?? null;
}

/** Done: back to idle, or in line again when it was asked for again while being read. */
const afterRead = sql`case when ${knowledgeSourcesTable.queuedAt} > ${knowledgeSourcesTable.startedAt} then 'queued' else 'idle' end`;

export async function readSource(row: KnowledgeSource, now = new Date()): Promise<KnowledgeCounts | null> {
  try {
    const src = row.kind === "document" ? await documentSource(row, now) : await dropboxSource(row);
    let counts: KnowledgeCounts = emptyKnowledgeCounts();
    const prev = row.readText;
    const changed = prev == null ? null : prev === src.text ? "" : changedLines(prev, src.text);
    // Read before and nothing added: nothing to ask the model.
    if (changed !== "") {
      const { result, known } = await extractKnowledge({ title: row.title, where: src.where, text: src.text, changed }, now);
      counts = await proposeExtracted(result, known, {
        meta: { proposedBy: DOCUMENT_PROPOSER, clientId: null, sourceType: "document", sourceRef: row.key, sourceUrl: src.url, sourceLabel: src.label },
        document: src.document,
        now,
      });
    }
    await db
      .update(knowledgeSourcesTable)
      .set({ status: afterRead, readText: src.text, lastReadAt: now, lastCounts: { ...counts }, lastError: null })
      .where(eq(knowledgeSourcesTable.id, row.id));
    return counts;
  } catch (err) {
    const message =
      err instanceof ReadError || err instanceof ValidationError || err instanceof ConnectorError ? err.message : "Something went wrong reading this. Try again later.";
    if (!(err instanceof ReadError || err instanceof ValidationError)) logger.warn({ err, source: row.key }, "Knowledge read failed");
    await db.update(knowledgeSourcesTable).set({ status: "failed", lastError: message }).where(eq(knowledgeSourcesTable.id, row.id));
    return null;
  }
}

/** Reads what is waiting, up to `max`, in this process. Used by tests and by the workers. */
export async function readWaiting(max = 1, now = new Date()): Promise<number> {
  let n = 0;
  for (; n < max; n++) {
    const row = await claimNext(now);
    if (!row) break;
    await readSource(row, now);
  }
  return n;
}

/* ---------- Workers ---------- */

let busy = 0;
let timer: NodeJS.Timeout | null = null;

/** Starts workers for anything waiting. Safe to call often. */
export function kickKnowledgeReader(): void {
  if (process.env.NODE_ENV === "test") return;
  while (busy < WORKERS) {
    busy++;
    void (async () => {
      try {
        for (;;) {
          const row = await claimNext(new Date());
          if (!row) break;
          await readSource(row);
        }
      } catch (err) {
        logger.error({ err }, "Knowledge reader stopped");
      } finally {
        busy--;
      }
    })();
  }
}

export function startKnowledgeReader(): void {
  if (timer || process.env.NODE_ENV === "test") return;
  // Reads cut short by a restart go back in line.
  void db
    .update(knowledgeSourcesTable)
    .set({ status: "queued" })
    .where(and(eq(knowledgeSourcesTable.status, "reading"), lt(knowledgeSourcesTable.startedAt, new Date(Date.now() - 60_000))))
    .then(() => kickKnowledgeReader())
    .catch((err) => logger.error({ err }, "Could not start the knowledge reader"));
  timer = setInterval(() => {
    void db
      .update(knowledgeSourcesTable)
      .set({ status: "queued" })
      .where(and(eq(knowledgeSourcesTable.status, "reading"), lt(knowledgeSourcesTable.startedAt, new Date(Date.now() - STALE_MS))))
      .then(() => kickKnowledgeReader())
      .catch((err) => logger.error({ err }, "Knowledge reader check failed"));
  }, POLL_MS);
  timer.unref();
}

/* ---------- Asking for a read ---------- */

/** "Build knowledge from this" on a Library document. */
export async function buildKnowledgeFromDocument(id: number): Promise<DocumentView> {
  const [doc] = await db
    .select({ id: documentsTable.id, title: documentsTable.title, url: documentsTable.url, visible: sql<boolean>`${sql.raw(documentVisible("documents"))}` })
    .from(documentsTable)
    .where(eq(documentsTable.id, id));
  if (!doc) throw new NotFoundError("That document does not exist");
  if (!doc.visible) throw new ValidationError("This document is hidden from AI, so OllieOS does not read it for knowledge. Change that on the document first.");
  await enqueueDocument(db, doc);
  kickKnowledgeReader();
  return documentView(id);
}

export interface DriveImport {
  /** The folder's name, when the link was a folder */
  folder: string | null;
  added: number;
  alreadyThere: number;
  /** Files in the folder OllieOS cannot read */
  skipped: number;
  queued: number;
  documents: DocumentView[];
}

/**
 * A pasted Google Doc or Drive folder link: adds each document to the Library once (one already
 * there is not added again) and puts each in line for the knowledge step.
 */
export async function importFromDrive(link: string): Promise<DriveImport> {
  parseLink(link);
  const folderId = driveFolderId(link);
  const fileId = folderId ? null : driveFileId(link);
  if (!folderId && !fileId) throw new ValidationError("Paste a link to a Google Doc, Sheet, Slides, PDF or a Drive folder");
  let folder: string | null = null;
  let files;
  if (folderId) {
    const r = await folderFiles(folderId, FOLDER_MAX);
    if (!r) throw new ValidationError("OllieOS cannot open that folder. Check it is shared with the Google account connected to OllieOS.");
    folder = r.name;
    files = r.files;
  } else {
    const f = await driveFile(fileId!);
    if (!f || f.trashed) throw new ValidationError("OllieOS cannot open that file. Check it is shared with the Google account connected to OllieOS.");
    files = [f];
  }
  const out: DriveImport = { folder, added: 0, alreadyThere: 0, skipped: 0, queued: 0, documents: [] };
  const ids: number[] = [];
  for (const f of files) {
    if (!canReadText(f.mimeType) || !f.webViewLink) {
      if (f.mimeType !== "application/vnd.google-apps.folder") out.skipped++;
      continue;
    }
    const href = parseLink(cleanDriveLink(f.webViewLink)).toString();
    const [have] = await db.select({ id: documentsTable.id, title: documentsTable.title, url: documentsTable.url }).from(documentsTable).where(eq(documentsTable.url, href));
    const doc = have ?? (await db.transaction(async (tx) => {
      const id = await insertDocument(tx, { url: href, title: f.name }, ACTOR);
      return { id, title: f.name, url: href };
    }));
    if (have) out.alreadyThere++;
    else out.added++;
    await enqueueDocument(db, doc);
    out.queued++;
    ids.push(doc.id);
  }
  if (!ids.length && out.skipped) throw new ValidationError(folder ? "That folder has no files OllieOS can read." : "OllieOS cannot read this kind of file.");
  kickKnowledgeReader();
  for (const id of ids.slice(0, 50)) out.documents.push(await documentView(id));
  return out;
}

/* ---------- Dropbox progress, for Settings ---------- */

export interface DropboxProgress {
  files: number;
  waiting: number;
  reading: number;
  failed: number;
  read: number;
  lastReadAt: Date | null;
}

export async function dropboxProgress(): Promise<DropboxProgress> {
  const [r] = await db
    .select({
      files: sql<number>`count(*)::int`,
      waiting: sql<number>`count(*) filter (where ${knowledgeSourcesTable.status} = 'queued')::int`,
      reading: sql<number>`count(*) filter (where ${knowledgeSourcesTable.status} = 'reading')::int`,
      failed: sql<number>`count(*) filter (where ${knowledgeSourcesTable.status} = 'failed')::int`,
      read: sql<number>`count(*) filter (where ${knowledgeSourcesTable.lastReadAt} is not null)::int`,
      lastReadAt: sql<string | null>`max(${knowledgeSourcesTable.lastReadAt})`,
    })
    .from(knowledgeSourcesTable)
    .where(eq(knowledgeSourcesTable.kind, "dropbox"));
  return { ...r, lastReadAt: r.lastReadAt ? new Date(r.lastReadAt) : null };
}

/** Puts every Dropbox file that failed back in line. */
export async function retryFailedDropbox(now = new Date()): Promise<number> {
  const rows = await db
    .update(knowledgeSourcesTable)
    .set({ status: "queued", queuedAt: now, lastError: null })
    .where(and(eq(knowledgeSourcesTable.kind, "dropbox"), eq(knowledgeSourcesTable.status, "failed")))
    .returning({ id: knowledgeSourcesTable.id });
  kickKnowledgeReader();
  return rows.length;
}
