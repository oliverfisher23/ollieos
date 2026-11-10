/**
 * Puts a Library document in line for the knowledge step. Kept apart from the reader so approving
 * a suggestion can queue a document inside its own transaction without loading the reader.
 */
import { sql } from "drizzle-orm";
import { knowledgeSourcesTable } from "@workspace/db";
import type { DbOrTx } from "../../lib/audit";

export const documentKey = (id: number) => `document:${id}`;

export const sessionKey = (id: number) => `session:${id}`;

/** Queues a saved Cowork session (Part F); a read in progress is read again once it finishes. */
export async function enqueueSession(conn: DbOrTx, session: { id: number; title: string }, now = new Date()): Promise<void> {
  await conn
    .insert(knowledgeSourcesTable)
    .values({ kind: "session", key: sessionKey(session.id), sessionId: session.id, title: session.title, status: "queued", queuedAt: now, lastError: null })
    .onConflictDoUpdate({
      target: knowledgeSourcesTable.key,
      set: {
        title: session.title,
        queuedAt: now,
        lastError: null,
        status: sql`case when ${knowledgeSourcesTable.status} = 'reading' then 'reading' else 'queued' end`,
      },
    });
}

/** Queues the document; a read already in progress is read again once it finishes. */
export async function enqueueDocument(conn: DbOrTx, doc: { id: number; title: string; url: string | null }, now = new Date()): Promise<void> {
  await conn
    .insert(knowledgeSourcesTable)
    .values({ kind: "document", key: documentKey(doc.id), documentId: doc.id, title: doc.title, url: doc.url, status: "queued", queuedAt: now, lastError: null })
    .onConflictDoUpdate({
      target: knowledgeSourcesTable.key,
      set: {
        title: doc.title,
        url: doc.url,
        queuedAt: now,
        lastError: null,
        status: sql`case when ${knowledgeSourcesTable.status} = 'reading' then 'reading' else 'queued' end`,
      },
    });
}
