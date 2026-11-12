import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, documentContentsTable, documentsTable, meetingBriefsTable, peopleTable, suggestionsTable, tasksTable } from "@workspace/db";
import { cleanDriveLink, driveFileId, isDocument } from "../src/services/connectors/drive";
import { toMeetingNote, wasInMeeting, type GranolaNote } from "../src/services/connectors/granola";
import { readByNow } from "../src/services/connectors";
import { loadVisibleDocs } from "../src/lib/ai-data/retrieve";
import { searchItems } from "../src/lib/ai-data/search";
import { api, ingest, OLLIE, useServer } from "./harness";
import { client, project, scopeFor } from "./helpers";

/* A fake Drive and Granola behind the connector proxy. */
let files: Record<string, Record<string, unknown>> = {};
let exportsText: Record<string, string> = {};
let recent: Record<string, unknown>[] = [];
let exported: string[] = [];
let notesList: { id: string; updated_at: string }[] = [];
let notes: Record<string, GranolaNote> = {};
/** What the fake Haiku says: by file id for Drive, and one answer for each meeting. */
let verdicts: Record<string, { project: string; summary: string; confidential: boolean }> = {};
let meetingAnswer: Record<string, unknown> = {};
let judgedFiles: string[][] = [];

vi.mock("../src/services/connectors/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/http")>();
  const json = (path: string): Record<string, unknown> | null => {
    const url = new URL("https://x" + path);
    if (url.pathname === "/drive/v3/about") return { user: { emailAddress: OLLIE } };
    if (url.pathname === "/drive/v3/files") return { files: recent };
    const f = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (f) return files[decodeURIComponent(f[1])] ?? null;
    if (url.pathname === "/v1/notes") return { notes: notesList, hasMore: false, cursor: null };
    const n = /^\/v1\/notes\/([^/]+)$/.exec(url.pathname);
    if (n) return (notes[decodeURIComponent(n[1])] as unknown as Record<string, unknown>) ?? null;
    throw new Error("Unexpected path " + path);
  };
  return {
    ...real,
    proxyJson: async (_c: string, _n: string, path: string) => json(path) ?? {},
    proxyJsonOrNull: async (_c: string, _n: string, path: string) => json(path),
    proxyText: async (_c: string, _n: string, path: string, max: number) => {
      const id = decodeURIComponent(/\/files\/([^/]+)\/export/.exec(path)![1]);
      exported.push(id);
      const t = exportsText[id];
      return t == null ? null : { text: t.slice(0, max), truncated: t.length > max };
    },
  };
});
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    if (content.startsWith("<files>")) {
      const ids = [...content.matchAll(/<file id="([^"]+)">/g)].map((m) => m[1]);
      judgedFiles.push(ids);
      return { results: ids.filter((id) => verdicts[id]).map((id) => ({ file: id, ...verdicts[id] })) };
    }
    return meetingAnswer;
  },
}));
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
}));
vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  draftCheckInFromDocs: async () => ({ text: "Hi", refs: [] }),
  writeBriefFromDocs: async () => ({ why: [], questions: [], questionsNote: "" }),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

const DOC = "application/vnd.google-apps.document";

describe("Drive links", () => {
  it("finds the file id in Docs and Drive links, but not folders", () => {
    expect(driveFileId("https://docs.google.com/document/d/1AbCdEfGhIjK_lm/edit?usp=sharing")).toBe("1AbCdEfGhIjK_lm");
    expect(driveFileId("https://drive.google.com/file/d/1AbCdEfGhIjK_lm/view")).toBe("1AbCdEfGhIjK_lm");
    expect(driveFileId("https://drive.google.com/open?id=1AbCdEfGhIjK_lm")).toBe("1AbCdEfGhIjK_lm");
    expect(driveFileId("https://drive.google.com/drive/folders/1AbCdEfGhIjK_lm")).toBeNull();
    expect(driveFileId("https://www.dropbox.com/s/abc/plan.pdf")).toBeNull();
    expect(cleanDriveLink("https://docs.google.com/document/d/1AbCdEfGhIjK_lm/edit?usp=drivesdk")).toBe("https://docs.google.com/document/d/1AbCdEfGhIjK_lm/edit");
  });

  it("treats pictures, video and folders as not documents", () => {
    expect(isDocument(DOC)).toBe(true);
    expect(isDocument("application/pdf")).toBe(true);
    expect(isDocument("image/png")).toBe(false);
    expect(isDocument("application/vnd.google-apps.folder")).toBe(false);
  });
});

describe("Google Drive check", () => {
  it("reads Library documents, suggests project files once, and never re-reads unchanged files", async () => {
    const launch = await project("Spring Launch");
    const [lib] = await db.insert(documentsTable).values({ title: "Google Doc", url: "https://docs.google.com/document/d/LIBRARY_DOC_1/edit", location: "gdrive", createdBy: "ollie" }).returning();
    files = { LIBRARY_DOC_1: { id: "LIBRARY_DOC_1", name: "Launch plan", mimeType: DOC, modifiedTime: "2026-11-09T10:00:00Z" } };
    exportsText = { LIBRARY_DOC_1: "The launch moves to the 14th of March because of the venue.", NEW_DOC_1: "Budget lines for the launch." };
    recent = [
      { id: "NEW_DOC_1", name: "Launch budget", mimeType: DOC, webViewLink: "https://docs.google.com/document/d/NEW_DOC_1/edit?usp=drivesdk", viewedByMeTime: "2026-11-10T09:00:00Z" },
      { id: "NEW_DOC_2", name: "Lunch order", mimeType: DOC, webViewLink: "https://docs.google.com/document/d/NEW_DOC_2/edit", viewedByMeTime: "2026-11-10T08:00:00Z" },
      { id: "PIC", name: "photo.png", mimeType: "image/png", webViewLink: "https://drive.google.com/file/d/PIC/view", viewedByMeTime: "2026-11-10T08:00:00Z" },
      { id: "LIBRARY_DOC_1", name: "Launch plan", mimeType: DOC, webViewLink: "https://docs.google.com/document/d/LIBRARY_DOC_1/edit", viewedByMeTime: "2026-11-10T07:00:00Z" },
    ];
    verdicts = { NEW_DOC_1: { project: "Spring Launch", summary: "Budget for the spring launch.", confidential: false } };
    judgedFiles = [];
    exported = [];

    const check = await api("connectors/drive/check", { method: "POST" });
    expect(check.body).toMatchObject({ ok: true, found: 4, account: OLLIE });
    expect(check.body.counts).toMatchObject({ recent: 4, suggested: 1, known: 1, read: 1, left_out: 1 });
    expect(judgedFiles).toEqual([["NEW_DOC_1", "NEW_DOC_2"]]);

    // The Library document has its text and its real name now.
    const [doc] = await db.select().from(documentsTable).where(eq(documentsTable.id, lib.id));
    expect(doc.title).toBe("Launch plan");
    const [content] = await db.select().from(documentContentsTable);
    expect(content).toMatchObject({ documentId: lib.id, fileId: "LIBRARY_DOC_1", text: "The launch moves to the 14th of March because of the venue." });

    // One suggestion, on the project, with a clean link.
    const sugg = await db.select().from(suggestionsTable);
    expect(sugg).toHaveLength(1);
    expect(sugg[0]).toMatchObject({ kind: "document", status: "pending", proposedBy: "OllieOS", sourceType: "document" });
    expect(sugg[0].payload).toMatchObject({ url: "https://docs.google.com/document/d/NEW_DOC_1/edit", title: "Launch budget", project_ids: [launch.id] });

    // Ask and briefs can read the contents; search finds the document by a word inside it.
    const scope = await scopeFor(await client("Claude"));
    const [aiDoc] = await loadVisibleDocs(scope, [`document:${lib.id}`]);
    expect(aiDoc.text).toContain("The launch moves to the 14th of March");
    const hits = await searchItems({ q: "venue", mode: "ask", visibleOnly: true, scope, limitPerType: 5 });
    expect(hits.map((h) => [h.type, h.id])).toContainEqual(["document", lib.id]);

    // The next check judges nothing again and leaves the unchanged file alone.
    exported = [];
    judgedFiles = [];
    const again = await api("connectors/drive/check", { method: "POST" });
    expect(again.body.counts).toMatchObject({ suggested: 0, read: 0 });
    expect(judgedFiles).toEqual([]);
    expect(exported).toEqual([]);

    // A changed file is read again.
    files.LIBRARY_DOC_1.modifiedTime = "2026-11-10T12:00:00Z";
    exportsText.LIBRARY_DOC_1 = "The launch is back to the 7th of March.";
    const third = await api("connectors/drive/check", { method: "POST" });
    expect(third.body.counts.read).toBe(1);
    const [content2] = await db.select().from(documentContentsTable);
    expect(content2.text).toBe("The launch is back to the 7th of March.");
  });

  it("keeps a confidential file's suggestion hidden from AI and its document confidential", async () => {
    await project("Board pack");
    files = {};
    recent = [{ id: "SECRET_DOC", name: "Bonus scheme draft", mimeType: DOC, webViewLink: "https://docs.google.com/document/d/SECRET_DOC/edit", viewedByMeTime: "2026-11-10T09:00:00Z" }];
    exportsText = {};
    verdicts = { SECRET_DOC: { project: "Board pack", summary: "Draft bonus scheme.", confidential: true } };
    await api("connectors/drive/check", { method: "POST" });
    const [s] = await db.select().from(suggestionsTable);
    expect(s.payload).toMatchObject({ confidential: true });
    const ok = await api(`suggestions/${s.id}/approve`, { body: {} });
    expect(ok.status).toBeLessThan(300);
    const [d] = await db.select().from(documentsTable);
    expect(d.confidential).toBe(true);
  });
});

const note = (o: Partial<GranolaNote> & { id: string }): GranolaNote => ({
  title: "Spring Launch sync",
  owner: { name: "James Pritchard", email: "james@springpod.com" },
  created_at: "2026-11-10T10:30:00Z",
  updated_at: "2026-11-10T10:45:00Z",
  web_url: `https://notes.granola.ai/d/${o.id}`,
  calendar_event: null,
  attendees: [],
  summary_markdown: "Ollie to send the venue contract. Sam will send the guest list. Decided to move the launch to March.",
  ...o,
});

describe("Granola notes", () => {
  it("only uses notes from meetings Ollie was in", () => {
    const me = new Set([OLLIE]);
    expect(wasInMeeting(note({ id: "a" }), me)).toBe(false);
    expect(wasInMeeting(note({ id: "b", owner: { email: OLLIE } }), me)).toBe(true);
    expect(wasInMeeting(note({ id: "c", attendees: [{ email: OLLIE.toUpperCase() }] }), me)).toBe(true);
    expect(wasInMeeting(note({ id: "d", calendar_event: { invitees: [{ email: OLLIE }] } }), me)).toBe(true);
    const m = toMeetingNote(note({ id: "e", attendees: [{ name: "Sam Lee", email: "sam@client.com" }, { email: OLLIE }], private_notes_markdown: "Chase legal." }), me);
    expect(m.people).toEqual([{ name: "Sam Lee", email: "sam@client.com" }]);
    expect(m.notes).toContain("Ollie's own notes:\nChase legal.");
  });

  it("captures actions and decisions from Ollie's meetings, attaches notes to the brief, then takes over from Claude", async () => {
    const launch = await project("Spring Launch");
    const [sam] = await db.insert(peopleTable).values({ name: "Sam Lee", slug: "sam-lee", email: "sam@client.com" }).returning();
    const [event] = await db
      .insert(calendarEventsTable)
      .values({ sourceRef: "gcal_evt_1", title: "Spring Launch sync", startsAt: new Date("2026-11-10T10:00:00Z"), endsAt: new Date("2026-11-10T10:30:00Z"), attendees: ["Sam Lee"], personIds: [sam.id], projectId: launch.id })
      .returning();

    // A colleague's notes from a meeting Ollie was not in: left out, and Claude keeps the feed.
    notesList = [{ id: "not_mine", updated_at: "2026-11-10T09:00:00Z" }];
    notes = { not_mine: note({ id: "not_mine" }) };
    const first = await api("connectors/granola/check", { method: "POST" });
    expect(first.body).toMatchObject({ ok: true, found: 1 });
    expect(first.body.counts).toMatchObject({ meetings: 0, left_out: 1 });
    expect(await readByNow("granola")).toBe("claude");

    notesList = [...notesList, { id: "mine", updated_at: "2026-11-10T10:45:00Z" }];
    notes.mine = note({
      id: "mine",
      attendees: [{ name: "Sam Lee", email: "sam@client.com" }, { name: "Ollie", email: OLLIE }],
      calendar_event: { calendar_event_id: "gcal_evt_1", scheduled_start_time: "2026-11-10T10:00:00Z" },
    });
    const ref = "granola:mine";
    meetingAnswer = {
      summary: "Spring Launch sync with Sam",
      project: "",
      items: [
        { ref, type: "task", title: "Send the venue contract", action: "Send it to Sam.", priority: "medium", due: "", project: "", person: "Sam Lee", quote: "Ollie to send the venue contract.", confidential: false },
        { ref, type: "waiting", title: "Sam to send the guest list", action: "Chase Sam if it has not come.", priority: "medium", due: "", project: "", person: "Sam Lee", quote: "Sam will send the guest list.", confidential: false },
      ],
      decisions: [{ text: "Move the launch to March", project: "", confidential: false }],
    };
    const second = await api("connectors/granola/check", { method: "POST" });
    expect(second.body.counts).toMatchObject({ meetings: 1, inbox: 1, waiting: 1, decisions: 1, attached: 1, activity: 1 });

    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks.map((t) => [t.title, t.source, t.sourceRef, t.projectId])).toEqual([
      ["Send the venue contract", "meeting", "granola:mine", launch.id],
      ["Sam to send the guest list", "meeting", "granola:mine#2", launch.id],
    ]);
    expect(tasks[0]).toMatchObject({ personId: sam.id, createdBy: "ollieos", sourceUrl: "https://notes.granola.ai/d/mine" });
    expect(tasks[1]).toMatchObject({ waitingOnPersonId: sam.id });

    const [decision] = await db.select().from(suggestionsTable);
    expect(decision).toMatchObject({ kind: "decision", entityType: "project", entityId: launch.id, sourceType: "meeting" });

    const [brief] = await db.select().from(meetingBriefsTable).where(eq(meetingBriefsTable.calendarEventId, event.id));
    expect(brief.granolaRef).toBe("mine");
    expect(brief.granolaNotes).toContain("venue contract");
    expect(brief.actionTaskIds.sort()).toEqual(tasks.map((t) => t.id).sort());

    // Each note is read once.
    const third = await api("connectors/granola/check", { method: "POST" });
    expect(third.body).toMatchObject({ found: 0 });

    // OllieOS now reads Granola, so Claude's meeting items are refused.
    expect(await readByNow("granola")).toBe("ollieos");
    const refused = await ingest("tasks", { body: [{ source: "meeting", source_ref: "claude-m", title: "From Claude" }] });
    expect(refused.body.results[0].outcome).toBe("ignored");
    const notesRefused = await ingest("meeting-notes", { body: { calendar_source_ref: "gcal_evt_1", granola_ref: "x", notes: "Notes" } });
    expect(notesRefused.body).toMatchObject({ ignored: true });
  });

  it("links a note to a meeting with no brief, by time and people when Granola has no calendar link", async () => {
    const at = (iso: string, mins: number) => ({ startsAt: new Date(iso), endsAt: new Date(new Date(iso).getTime() + mins * 60_000) });
    const [huddle] = await db
      .insert(calendarEventsTable)
      .values({ sourceRef: "gcal_huddle", title: "Huddle", ...at("2026-11-11T14:00:00Z", 30), attendees: ["Pat"], attendeeDetails: [{ name: "Pat", email: "pat@gmail.com" }] })
      .returning();
    // Same time, nobody in common and a different title: never picked.
    const [other] = await db
      .insert(calendarEventsTable)
      .values({ sourceRef: "gcal_other", title: "Something else", ...at("2026-11-11T14:00:00Z", 30), attendees: ["Lee"], attendeeDetails: [{ name: "Lee", email: "lee@gmail.com" }] })
      .returning();

    notesList = [{ id: "nolink", updated_at: "2026-11-11T14:40:00Z" }];
    notes = {
      nolink: note({
        id: "nolink",
        title: "Quick chat",
        owner: { email: OLLIE },
        attendees: [{ name: "Pat", email: "pat@gmail.com" }, { email: OLLIE }],
        calendar_event: { scheduled_start_time: "2026-11-11T14:05:00Z" },
        summary_markdown: "## Next steps\n- Pat to share the deck",
      }),
    };
    meetingAnswer = {
      summary: "Quick chat with Pat",
      project: "",
      items: [{ ref: "granola:nolink", type: "task", title: "Read Pat's deck", action: "Read it.", priority: "medium", due: "", project: "", person: "", quote: "Pat to share the deck", confidential: false }],
      decisions: [],
    };
    const r = await api("connectors/granola/check", { method: "POST" });
    expect(r.body.counts).toMatchObject({ meetings: 1, attached: 1 });

    const [row] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, huddle.id));
    expect(row).toMatchObject({ granolaRef: "nolink", granolaUrl: "https://notes.granola.ai/d/nolink" });
    expect(row.granolaAttachedAt).not.toBeNull();
    expect(await db.select().from(meetingBriefsTable)).toHaveLength(0);
    const [untouched] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, other.id));
    expect(untouched.granolaRef).toBeNull();

    const v = (await api(`meetings/${huddle.id}`)).body;
    expect(v.prep).toBe("none");
    expect(v.granola).toMatchObject({ url: "https://notes.granola.ai/d/nolink" });
    expect(v.granola.notes).toContain("Pat to share the deck");
    expect(v.granola.actions.map((t: { title: string }) => t.title)).toEqual(["Read Pat's deck"]);
    expect(v.granolaCheck).toBe(true);
    expect((await api("meetings/" + other.id)).body.granola).toBeNull();
  });

  it("links a note by hand from its share link, reading it in full when new and only attaching it when already read", async () => {
    const uuid = "543b3d5d-2f20-4b57-bf53-f6a012506085";
    const [ev] = await db
      .insert(calendarEventsTable)
      .values({ sourceRef: "gcal_scoping", title: "Studio Signals Data - Scoping", startsAt: new Date("2026-11-12T11:00:00Z"), endsAt: new Date("2026-11-12T11:45:00Z"), attendees: ["Kurt"] })
      .returning();
    // Granola's API knows the note by its own id; the share link only carries the meeting's UUID.
    notesList = [{ id: "not_scope1", updated_at: "2026-11-12T12:06:59Z" }];
    notes = {
      not_scope1: note({ id: "not_scope1", title: "Studio Signals Data - Scoping", owner: { email: OLLIE }, web_url: `https://notes.granola.ai/d/${uuid}`, summary_markdown: "Oliver to add screen views to Studio." }),
    };
    meetingAnswer = {
      summary: "Data scoping",
      project: "",
      items: [{ ref: "granola:not_scope1", type: "task", title: "Add screen views to Studio", action: "Add them.", priority: "medium", due: "", project: "", person: "", quote: "Oliver to add screen views", confidential: false }],
      decisions: [],
    };

    expect((await api(`meetings/${ev.id}/granola`, { body: { link: "https://example.com/nothing" } })).status).toBe(400);
    const r = await api(`meetings/${ev.id}/granola`, { body: { link: `https://notes.granola.ai/t/${uuid}-008umkv4` } });
    expect(r.status).toBe(200);
    expect(r.body.granola).toMatchObject({ url: `https://notes.granola.ai/d/${uuid}` });
    expect(r.body.granola.actions.map((t: { title: string }) => t.title)).toEqual(["Add screen views to Studio"]);

    // Remembered as read: the next check does not read it again or make the task twice.
    const check = await api("connectors/granola/check", { method: "POST" });
    expect(check.body.found).toBe(0);
    expect(await db.select().from(tasksTable)).toHaveLength(1);

    // Linking the same, already read note to another meeting moves it, with the task it made, and reads nothing.
    const [other] = await db
      .insert(calendarEventsTable)
      .values({ sourceRef: "gcal_other2", title: "Follow-up", startsAt: new Date("2026-11-12T13:00:00Z"), endsAt: new Date("2026-11-12T13:30:00Z") })
      .returning();
    const moved = await api(`meetings/${other.id}/granola`, { body: { link: "not_scope1" } });
    expect(moved.body.granola.actions).toHaveLength(1);
    expect((await api(`meetings/${ev.id}`)).body.granola).toBeNull();
    expect(await db.select().from(tasksTable)).toHaveLength(1);

    expect((await api(`meetings/${ev.id}/granola`, { body: { link: "not_missing" } })).status).toBe(404);
  });
});
