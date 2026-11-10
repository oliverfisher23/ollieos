import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { docLocationEnum, tsvector } from "./enums";
import { coworkSessionsTable } from "./coworkSessions";

/**
 * Document index (feature 06): a link, a summary and project links. OllieOS never stores the file
 * itself. A document with no link was pasted, uploaded or saved by Claude: its text is kept in
 * `document_contents` and its location is "ollieos". Linked to projects through `links`.
 */
export const documentsTable = pgTable(
  "documents",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    /** Null when the text was pasted, uploaded or saved by Claude */
    url: text("url").unique(),
    location: docLocationEnum("location").notNull(),
    summary: text("summary"),
    /** null means inherit from linked projects (build plan question 44) */
    confidential: boolean("confidential"),
    /** When Ollie or the sweep last confirmed it; shown as "Updated" */
    lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    suggestionId: integer("suggestion_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))`),
  },
  (t) => [index("documents_search_idx").using("gin", t.search)],
);

/**
 * The text of a Library document, so briefs, Ask OllieOS and the knowledge step can use what is
 * inside it: read from Google Drive or Dropbox, or pasted, uploaded or saved by Claude. One row per
 * document; removed with the document. Visibility follows the document itself.
 */
export const documentContentsTable = pgTable(
  "document_contents",
  {
    documentId: integer("document_id")
      .primaryKey()
      .references(() => documentsTable.id, { onDelete: "cascade" }),
    /** The Drive file id or Dropbox path the text came from; null for text kept in OllieOS */
    fileId: text("file_id"),
    /** Where the text came from */
    origin: text("origin", { enum: ["gdrive", "dropbox", "pasted", "upload", "claude", "email"] }).notNull().default("gdrive"),
    /** For uploads and Claude: the file name or kind Ollie or Claude gave */
    originName: text("origin_name"),
    text: text("text").notNull(),
    /** True when the file was longer than OllieOS keeps */
    truncated: boolean("truncated").notNull().default(false),
    /** The file's own modified time when it was read */
    fileModifiedAt: timestamp("file_modified_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
    search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', left(coalesce(text,''), 100000))`),
  },
  (t) => [index("document_contents_search_idx").using("gin", t.search)],
);

export type DocumentContent = typeof documentContentsTable.$inferSelect;

/**
 * The knowledge step (build plan 13, Part E): one row per thing read for knowledge: a Library
 * document, a file in Claude's Dropbox folder, or a saved Cowork session (Part F). Keeps the text as it was last read, so a changed
 * file is only read for what changed, and works as the queue the background reader takes from.
 * Dropbox files stay here and never join the Library. OllieOS never writes to Dropbox.
 */
export const knowledgeSourcesTable = pgTable(
  "knowledge_sources",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind", { enum: ["document", "dropbox", "session"] }).notNull(),
    /** "document:<id>", "dropbox:<lower-case path>" or "session:<id>" */
    key: text("key").notNull().unique(),
    documentId: integer("document_id").references(() => documentsTable.id, { onDelete: "cascade" }),
    /** A Cowork session (Part F) */
    sessionId: integer("session_id").references(() => coworkSessionsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** Dropbox path as shown, for Dropbox files */
    path: text("path"),
    url: text("url"),
    /** Dropbox content hash and revision when last seen */
    contentHash: text("content_hash"),
    rev: text("rev"),
    modifiedAt: timestamp("modified_at", { withTimezone: true }),
    /** The text as it was when last read for knowledge; null until the first read */
    readText: text("read_text"),
    status: text("status", { enum: ["idle", "queued", "reading", "failed"] }).notNull().default("idle"),
    lastError: text("last_error"),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }),
    /** What the last read proposed, by kind */
    lastCounts: jsonb("last_counts").$type<Record<string, number>>(),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("knowledge_sources_status_idx").on(t.status, t.queuedAt)],
);

export type KnowledgeSource = typeof knowledgeSourcesTable.$inferSelect;

/**
 * Playbooks (feature 07): short standing rules every AI tool reads before drafting.
 * Global unless linked to projects or organisations through `links`. Paused ones are never sent to AI.
 */
export const playbooksTable = pgTable(
  "playbooks",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    appliesWhen: text("applies_when").notNull(),
    rule: text("rule").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").notNull().default("ollie"),
    suggestionId: integer("suggestion_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Rules stay short: 400 characters or fewer (feature 07 rule 5).
  (t) => [check("playbooks_rule_length", sql`char_length(${t.rule}) <= 400`)],
);

export type Document = typeof documentsTable.$inferSelect;
export type Playbook = typeof playbooksTable.$inferSelect;
