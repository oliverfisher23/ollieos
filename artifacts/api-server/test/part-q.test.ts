/**
 * Part Q (build plan section 19): connector warnings, and Library documents someone else changed,
 * in the digest and the weekly round-up.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appSettingsTable, calendarEventsTable, connectorRunsTable, db, documentChangesTable, documentsTable, linksTable, productsTable, type ConnectorRun } from "@workspace/db";
import { todayLondon } from "@workspace/shared";
import { DEFAULT_SCHEDULE } from "../src/services/connectors";
import { connectorWarnings, failingWarning, windowMsBetween } from "../src/services/connectorHealth";
import { buildDigest } from "../src/services/digest";
import { changedDocuments, lineDiff, recordDocumentChange } from "../src/services/documentChanges";
import { buildRoundupContent, roundupEmail } from "../src/services/roundup";
import { api, OLLIE, useServer } from "./harness";
import { project } from "./helpers";

/* A fake Drive behind the connector proxy. */
let files: Record<string, Record<string, unknown>> = {};
let exportsText: Record<string, string> = {};
let changeLines: string[] = [];

vi.mock("../src/services/connectors/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/http")>();
  const json = (path: string): Record<string, unknown> | null => {
    const url = new URL("https://x" + path);
    if (url.pathname === "/drive/v3/about") return { user: { emailAddress: OLLIE } };
    if (url.pathname === "/drive/v3/files") return { files: [] };
    const f = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (f) return files[decodeURIComponent(f[1])] ?? null;
    throw new Error("Unexpected path " + path);
  };
  return {
    ...real,
    proxyJson: async (_c: string, _n: string, path: string) => json(path) ?? {},
    proxyJsonOrNull: async (_c: string, _n: string, path: string) => json(path),
    proxyText: async (_c: string, _n: string, path: string, max: number) => {
      const id = decodeURIComponent(/\/files\/([^/]+)\/export/.exec(path)![1]);
      const t = exportsText[id];
      return t == null ? null : { text: t.slice(0, max), truncated: t.length > max };
    },
  };
});
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    if (content.startsWith("Document:")) {
      changeLines.push(content);
      return { line: "Launch moves from 14th to 7th March." };
    }
    return { results: [] };
  },
}));
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
}));
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

const HOUR = 3600_000;
const DAY = 86_400_000;
const DOC = "application/vnd.google-apps.document";

function run(o: Partial<ConnectorRun> & { startedAt: Date }): ConnectorRun {
  return { id: 0, connector: "granola", trigger: "timer", finishedAt: new Date(o.startedAt.getTime() + 60_000), ok: true, found: 0, counts: {}, account: null, error: null, ...o } as ConnectorRun;
}

async function insertRuns(connector: string, rows: { at: Date; ok: boolean; found?: number; counts?: Record<string, number>; error?: string }[]) {
  await db.insert(connectorRunsTable).values(
    rows.map((r) => ({ connector, trigger: "timer", startedAt: r.at, finishedAt: new Date(r.at.getTime() + 60_000), ok: r.ok, found: r.found ?? 0, counts: r.counts ?? {}, error: r.error ?? null })),
  );
}

async function readByOllieOS(...keys: string[]) {
  const value = { readBy: Object.fromEntries(keys.map((k) => [k, "ollieos"])) };
  await db.insert(appSettingsTable).values({ key: "connectors", value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value } });
}

describe("connector warnings", () => {
  it("counts only time inside the weekday checking window", () => {
    // Friday 13th November 17:00 to Monday 16th November 09:00 London (GMT): 2 hours on Friday, 2 on Monday.
    const ms = windowMsBetween(new Date("2026-11-13T17:00:00Z"), new Date("2026-11-16T09:00:00Z"), DEFAULT_SCHEDULE);
    expect(ms).toBe(4 * HOUR);
  });

  it("warns after 3 failed checks and 4 working hours without a good one, whichever is later", () => {
    const good = run({ startedAt: new Date("2026-11-11T08:00:00Z") });
    const fail = (h: number, error = "Granola refused the key.") => run({ startedAt: new Date(`2026-11-11T${String(h).padStart(2, "0")}:00:00Z`), ok: false, error });
    // Newest first, as the checks are read.
    const runs = [fail(11), fail(10), fail(9), good];
    // Three failures, but only 2 working hours since the good check.
    expect(failingWarning("granola", runs, DEFAULT_SCHEDULE, new Date("2026-11-11T10:05:00Z"))).toBeNull();
    // Over 4 working hours, three failures.
    const w = failingWarning("granola", runs, DEFAULT_SCHEDULE, new Date("2026-11-11T12:30:00Z"));
    expect(w).toMatchObject({ key: "granola", kind: "failing" });
    expect(w!.text).toBe("Granola: no good check since Wednesday 11th November, 08:01. Last error: Granola refused the key.");
    // Only two real failures: a check stopped by a restart does not count.
    const restarted = [run({ startedAt: new Date("2026-11-11T11:00:00Z"), ok: false, error: "Stopped when OllieOS restarted, for example after publishing. The next check carries on." }), fail(10), fail(9), good];
    expect(failingWarning("granola", restarted, DEFAULT_SCHEDULE, new Date("2026-11-11T16:00:00Z"))).toBeNull();
    // Never a good check.
    expect(failingWarning("granola", [fail(11), fail(10), fail(9)], DEFAULT_SCHEDULE, new Date("2026-11-11T18:00:00Z"))!.text).toBe("Granola: no good check yet. Last error: Granola refused the key.");
  });

  it("shows on Home, in the digest and on the service's card, and clears after a good check", async () => {
    await readByOllieOS("slack");
    const now = Date.now();
    // A good check 8 days ago, then failures: well over 4 working hours whatever day the test runs.
    await insertRuns("slack", [
      { at: new Date(now - 8 * DAY), ok: true },
      { at: new Date(now - 7 * DAY), ok: false, error: "Slack refused access (token_revoked). Reconnect it in Replit." },
      { at: new Date(now - 4 * DAY), ok: false, error: "Slack refused access (token_revoked). Reconnect it in Replit." },
      { at: new Date(now - DAY), ok: false, error: "Slack refused access (token_revoked). Reconnect it in Replit." },
    ]);
    const home = (await api("home")).body;
    expect(home.connectorWarnings).toHaveLength(1);
    expect(home.connectorWarnings[0].key).toBe("slack");
    expect(home.connectorWarnings[0].text).toMatch(/^Slack: no good check since .+\. Last error: Slack refused access \(token_revoked\)\. Reconnect it in Replit\.$/);

    const view = (await api("connectors")).body;
    expect(view.services.find((s: { key: string }) => s.key === "slack").warning).toBe(home.connectorWarnings[0].text);
    expect(view.services.find((s: { key: string }) => s.key === "gmail").warning).toBeNull();

    const digest = await buildDigest(todayLondon());
    const needs = digest.sections.needs!.items.map((i) => i.text);
    expect(needs).toContain(home.connectorWarnings[0].text);
    expect(digest.sections.needs!.items.find((i) => i.text === home.connectorWarnings[0].text)!.href).toBe("/settings/connectors");

    await insertRuns("slack", [{ at: new Date(now - HOUR), ok: true }]);
    expect((await api("home")).body.connectorWarnings).toEqual([]);
  });

  it("warns when Granola works but finds none of Ollie's meetings for 2 working days while he had meetings", async () => {
    await readByOllieOS("granola");
    // Wednesday 11th November 2026, 15:00 London: two working days back is Monday 9th, 15:00.
    const now = new Date("2026-11-11T15:00:00Z");
    await insertRuns("granola", [
      { at: new Date("2026-11-06T10:00:00Z"), ok: true, counts: { meetings: 2 } },
      { at: new Date("2026-11-09T10:00:00Z"), ok: true, counts: { meetings: 0 } },
      { at: new Date("2026-11-10T10:00:00Z"), ok: true, counts: { meetings: 0 } },
      { at: new Date("2026-11-11T14:00:00Z"), ok: true, counts: { meetings: 0 } },
    ]);
    const meeting = (day: string, n: number) => ({
      sourceRef: `cal-${day}-${n}`,
      title: "Planning",
      startsAt: new Date(`2026-11-${day}T1${n}:00:00Z`),
      endsAt: new Date(`2026-11-${day}T1${n}:30:00Z`),
    });
    await db.insert(calendarEventsTable).values([meeting("10", 0), meeting("10", 1)]);
    // Two meetings is not enough to be sure.
    expect(await connectorWarnings(now)).toEqual([]);
    await db.insert(calendarEventsTable).values([meeting("11", 0), { ...meeting("11", 1), sourceRef: "personal", personal: true }]);
    const [w] = await connectorWarnings(now);
    expect(w).toMatchObject({ key: "granola", kind: "empty" });
    expect(w.text).toBe(
      "Granola: checks are working, but none of your meetings since Monday 9th November, 15:00 came through, though your calendar had 3 work meetings. The Granola key may not see your own notes.",
    );
    // A check that finds one of his meetings clears it.
    await insertRuns("granola", [{ at: new Date("2026-11-11T14:30:00Z"), ok: true, counts: { meetings: 1 } }]);
    expect(await connectorWarnings(now)).toEqual([]);
  });

  it("warns when Gmail works but brings in no new email for a whole working day, and never on a new setup", async () => {
    await readByOllieOS("gmail");
    const now = new Date("2026-11-11T15:00:00Z");
    // A new setup: no check from before the quiet day, so no warning.
    await insertRuns("gmail", [10, 11, 12].map((h) => ({ at: new Date(`2026-11-11T${h}:00:00Z`), ok: true })));
    expect(await connectorWarnings(now)).toEqual([]);
    await insertRuns("gmail", [{ at: new Date("2026-11-10T09:00:00Z"), ok: true, found: 4 }]);
    const [w] = await connectorWarnings(now);
    expect(w).toMatchObject({ key: "gmail", kind: "empty", text: "Gmail: checks are working, but no new email has come through since Tuesday 10th November, 09:01." });
    await insertRuns("gmail", [{ at: new Date("2026-11-11T14:00:00Z"), ok: true, found: 1 }]);
    expect(await connectorWarnings(now)).toEqual([]);
  });
});

describe("documents that changed", () => {
  it("finds lines removed and added, ignoring moved and blank lines", () => {
    expect(lineDiff("A\n\nB\nC", "C\nA\nB")).toEqual({ removed: [], added: [] });
    expect(lineDiff("Price: £8\nIntro", "Intro\nPrice: £10\n\nNew bit")).toEqual({ removed: ["Price: £8"], added: ["Price: £10", "New bit"] });
  });

  it("records a colleague's change to a linked Library document with one line, and never Ollie's own", async () => {
    const launch = await project("Spring Launch");
    const [lib] = await db.insert(documentsTable).values({ title: "Launch plan", url: "https://docs.google.com/document/d/LAUNCH_DOC_A1/edit", location: "gdrive", createdBy: "ollie" }).returning();
    await db.insert(linksTable).values({ fromType: "document", fromId: lib.id, toType: "project", toId: launch.id, createdBy: "ollie" });
    const t1 = new Date(Date.now() - 3 * HOUR);
    files = { LAUNCH_DOC_A1: { id: "LAUNCH_DOC_A1", name: "Launch plan", mimeType: DOC, modifiedTime: t1.toISOString(), lastModifyingUser: { displayName: "Ollie", emailAddress: OLLIE, me: true } } };
    exportsText = { LAUNCH_DOC_A1: "Launch on the 14th of March.\nVenue: Hall A" };
    changeLines = [];
    // First read: nothing to compare with.
    let check = await api("connectors/drive/check", { method: "POST" });
    expect(check.body.counts).toMatchObject({ read: 1, changed: 0 });

    // Ollie edits it himself: read again, not listed.
    const t2 = new Date(Date.now() - 2 * HOUR);
    files.LAUNCH_DOC_A1 = { ...files.LAUNCH_DOC_A1, modifiedTime: t2.toISOString() };
    exportsText.LAUNCH_DOC_A1 = "Launch on the 14th of March.\nVenue: Hall B";
    check = await api("connectors/drive/check", { method: "POST" });
    expect(check.body.counts).toMatchObject({ read: 1, changed: 0 });

    // A colleague edits it.
    const t3 = new Date(Date.now() - HOUR);
    files.LAUNCH_DOC_A1 = { ...files.LAUNCH_DOC_A1, modifiedTime: t3.toISOString(), lastModifyingUser: { displayName: "Sam Lee", emailAddress: "sam@example.com", me: false } };
    exportsText.LAUNCH_DOC_A1 = "Launch on the 7th of March.\nVenue: Hall B";
    check = await api("connectors/drive/check", { method: "POST" });
    expect(check.body.counts).toMatchObject({ read: 1, changed: 1 });
    expect(changeLines).toHaveLength(1);
    expect(changeLines[0]).toContain("<removed>\nLaunch on the 14th of March.\n</removed>");
    expect(changeLines[0]).toContain("<added>\nLaunch on the 7th of March.\n</added>");
    const rows = await db.select().from(documentChangesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentId: lib.id, byName: "Sam Lee", byEmail: "sam@example.com", summary: "Launch moves from 14th to 7th March" });

    // In the digest under Changed, with a link to the document.
    const digest = await buildDigest(todayLondon());
    expect(digest.sections.changed!.items).toEqual([
      { text: "Launch plan: Launch moves from 14th to 7th March (changed by Sam Lee)", href: `/knowledge/library?document=${lib.id}`, refs: [`document:${lib.id}`], confidential: false },
    ]);
    expect(digest.sections.changed!.moreHref).toBe("/knowledge/library");
    expect(digest.sections.quietNight).toBe(false);
  });

  it("only records documents on active work, and keeps hidden ones without a line and locked", async () => {
    const live = await project("Live work");
    const secret = await project("Board pack", { confidential: true });
    const done = await project("Old work");
    await db.update((await import("@workspace/db")).projectsTable).set({ lifecycle: "complete" }).where(eq((await import("@workspace/db")).projectsTable.id, done.id));
    const [product] = await db.insert(productsTable).values({ name: "Old product", slug: "old-product", state: "retired", createdBy: "ollie" }).returning();
    const doc = async (title: string, to: { type: "project" | "product"; id: number }) => {
      const [d] = await db.insert(documentsTable).values({ title, location: "gdrive", url: `https://docs.google.com/document/d/${title.replace(/\W/g, "")}/edit`, createdBy: "ollie" }).returning();
      await db.insert(linksTable).values({ fromType: "document", fromId: d.id, toType: to.type, toId: to.id, createdBy: "ollie" });
      return d;
    };
    const a = await doc("Pricing", { type: "project", id: live.id });
    const b = await doc("Bonus scheme", { type: "project", id: secret.id });
    const c = await doc("Old notes", { type: "project", id: done.id });
    const p = await doc("Old product sheet", { type: "product", id: product.id });
    const at = new Date(Date.now() - HOUR);
    const change = (id: number, title: string) => recordDocumentChange({ documentId: id, title, before: "Tier 2: £8", after: "Tier 2: £10", modifiedAt: at, byName: "Sam Lee", byEmail: "sam@example.com" });
    changeLines = [];
    expect(await change(a.id, "Pricing")).toBe(true);
    expect(await change(b.id, "Bonus scheme")).toBe(true);
    expect(await change(c.id, "Old notes")).toBe(false);
    expect(await change(p.id, "Old product sheet")).toBe(false);
    // Only the visible document went to AI.
    expect(changeLines).toHaveLength(1);
    // Formatting only: nothing recorded.
    expect(await recordDocumentChange({ documentId: a.id, title: "Pricing", before: "Tier 2: £10", after: "Tier 2:   £10\n\n", modifiedAt: new Date(), byName: "Sam Lee", byEmail: null })).toBe(false);

    const list = await changedDocuments(new Date(Date.now() - DAY), new Date());
    expect(list.map((d) => [d.title, d.summary, d.hidden])).toEqual(
      expect.arrayContaining([
        ["Pricing", "Launch moves from 14th to 7th March", false],
        ["Bonus scheme", null, true],
      ]),
    );

    const digest = await buildDigest(todayLondon());
    const bonus = digest.sections.changed!.items.find((i) => i.text.startsWith("Bonus scheme"))!;
    expect(bonus).toMatchObject({ text: "Bonus scheme was changed by Sam Lee", confidential: true });

    // The weekly round-up lists both; its Gmail draft leaves out the hidden one.
    const content = await buildRoundupContent(new Date(Date.now() - 7 * DAY), new Date());
    expect(content.documents).toEqual(
      expect.arrayContaining([
        { text: "Pricing", detail: "Launch moves from 14th to 7th March. Changed by Sam Lee", private: false },
        { text: "Bonus scheme", detail: "Changed by Sam Lee", private: true },
      ]),
    );
    const email = roundupEmail({ id: 1, weekStart: new Date(), weekEnd: new Date(), manual: true, createdAt: new Date(), draftSaved: false, content } as never);
    expect(email.body).toContain("Documents that changed\n- Pricing (Launch moves from 14th to 7th March. Changed by Sam Lee)");
    expect(email.body).not.toContain("Bonus scheme");
  });
});
