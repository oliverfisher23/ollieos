import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  aiActivityGroupsTable, askThreadsTable, auditEventsTable, coworkSessionsTable, db,
  documentContentsTable, documentsTable, knowledgeSourcesTable, pool, suggestionsTable, tasksTable,
} from "@workspace/db";
import { client, project, resetDb, scopeFor } from "./helpers";
import { appendAuditEvents, writeAudit } from "../src/lib/audit";
import { recordReads } from "../src/lib/ai-data/scope";
import { loadVisibleDocs } from "../src/lib/ai-data/retrieve";
import { listAiActivity } from "../src/services/access";
import { ask, getThread } from "../src/services/ask/ask";
import { linkedTasks } from "../src/services/inbox";
import { documentViews, listDocuments } from "../src/services/library";
import { backfillAiActivityGroups } from "../src/services/migrations";
import { listSessions, sessionDetail } from "../src/services/sessions";
import { enqueueDocuments } from "../src/services/documents/enqueue";
import { importFromDrive } from "../src/services/documents/reader";
import { folderFiles } from "../src/services/connectors/drive";

vi.mock("../src/services/connectors/drive", async (original) => ({
  ...(await original<typeof import("../src/services/connectors/drive")>()),
  folderFiles: vi.fn(),
}));
vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test",
  answerFromDocs: vi.fn(),
}));

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());
afterAll(() => pool.end());

function captureQueries() {
  const spy = vi.spyOn(pool, "query");
  return () => spy.mock.calls.map((args) => {
    const q = args[0] as unknown as string | { text: string };
    return typeof q === "string" ? q : q.text;
  });
}

const answer = {
  status: "not_found", summary: "Nothing yet", items: [], related: [], bundleTitle: null,
  hiddenMatches: false, hiddenRefs: [], sourceCount: 0, retrievedRefs: [], draftTo: null, draft: null, bundle: null,
};

async function makeChain(n: number) {
  const rows = [];
  let parentId: number | null = null;
  for (let i = 0; i < n; i++) {
    const [r] = await db.insert(askThreadsTable).values({
      parentId, question: `Turn ${i}`, answer, citedIds: [], createdAt: new Date(2026, 0, 1, 0, i),
    }).returning();
    rows.push(r);
    parentId = r.id;
  }
  return rows;
}

describe("bounded data-layer queries", () => {
  it("pages complete AI groups, keeps three ordered refs and updates an older batch atomically", async () => {
    const c = await client("Activity test");
    const p = await project("Activity test");
    const scope = await scopeFor(c);
    await appendAuditEvents(db, Array.from({ length: 130 }, (_, i) => ({
      actor: c.name, clientId: c.id, action: "read", entityType: "project" as const, entityId: p.id,
      payload: { batch: `old-${i}` }, createdAt: new Date(2020, 0, 1, 0, i),
    })));
    await appendAuditEvents(db, Array.from({ length: 105 }, () => ({
      actor: c.name, clientId: c.id, action: "read", entityType: "project" as const, entityId: p.id,
      payload: { batch: "large", question: "A complete batch" },
    })));
    let rows = await listAiActivity(1);
    expect(rows[0]).toMatchObject({ key: "large", count: 105, context: "A complete batch" });
    expect(rows[0].items).toHaveLength(3);
    await appendAuditEvents(db, [{
      actor: c.name, clientId: c.id, action: "read", payload: { batch: "old-0" },
      createdAt: new Date("2030-01-01"),
    }]);
    rows = await listAiActivity(1);
    expect(rows[0]).toMatchObject({ key: "old-0", count: 2 });
    expect(await listAiActivity()).toHaveLength(100);
    await recordReads(scope, [], { query: "Nothing matched" }, "search");
    expect((await listAiActivity()).some((r) => r.action === "search" && r.context === "Nothing matched")).toBe(true);
    await expect(db.transaction(async (tx) => {
      await writeAudit(tx, { actor: c.name, clientId: c.id, action: "read", payload: { batch: "rollback" } });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await db.select().from(aiActivityGroupsTable).where(eq(aiActivityGroupsTable.key, "rollback"))).toHaveLength(0);
  });

  it("backfills historical batches once without replacing newer headers", async () => {
    const c = await client("History test");
    await db.insert(auditEventsTable).values([
      { actor: c.name, clientId: c.id, action: "search", payload: { batch: "historical", query: "Earlier search" } },
      { actor: "ollie", clientId: c.id, action: "read" },
    ]);
    await backfillAiActivityGroups();
    await backfillAiActivityGroups();
    expect(await listAiActivity()).toMatchObject([{ key: "historical", count: 1, context: "Earlier search" }]);
  });

  it("loads deep ancestry and latest-child branches in fixed queries with a 50-turn guard", async () => {
    const chain = await makeChain(65);
    const [branch] = await db.insert(askThreadsTable).values({
      parentId: chain[10].id, question: "Latest branch", answer, citedIds: [],
      createdAt: new Date("2030-01-01"),
    }).returning();
    const queries = captureQueries();
    const view = await getThread(chain[0].id);
    expect(view.turns.map((t) => t.id)).toEqual([...chain.slice(0, 11).map((r) => r.id), branch.id]);
    expect(queries().filter((q) => q.includes("ask_threads"))).toHaveLength(2);
    const middle = await getThread(chain[15].id);
    expect(middle.turns).toHaveLength(50);
    expect(middle.turns[0].id).toBe(chain[0].id);
    const end = await getThread(chain[64].id);
    expect(end.turns).toHaveLength(50);
    expect(end.turns[0].id).toBe(chain[15].id);
  });

  it("uses the actual prior budget and reuses those turns after saving a follow-up", async () => {
    const chain = await makeChain(20);
    const queries = captureQueries();
    const result = await ask("A subject with no matches", chain.at(-1)!.id);
    expect(result.turns).toHaveLength(21);
    const recursive = queries().filter((q) => q.includes("with recursive chain"));
    expect(recursive).toHaveLength(2); // prior budget, then only the missing older ancestry
    expect(queries().filter((q) => q.includes('from "ask_threads"'))).toHaveLength(1); // parent loaded once
  });

  it("never selects previous document bodies for Library metadata, and bounds AI excerpts in SQL", async () => {
    const [doc] = await db.insert(documentsTable).values({ title: "Long text", location: "ollieos", createdBy: "ollie" }).returning();
    await db.insert(documentContentsTable).values({ documentId: doc.id, origin: "pasted", text: "a".repeat(12000) });
    await db.insert(knowledgeSourcesTable).values({
      kind: "document", key: `document:${doc.id}`, documentId: doc.id, title: doc.title,
      readText: "b".repeat(12000), status: "failed", lastError: "Retry",
    });
    const queries = captureQueries();
    const views = await listDocuments();
    expect(views[0].knowledge).toMatchObject({ status: "failed", error: "Retry" });
    const metadata = queries().filter((q) => q.includes('from "knowledge_sources"'));
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).not.toMatch(/read_text|select \*/i);
    const c = await client("Document test");
    const docs = await loadVisibleDocs(await scopeFor(c), [`document:${doc.id}`]);
    expect(docs[0].text).toContain("start only");
    expect(docs[0].text.length).toBeLessThan(4500);
    expect(queries().some((q) => /left\("document_contents"\."text",/.test(q))).toBe(true);
    expect((await documentViews([doc.id, doc.id])).map((d) => d.id)).toEqual([doc.id, doc.id]);
  });

  it("limits task linking to candidate threads with open/latest preference and sent/chase exclusions", async () => {
    const values = [
      { title: "Old open", status: "now" as const, sourceUrl: "https://mail.google.com/mail/u/1/#all/abc", updatedAt: new Date("2020-01-01") },
      { title: "New closed", status: "done" as const, sourceUrl: "https://mail.google.com/mail/u/0/#all/abc", updatedAt: new Date("2026-01-01") },
      { title: "Latest closed", status: "done" as const, sourceUrl: "https://mail.google.com/mail/u/me/#all/def  " },
      { title: "Sent", status: "now" as const, sourceUrl: "https://mail.google.com/mail/u/0/#all/sent", fromName: "You" },
      { title: "Chase", status: "now" as const, sourceUrl: "https://mail.google.com/mail/u/0/#all/chase", sourceRef: "message#chase" },
      { title: "Unrelated history", status: "now" as const, sourceUrl: "https://mail.google.com/mail/u/0/#all/history" },
    ];
    const rows = await db.insert(tasksTable).values(values.map((v) => ({ ...v, source: "email" as const, createdBy: "ollie" }))).returning();
    const queries = captureQueries();
    expect(await linkedTasks([])).toEqual(new Map());
    expect(queries()).toHaveLength(0);
    const links = await linkedTasks(["abc", "def", "sent", "chase"]);
    expect([...links.keys()]).toEqual(["abc", "def"]);
    expect(links.get("abc")?.id).toBe(rows[0].id);
    expect(links.get("def")?.id).toBe(rows[2].id);
    expect(queries()).toHaveLength(1);
  });

  it("aggregates session counts for the selected page and preserves zero counts", async () => {
    const sessions = await db.insert(coworkSessionsTable).values([
      { title: "With proposals", summary: "Summary", createdBy: "Claude" },
      { title: "No proposals", summary: "Summary", createdBy: "Claude" },
    ]).returning();
    await db.insert(suggestionsTable).values([
      { kind: "decision", status: "approved", resultType: "decision" },
      { kind: "document", status: "approved", resultType: "document" },
      { kind: "document", status: "pending", resultType: null },
      { kind: "decision", status: "rejected", resultType: "decision" },
    ].map((g) => ({
      ...g, sourceRef: `session:${sessions[0].id}`, proposedBy: "Claude", payload: {}, normalisedText: g.kind,
    })) as (typeof suggestionsTable.$inferInsert)[]);
    const queries = captureQueries();
    const views = await listSessions();
    expect(views.find((v) => v.id === sessions[0].id)).toMatchObject({ decisionCount: 1, documentCount: 1, waitingCount: 1 });
    expect(views.find((v) => v.id === sessions[1].id)).toMatchObject({ decisionCount: 0, documentCount: 0, waitingCount: 0 });
    expect(queries().filter((q) => q.includes("from suggestions g"))).toHaveLength(1);
    expect(await sessionDetail(sessions[0].id)).toMatchObject({ decisionCount: 1, documentCount: 1, waitingCount: 1 });
  });

  it("imports folders in chunks, preserves order and atomically deduplicates concurrent imports", async () => {
    const files = Array.from({ length: 60 }, (_, i) => ({
      id: `drivefile${i}`, name: `File ${i}`, mimeType: "application/vnd.google-apps.document",
      webViewLink: `https://docs.google.com/document/d/drivefile${i}/edit`,
    }));
    vi.mocked(folderFiles).mockResolvedValue({ name: "Folder", files });
    const first = await importFromDrive("https://drive.google.com/drive/folders/testfolder123");
    expect(first).toMatchObject({ added: 60, alreadyThere: 0, queued: 60 });
    expect(first.documents.map((d) => d.title)).toEqual(files.slice(0, 50).map((f) => f.name));
    const queries = captureQueries();
    const repeat = await importFromDrive("https://drive.google.com/drive/folders/testfolder123");
    expect(repeat).toMatchObject({ added: 0, alreadyThere: 60, queued: 60 });
    expect(queries().filter((q) => q.includes('from "knowledge_sources"'))).toHaveLength(1);
    expect(queries().filter((q) => q.includes('from "documents"'))).toHaveLength(3); // URL lookup, response rows, visibility
    vi.mocked(folderFiles).mockResolvedValue({ name: "New folder", files: [files[0], { ...files[0], id: "newfile", name: "New", webViewLink: "https://docs.google.com/document/d/newfile123/edit" }] });
    const [a, b] = await Promise.all([
      importFromDrive("https://drive.google.com/drive/folders/testfolder123"),
      importFromDrive("https://drive.google.com/drive/folders/testfolder123"),
    ]);
    expect(a.added + b.added).toBe(1);
    const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "create"));
    expect(audits).toHaveLength(61);
    const doc = first.documents[0];
    await db.update(knowledgeSourcesTable).set({ status: "reading", readText: "Keep previous text" }).where(eq(knowledgeSourcesTable.documentId, doc.id));
    await enqueueDocuments(db, [doc, doc]);
    const [queue] = await db.select().from(knowledgeSourcesTable).where(eq(knowledgeSourcesTable.documentId, doc.id));
    expect(queue).toMatchObject({ status: "reading", readText: "Keep previous text" });
  });

  it("executes EXPLAIN ANALYZE for the bounded session aggregate on representative test data", async () => {
    await db.execute(sql`
      insert into cowork_sessions (title, summary, created_by)
      select 'Session ' || n, 'Summary', 'Claude' from generate_series(1, 1000) n`);
    await db.execute(sql`
      insert into suggestions (kind, source_ref, status, result_type, payload, normalised_text, proposed_by)
      select 'decision', 'session:' || ((n - 1) % 1000 + 1),
        case when n % 2 = 0 then 'approved'::suggestion_status else 'pending'::suggestion_status end,
        'decision', '{}', 'Sample ' || n, 'Claude'
      from generate_series(1, 10000) n`);
    await db.execute(sql`analyze cowork_sessions`);
    await db.execute(sql`analyze suggestions`);
    const spy = vi.spyOn(pool, "query");
    const views = await listSessions();
    expect(views).toHaveLength(300);
    const call = spy.mock.calls.find((args) => {
      const q = args[0] as unknown as { text?: string };
      return q.text?.includes("with page as materialized");
    })!;
    const query = call[0] as unknown as { text: string };
    const result = await pool.query(`explain (analyze, buffers, format json) ${query.text}`, call[1] as unknown as unknown[]);
    const plan = result.rows[0]["QUERY PLAN"];
    // No per-session correlated subplan remains for suggestion counts.
    expect(JSON.stringify(plan)).not.toMatch(/SubPlan.*suggestions/);
    const indexes = await db.execute(sql`select indexname from pg_indexes where indexname in (
      'suggestions_source_status_result_idx', 'ask_threads_parent_created_idx',
      'tasks_gmail_thread_idx', 'audit_events_ai_batch_idx', 'ai_activity_groups_recent_idx')`);
    expect(indexes.rows).toHaveLength(5);
    const directory = resolve(process.cwd(), "../../generated-artifacts");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "data-layer-session-plan.json"), JSON.stringify({
      fixture: { sessions: 1000, suggestions: 10000, pageSize: 300 },
      plan, indexes: indexes.rows,
    }, null, 2));
  });
});
