/**
 * Part L (build plan section 14): Drive search, rules learned from Ollie's edits, checking a draft
 * against his rules, running a playbook, and where rules and playbooks are used.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appSettingsTable, auditEventsTable, db, documentsTable, draftEditsTable, playbooksTable, rulesTable, suggestionsTable, tasksTable } from "@workspace/db";
import { applyFixes, checkDraft, learnRulesFromEdits, learnRulesIfDue, recordEdit } from "../src/services/draftLearning";
import { runPlaybook, unusedIds, usageOf } from "../src/services/playbookRuns";
import { searchDrive } from "../src/services/connectors/drive";
import { api, call, connect, mcp, useServer } from "./harness";
import { person, project } from "./helpers";

let learned: { title: string; applies_when: string; rule: string; examples: number[] }[] = [];
let checked: { rule: string; line: string; fix: string }[] = [];
let checkCalls: { text: string; refs: string[] }[] = [];
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  rulesFromEdits: async () => learned,
  checkDraftAgainstRules: async (text: string, docs: { ref: string }[]) => {
    checkCalls.push({ text, refs: docs.map((d) => d.ref) });
    return checked;
  },
}));

let driveFiles: Record<string, unknown>[] = [];
let driveQuery = "";
vi.mock("../src/services/connectors/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/http")>();
  return {
    ...real,
    proxyJson: async (_c: string, _n: string, path: string) => {
      const url = new URL("https://x" + path);
      if (url.pathname === "/drive/v3/files") {
        driveQuery = url.searchParams.get("q") ?? "";
        return { files: driveFiles };
      }
      throw new Error("Unexpected path " + path);
    },
  };
});

useServer();

const DAY = 86_400_000;
const rule = async (title: string, text = "Never use exclamation marks.") => (await db.insert(rulesTable).values({ title, appliesWhen: "Any email", rule: text }).returning())[0];

describe("rules from Ollie's edits", () => {
  it("records what changed once per task and kind, and ignores drafts sent as written", async () => {
    const [t] = await db.insert(tasksTable).values({ title: "Reply to Sam", createdBy: "ollie" }).returning();
    expect(await recordEdit(t.id, "edited", "Hi Sam!  Thanks so much!", "Hi Sam!   Thanks so much!")).toBe(false);
    expect(await recordEdit(t.id, "edited", null, "Anything at all here")).toBe(false);
    expect(await recordEdit(t.id, "edited", "Hi Sam! Thanks so much!", "Thanks.")).toBe(false);
    expect(await recordEdit(t.id, "edited", "Hi Sam! Thanks so much!", "Hi Sam, thanks.")).toBe(true);
    expect(await db.select().from(draftEditsTable)).toHaveLength(1);
    expect(await recordEdit(t.id, "edited", "Hi Sam! Thanks so much!", "Hi Sam, thank you for this.")).toBe(true);
    expect(await recordEdit(t.id, "sent", "Hi Sam! Thanks so much!", "Hi Sam, thank you for all of this.")).toBe(true);
    const rows = await db.select().from(draftEditsTable);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === "edited")!.final).toBe("Hi Sam, thank you for this.");
  });

  it("proposes a rule only for a change made three or more times, never making it a rule itself", async () => {
    const [t] = await db.insert(tasksTable).values({ title: "Any", createdBy: "ollie" }).returning();
    const edits = await db
      .insert(draftEditsTable)
      .values([1, 2, 3, 4].map((i) => ({ taskId: t.id, kind: i % 2 ? ("edited" as const) : ("sent" as const), original: `Draft ${i}!`, final: `Draft number ${i}.` })))
      .returning();
    const ids = edits.map((e) => e.id);
    learned = [
      { title: "No exclamation marks", applies_when: "Any email", rule: "Do not use exclamation marks.", examples: [ids[0], ids[1], ids[2]] },
      { title: "Shorter sign-off", applies_when: "", rule: "Sign off with just Ollie.", examples: [ids[0], ids[1], 9999] },
    ];
    expect(await learnRulesFromEdits()).toBe(1);
    const cards = await db.select().from(suggestionsTable).where(eq(suggestionsTable.kind, "rule"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ proposedBy: "Rules from your edits", status: "pending" });
    expect(cards[0].payload).toMatchObject({ title: "No exclamation marks", rule: "Do not use exclamation marks." });
    expect(await db.select().from(rulesTable)).toHaveLength(0);
  });

  it("needs three edits to look at, and runs once a week", async () => {
    learned = [];
    const now = new Date("2026-11-16T07:00:00Z");
    expect(await learnRulesFromEdits(now)).toBe(0);
    expect(await learnRulesIfDue(now)).toEqual({ ran: true, proposed: 0 });
    expect(await learnRulesIfDue(new Date(now.getTime() + 3 * DAY))).toEqual({ ran: false, proposed: 0 });
    expect((await learnRulesIfDue(new Date(now.getTime() + 8 * DAY))).ran).toBe(true);
    const [s] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "rules_from_edits_last"));
    expect(s).toBeTruthy();
  });
});

describe("checking a draft against the rules", () => {
  it("returns lines that break a rule, dropping lines not in the draft and rules that do not exist", async () => {
    const r = await rule("No exclamation marks");
    checkCalls = [];
    checked = [
      { rule: `rule:${r.id}`, line: "Thanks so much!", fix: "Thanks." },
      { rule: `rule:${r.id}`, line: "A line that is not there", fix: "x" },
      { rule: "rule:9999", line: "Hi Sam", fix: "Hello Sam" },
    ];
    const text = "Hi Sam\n\nThanks so much!\n\nOllie";
    const issues = await checkDraft(text, []);
    expect(issues).toEqual([{ ruleRef: `rule:${r.id}`, ruleTitle: "No exclamation marks", line: "Thanks so much!", fix: "Thanks." }]);
    expect(checkCalls[0].refs).toEqual([`rule:${r.id}`]);
    expect(applyFixes(text, issues)).toBe("Hi Sam\n\nThanks.\n\nOllie");
    const reads = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "read"));
    expect(reads.some((a) => a.entityType === "rule" && a.entityId === r.id)).toBe(true);
  });

  it("never sends a rule hidden from AI, and does not call the model when no rule applies", async () => {
    await db.insert(rulesTable).values({ title: "Secret", appliesWhen: "x", rule: "y", enabled: false });
    checkCalls = [];
    expect(await checkDraft("Hello there", [])).toEqual([]);
    expect(checkCalls).toHaveLength(0);
    await expect(checkDraft("   ", [])).rejects.toThrow("There is no draft to check");
  });

  it("is on the task's reply draft and on the MCP server", async () => {
    const r = await rule("No exclamation marks");
    const p = await project("Spring Launch");
    const [t] = await db.insert(tasksTable).values({ title: "Reply", createdBy: "ollie", projectId: p.id }).returning();
    checked = [{ rule: `rule:${r.id}`, line: "Great!", fix: "Great." }];
    const res = await api(`tasks/${t.id}/reply-draft/check`, { method: "POST", body: { body: "Great! See you then." } });
    expect(res.status).toBe(200);
    expect(res.body.issues).toEqual([{ ruleRef: `rule:${r.id}`, ruleTitle: "No exclamation marks", line: "Great!", fix: "Great." }]);
    expect((await api(`tasks/99999/reply-draft/check`, { method: "POST", body: { body: "Hi" } })).status).toBe(404);

    const { access_token } = await connect("Claude");
    const c = await mcp(access_token);
    const out = await call(c, "check_draft", { text: "Great! See you then.", project: { name: "Spring Launch" } });
    expect(out.isError).toBeFalsy();
    expect(out.json).toMatchObject({ issues: [{ rule: `rule:${r.id}`, rule_title: "No exclamation marks", line: "Great!", fix: "Great." }], message: "1 line break a rule." });
  });
});

describe("running a playbook", () => {
  const steps = (personId: number) => [
    { id: "a", text: "Send the welcome pack", afterDays: 0, status: "now" as const },
    { id: "b", text: "Book the kick-off", afterDays: 3, personId },
    { id: "c", text: "Check in after a month", afterDays: 30 },
  ];

  it("makes one task per step, dated from the start, waiting on steps someone else does", async () => {
    const sam = await person("Sam Lee");
    const p = await project("Northbridge University");
    const [pb] = await db.insert(playbooksTable).values({ title: "Onboard a partner", whenToUse: "A partner signs", steps: steps(sam.id) }).returning();
    const res = await api(`playbooks/${pb.id}/run`, { method: "POST", body: { target: { type: "project", id: p.id }, mode: "tasks", start: "2026-11-16" } });
    expect(res.status).toBe(201);
    expect(res.body.taskIds).toHaveLength(3);
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks.map((t) => [t.title, t.status, t.dueDate, t.projectId])).toEqual([
      ["Send the welcome pack (Northbridge University)", "now", "2026-11-16", p.id],
      ["Book the kick-off (Northbridge University)", "waiting", "2026-11-19", p.id],
      ["Check in after a month (Northbridge University)", "backlog", "2026-12-16", p.id],
    ]);
    expect(tasks[1].waitingOnPersonId).toBe(sam.id);
    const [audit] = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "run"));
    expect(audit).toMatchObject({ entityType: "playbook", entityId: pb.id });
  });

  it("can make one task with the steps as a checklist, due when the last step is", async () => {
    const sam = await person("Sam Lee");
    const [pb] = await db.insert(playbooksTable).values({ title: "Onboard a partner", whenToUse: "A partner signs", steps: steps(sam.id) }).returning();
    const { taskIds } = await runPlaybook(pb.id, { target: { type: "person", id: sam.id }, mode: "checklist", start: "2026-11-16" }, "ollie");
    const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskIds[0]));
    expect(t).toMatchObject({ title: "Onboard a partner (Sam Lee)", status: "now", dueDate: "2026-12-16", personId: sam.id });
    expect(t.steps.map((s) => s.title)).toEqual(["Send the welcome pack", "Book the kick-off", "Check in after a month"]);
  });

  it("refuses a playbook with no steps or a target that does not exist", async () => {
    const [empty] = await db.insert(playbooksTable).values({ title: "Empty", whenToUse: "Never" }).returning();
    expect((await api(`playbooks/${empty.id}/run`, { method: "POST", body: { target: { type: "person", id: 1 }, mode: "tasks" } })).status).toBe(400);
    const [pb] = await db.insert(playbooksTable).values({ title: "One", whenToUse: "x", steps: [{ id: "a", text: "Do it", afterDays: 0 }] }).returning();
    expect((await api(`playbooks/${pb.id}/run`, { method: "POST", body: { target: { type: "person", id: 999 }, mode: "tasks" } })).status).toBe(404);
  });
});

describe("where rules and playbooks are used", () => {
  it("counts reads, names where they came from, and marks ones unused for 90 days", async () => {
    const now = new Date("2026-11-16T12:00:00Z");
    const old = new Date(now.getTime() - 200 * DAY);
    const [used] = await db.insert(rulesTable).values({ title: "Used", appliesWhen: "x", rule: "y", createdAt: old }).returning();
    const [idle] = await db.insert(rulesTable).values({ title: "Idle", appliesWhen: "x", rule: "y", createdAt: old }).returning();
    const [fresh] = await db.insert(rulesTable).values({ title: "New", appliesWhen: "x", rule: "y", createdAt: now }).returning();
    await db.insert(auditEventsTable).values([
      { actor: "ollieos", action: "read", entityType: "rule", entityId: used.id, payload: { via: "reply_draft" }, createdAt: new Date(now.getTime() - 2 * DAY) },
      { actor: "Claude", action: "read", entityType: "rule", entityId: used.id, payload: { via: "check_draft" }, createdAt: new Date(now.getTime() - DAY) },
      { actor: "ollieos", action: "read", entityType: "rule", entityId: idle.id, createdAt: new Date(now.getTime() - 120 * DAY) },
    ]);
    const u = await usageOf("rule", used.id, now);
    expect(u).toMatchObject({ count: 2, unused: false });
    expect(u.recent.map((r) => [r.by, r.via])).toEqual([["Claude", "Draft check"], ["ollieos", "Email draft"]]);
    expect((await usageOf("rule", idle.id, now)).unused).toBe(true);
    expect((await usageOf("rule", fresh.id, now)).unused).toBe(false);
    expect(await unusedIds("rule", now)).toEqual([idle.id]);
    expect((await api(`rules/${used.id}/usage`)).body.count).toBe(2);
    expect((await api(`rules/99999/usage`)).status).toBe(404);
    expect((await api("library/unused")).body).toEqual({ rules: [idle.id], playbooks: [] });
  });
});

describe("finding a Drive file", () => {
  it("searches by name and content, newest first, and marks files already in the Library", async () => {
    await db.insert(documentsTable).values({ title: "Plan", url: "https://docs.google.com/document/d/DOC_IN_LIBRARY_1/edit", location: "gdrive", createdBy: "ollie" });
    driveFiles = [
      { id: "DOC_IN_LIBRARY_1", name: "Launch plan", mimeType: "application/vnd.google-apps.document", webViewLink: "https://docs.google.com/document/d/DOC_IN_LIBRARY_1/edit?usp=drivesdk", modifiedTime: "2026-11-10T10:00:00Z", owners: [{ displayName: "Sam Lee" }] },
      { id: "SHEET_NOT_YET_1", name: "Launch budget", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.google.com/spreadsheets/d/SHEET_NOT_YET_1/edit", modifiedTime: "2026-11-09T10:00:00Z", owners: [{ emailAddress: "ollie@example.com" }] },
      { id: "NO_LINK_FILE_1", name: "Broken", mimeType: "application/vnd.google-apps.document" },
    ];
    const hits = await searchDrive("Launch 'plan'");
    expect(driveQuery).toContain("name contains 'Launch  plan'");
    expect(hits.map((h) => [h.fileId, h.inLibrary, h.owner])).toEqual([
      ["DOC_IN_LIBRARY_1", true, "Sam Lee"],
      ["SHEET_NOT_YET_1", false, "ollie@example.com"],
    ]);
    expect(hits[0].url).not.toContain("usp=");
    expect(await searchDrive("a")).toEqual([]);
    const res = await api("library/drive-search?q=Launch");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});
