import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, documentContentsTable, documentsTable, knowledgeSourcesTable, suggestionsTable } from "@workspace/db";
import { changedLines, type Extracted } from "../src/services/documents/knowledge";
import { readWaiting } from "../src/services/documents/reader";
import { readDropbox, type DropboxEntry } from "../src/services/connectors/dropbox";
import { api, call, connect, mcp, useServer } from "./harness";
import { person, project } from "./helpers";

/* What the fake model finds, and what it was sent. */
let extract: Extracted;
let sent: string[] = [];

const nothing = (): Extracted => ({ summary: "A document.", confidential: false, projects: [], facts: [], decisions: [], people: [], organisations: [], playbooks: [], relationships: [] });

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  modelJson: async (_model: string, _system: string, content: string) => {
    sent.push(content);
    return extract;
  },
}));
vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  draftCheckInFromDocs: async () => ({ text: "Hi", refs: [] }),
  writeBriefFromDocs: async () => ({ why: [], questions: [], questionsNote: "" }),
  digestSummaryFromLines: async () => "Summary.",
}));

/* A fake Dropbox: entries in the folder, file text by path or "rev:<rev>". */
let entries: DropboxEntry[] = [];
let texts: Record<string, string> = {};

vi.mock("../src/services/connectors/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/http")>();
  return {
    ...real,
    proxyReadPost: async (_c: string, _n: string, path: string, body: { path?: string }) => {
      if (path === "/2/users/get_current_account") return { email: "ollie@example.com" };
      if (path === "/2/files/list_folder") return body.path === "/Claude" ? { entries, has_more: false } : null;
      if (path === "/2/files/get_temporary_link") return texts[body.path!] == null ? null : { link: "https://dl.test/" + encodeURIComponent(body.path!) };
      throw new Error("Unexpected Dropbox path " + path);
    },
  };
});

const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://dl.test/")) {
      const t = texts[decodeURIComponent(url.slice("https://dl.test/".length))];
      return t == null ? new Response("", { status: 404 }) : new Response(t);
    }
    return realFetch(input, init);
  });
});
afterAll(() => void vi.unstubAllGlobals());

useServer();

beforeEach(() => {
  extract = nothing();
  sent = [];
  entries = [];
  texts = {};
});

const file = (name: string, hash: string, rev: string): DropboxEntry => ({
  ".tag": "file",
  name,
  path_lower: `/claude/${name.toLowerCase()}`,
  path_display: `/Claude/${name}`,
  content_hash: hash,
  rev,
  size: 100,
  server_modified: "2026-11-09T10:00:00Z",
});

async function suggestions() {
  return db.select().from(suggestionsTable).orderBy(suggestionsTable.id);
}

describe("changed lines", () => {
  it("is empty when nothing was added, and shows new lines with the line before them", () => {
    expect(changedLines("a\nb\nc", "a\nb\nc")).toBe("");
    expect(changedLines("a\nb\nc", "c\na")).toBe("");
    expect(changedLines("Intro\nOld plan", "Intro\nOld plan\nNew owner is Sam")).toBe("  Old plan\n+ New owner is Sam");
    expect(changedLines("one\ntwo", "ONE\n  two  ")).toBe("");
  });
});

describe("pasted text", () => {
  it("keeps the text, reads it for knowledge and cites the document on every suggestion", async () => {
    const apollo = await project("Apollo");
    const r = await api("documents/text", { body: { title: "Apollo plan", text: "Apollo launches in March.\nSam owns it.", buildKnowledge: true } });
    expect(r.status).toBe(201);
    expect(r.body.url).toBeNull();
    expect(r.body.location).toBe("ollieos");
    expect(r.body.textOrigin).toBe("pasted");
    expect(r.body.knowledge.status).toBe("queued");
    const id = r.body.id as number;

    extract = {
      ...nothing(),
      projects: ["Apollo"],
      facts: [
        { about: "Apollo", text: "Apollo launches in March 2027.", attribute: "" },
        { about: "Someone New", text: "Someone New likes tea.", attribute: "" },
      ],
      decisions: [{ project: "Apollo", topic: "Launch", text: "Launch Apollo in March.", decided_on: "2026-11-01", decided_by: "Ollie" }],
      people: [{ name: "Sam Owner", email: "", role: "Project lead", organisation: "", relationship: "Runs Apollo." }],
      playbooks: [{ title: "Apollo tone", applies_when: "Writing about Apollo", rule: "Keep it short.", project: "Apollo" }],
    };
    expect(await readWaiting(5)).toBe(1);
    expect(sent[0]).toContain("Apollo launches in March.");

    const rows = await suggestions();
    expect(rows.map((s) => s.kind).sort()).toEqual(["decision", "document", "fact", "person", "playbook"]);
    for (const s of rows) {
      expect(s.proposedBy).toBe("Document reader");
      expect(s.sourceRef).toBe(`document:${id}`);
      expect(s.sourceLabel).toBe("Library: Apollo plan");
    }
    // The fact about someone OllieOS does not know waits; the link suggestion names the project.
    expect(rows.find((s) => s.kind === "fact")!.entityId).toBe(apollo.id);
    expect((rows.find((s) => s.kind === "document")!.payload as { document_id: number }).document_id).toBe(id);

    const doc = await api(`documents`);
    const view = (doc.body as unknown as { id: number; knowledge: { status: string; lastResult: string } }[]).find((d) => d.id === id)!;
    expect(view.knowledge.status).toBe("idle");
    expect(view.knowledge.lastResult).toMatch(/fact/);

    const inbox = await api("suggestions?origin=documents");
    expect(inbox.body.counts.documents).toBe(5);
    expect(inbox.body.items.every((i: { fromDocument: string }) => i.fromDocument === `document:${id}`)).toBe(true);
    expect(inbox.body.items.some((i: { kind: string }) => i.kind === "document_link")).toBe(true);

    // Reading again with nothing changed does not ask the model.
    await api(`documents/${id}/knowledge`, { method: "POST" });
    expect(await readWaiting(5)).toBe(1);
    expect(sent).toHaveLength(1);

    const rej = await api("suggestions/reject-source", { body: { sourceRef: `document:${id}` } });
    expect(rej.body.rejected).toBe(5);
    expect((await api("suggestions?origin=documents")).body.items).toHaveLength(0);
  });

  it("only brings decisions, marked confidential, from a confidential document", async () => {
    await project("Apollo");
    const r = await api("documents/text", { body: { title: "Board paper", text: "Board notes.", buildKnowledge: true } });
    extract = {
      ...nothing(),
      confidential: true,
      facts: [{ about: "Apollo", text: "Apollo is for sale.", attribute: "" }],
      decisions: [{ project: "Apollo", topic: "Sale", text: "Go ahead with the sale.", decided_on: "", decided_by: "" }],
      people: [{ name: "A Buyer", email: "", role: "", organisation: "", relationship: "" }],
    };
    await readWaiting(1);
    const rows = await suggestions();
    expect(rows.map((s) => s.kind)).toEqual(["decision"]);
    expect((rows[0].payload as { confidential: boolean }).confidential).toBe(true);
    expect(r.body.id).toBeGreaterThan(0);
  });

  it("does not fill what OllieOS already has for a known person", async () => {
    await person("Sam Owner", { role: "Head of sales" });
    await api("documents/text", { body: { title: "Notes", text: "Sam is lead.", buildKnowledge: true } });
    extract = { ...nothing(), people: [{ name: "Sam Owner", email: "", role: "Project lead", organisation: "", relationship: "" }] };
    await readWaiting(1);
    expect(await suggestions()).toHaveLength(0);
  });

  it("refuses to read a document hidden from AI", async () => {
    const r = await api("documents/text", { body: { title: "Private", text: "Secret.", confidential: true } });
    const k = await api(`documents/${r.body.id}/knowledge`, { method: "POST" });
    expect(k.status).toBe(400);
    expect(await readWaiting(5)).toBe(0);
  });
});

describe("uploads", () => {
  it("keeps the text of a Markdown file and refuses other kinds", async () => {
    const ok = await api("documents/upload", { body: { fileName: "Team notes.md", dataBase64: Buffer.from("# Team\n\nWe meet on Mondays.").toString("base64") } });
    expect(ok.status).toBe(201);
    expect(ok.body.title).toBe("Team notes");
    expect(ok.body.textOrigin).toBe("upload");
    expect(ok.body.knowledge).toBeNull();
    const [kept] = await db.select().from(documentContentsTable).where(eq(documentContentsTable.documentId, ok.body.id));
    expect(kept.text).toContain("We meet on Mondays.");

    const bad = await api("documents/upload", { body: { fileName: "tool.exe", dataBase64: Buffer.from("x").toString("base64") } });
    expect(bad.status).toBe(400);
  });
});

describe("Claude's save_document", () => {
  it("goes through approval, then keeps the text and reads it", async () => {
    const c = await mcp((await connect()).access_token);
    const out = await call(c, "save_document", { title: "Q1 plan", content: "Plan for the first quarter.", kind: "plan" });
    expect(out.isError).toBeFalsy();
    await c.close();
    expect(await db.select().from(documentsTable)).toHaveLength(0);

    const [s] = await suggestions();
    expect(s.kind).toBe("document");
    const ok = await api(`suggestions/${s.id}/approve`, { body: {} });
    expect(ok.status).toBe(200);
    const [doc] = await db.select().from(documentsTable);
    expect(doc.url).toBeNull();
    expect(doc.title).toBe("Q1 plan");
    const [kept] = await db.select().from(documentContentsTable).where(eq(documentContentsTable.documentId, doc.id));
    expect(kept.origin).toBe("claude");
    expect(await readWaiting(1)).toBe(1);
    expect(sent[0]).toContain("Plan for the first quarter.");
  });
});

describe("Dropbox", () => {
  const now = new Date("2026-11-10T10:00:00Z");

  it("notes what is there at first, then reads only what changed", async () => {
    entries = [file("Plan.md", "h1", "r1"), file("Notes.txt", "h2", "r2"), file("Photo.png", "h3", "r3")];
    const first = await readDropbox({ folder: "/Claude", existing: "new", listed: false }, now);
    expect(first.counts).toMatchObject({ files: 2, added: 2, queued: 0, left_out: 1 });
    expect(first.state.listed).toBe(true);
    expect(await readWaiting(5)).toBe(0);

    // Plan.md changes: the old version is fetched so only the new line goes to the model.
    texts = { "rev:r1": "Goals\nShip Apollo", "/Claude/Plan.md": "Goals\nShip Apollo\nHire a designer" };
    entries = [file("Plan.md", "h1b", "r1b"), file("Notes.txt", "h2", "r2")];
    const second = await readDropbox(first.state, now);
    expect(second.counts).toMatchObject({ files: 2, added: 0, changed: 1, queued: 1, removed: 0 });
    expect(await readWaiting(5)).toBe(1);
    expect(sent[0]).toContain("<changed>\n  Ship Apollo\n+ Hire a designer\n</changed>");

    // Deleted files are forgotten.
    entries = [file("Plan.md", "h1b", "r1b")];
    const third = await readDropbox(second.state, now);
    expect(third.counts.removed).toBe(1);
    const rows = await db.select().from(knowledgeSourcesTable);
    expect(rows.map((r) => r.path)).toEqual(["/Claude/Plan.md"]);
    expect(rows[0].status).toBe("idle");
  });

  it("reads everything once when asked, citing the Dropbox file", async () => {
    entries = [file("Plan.md", "h1", "r1")];
    texts = { "/Claude/Plan.md": "Apollo launches in March." };
    const first = await readDropbox({ folder: "/Claude", existing: "all", listed: false }, now);
    expect(first.counts.queued).toBe(1);
    await project("Apollo");
    extract = { ...nothing(), facts: [{ about: "Apollo", text: "Apollo launches in March.", attribute: "" }] };
    await readWaiting(1);
    const [s] = await suggestions();
    expect(s.sourceRef).toBe("dropbox:/claude/plan.md");
    expect(s.sourceLabel).toBe("Dropbox: /Claude/Plan.md");
    expect(s.sourceUrl).toContain("dropbox.com/home/Claude?preview=Plan.md");
  });

  it("counts readable files for the folder preview, and says when the folder is missing", async () => {
    entries = [file("Plan.md", "h1", "r1"), file("Photo.png", "h3", "r3")];
    const ok = await api("connectors/dropbox/preview", { body: { folder: "Claude/" } });
    expect(ok.body).toEqual({ folder: "/Claude", readable: 1, other: 1 });
    const missing = await api("connectors/dropbox/preview", { body: { folder: "/Nowhere" } });
    expect(missing.status).toBe(400);
  });

  it("marks a file that is gone as failed, and tries it again on request", async () => {
    entries = [file("Plan.md", "h1", "r1")];
    await readDropbox({ folder: "/Claude", existing: "all", listed: false }, now);
    await readWaiting(1);
    const [row] = await db.select().from(knowledgeSourcesTable);
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/no longer in Dropbox/);
    const retry = await api("connectors/dropbox/retry", { body: {} });
    expect(retry.body.dropbox.progress).toMatchObject({ waiting: 1, failed: 0 });
  });
});
