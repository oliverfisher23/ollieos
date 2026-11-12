/**
 * Milestone 9 (voice capture, CSV export, imports, Noise clean-up) and Part T (commercial facts on
 * client organisations).
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, factsTable, factReviewsTable, organisationsTable, peopleTable, projectsTable, suggestionsTable, tasksTable } from "@workspace/db";
import { clearOldNoise, csvField, tasksCsv } from "../src/services/exports";
import { parseVoice, saveVoice } from "../src/services/voice";
import { pulseFor } from "../src/services/clientPulse";
import { propose } from "../src/services/suggestions";
import { api, base, ingest, KEY, sid, useServer } from "./harness";
import { organisation, person, project } from "./helpers";

let voiceItems: unknown[] = [];
let voiceCalls: string[] = [];
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (system: string, content: string) => {
    voiceCalls.push(system + "\n" + content);
    return { items: voiceItems };
  },
}));

useServer();

const DAY = 86_400_000;
// Monday 16th November 2026.
const MONDAY = new Date("2026-11-16T10:00:00Z");

describe("voice capture", () => {
  it("splits what was said into a task linked to the right project and person, and a fact for the Knowledge Inbox", async () => {
    const pwc = await project("Skills for Tomorrow");
    const emma = await person("Emma Duck");
    voiceItems = [
      { kind: "task", text: "Chase Emma on the sign-off", due: "2026-11-18", priority: "medium", project: "Skills for Tomorrow", person: "Emma Duck", about_type: "", about: "" },
      { kind: "fact", text: "Emma Duck is leaving in March", due: "", priority: "medium", project: "", person: "", about_type: "person", about: "Emma" },
    ];
    voiceCalls = [];
    const said = "Chase Emma on the Skills for Tomorrow sign-off on Wednesday. Emma is leaving in March.";
    const res = await api("voice/parse", { method: "POST", body: { transcript: said } });
    expect(res.status).toBe(200);
    expect(res.body.usedAi).toBe(true);
    expect(res.body.items[0]).toMatchObject({ kind: "task", dueDate: "2026-11-18", projectId: pwc.id, personId: emma.id, about: null });
    expect(res.body.items[1]).toMatchObject({ kind: "fact", dueDate: null, about: { type: "person", id: emma.id, name: "Emma Duck" } });
    expect(voiceCalls[0]).toContain("Skills for Tomorrow");
    // Nothing is saved until Ollie confirms.
    expect(await db.select().from(tasksTable)).toHaveLength(0);

    const saved = await api("voice/save", { method: "POST", body: { transcript: said, items: res.body.items } });
    expect(saved.status).toBe(201);
    const [t] = await db.select().from(tasksTable);
    expect(t).toMatchObject({ status: "inbox", source: "voice", sourceQuote: said, dueDate: "2026-11-18", projectId: pwc.id, personId: emma.id });
    expect(await db.select().from(factsTable)).toHaveLength(0);
    const [card] = await db.select().from(suggestionsTable);
    expect(card).toMatchObject({ kind: "fact", proposedBy: "Voice capture", sourceType: "voice", entityType: "person", entityId: emma.id, status: "pending" });
  });

  it("never sends a transcript naming something hidden from AI, and splits it in code instead", async () => {
    await project("Project Falcon", { confidential: true });
    const sam = await person("Sam Lee");
    voiceCalls = [];
    const r = await parseVoice("Send the Project Falcon pack to Sam on Friday. Book the room", MONDAY);
    expect(voiceCalls).toHaveLength(0);
    expect(r.usedAi).toBe(false);
    expect(r.items).toEqual([
      expect.objectContaining({ kind: "task", text: "Send the Project Falcon pack to Sam on Friday", dueDate: "2026-11-20", personId: sam.id }),
      expect.objectContaining({ kind: "task", text: "Book the room", dueDate: null }),
    ]);
  });

  it("refuses a fact with nothing to attach it to, and an empty or overlong transcript", async () => {
    await expect(saveVoice("x", [{ kind: "fact", text: "Something true", dueDate: null, priority: "medium", projectId: null, personId: null, about: null }])).rejects.toThrow("Choose what");
    expect((await api("voice/parse", { method: "POST", body: { transcript: "   " } })).status).toBe(400);
    expect((await api("voice/parse", { method: "POST", body: { transcript: "a".repeat(4001) } })).status).toBe(400);
  });
});

describe("CSV export", () => {
  it("exports every task with its project and people, safely quoted", async () => {
    const p = await project("Spring Launch");
    const sam = await person("Sam Lee");
    await db.insert(tasksTable).values([
      { title: 'Write the "launch" plan, then share', status: "now", createdBy: "ollie", projectId: p.id, dueDate: "2026-11-20" },
      { title: "=SUM(A1)", status: "waiting", createdBy: "ollie", waitingOnPersonId: sam.id },
    ]);
    const csv = await tasksCsv();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("id,title,status,kind,priority,due_date,project,for_person,waiting_on,source,source_link,notes,confidential,created_at,completed_at");
    expect(lines[1]).toContain('"Write the ""launch"" plan, then share",now,task,medium,2026-11-20,Spring Launch');
    expect(lines[2]).toContain("'=SUM(A1),waiting");
    expect(lines[2]).toContain(",Sam Lee,");
    expect(csvField("plain")).toBe("plain");
    const res = await fetch(`${base}/api/export/tasks.csv`, { headers: { authorization: `Bearer ${sid}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("ollieos-tasks-");
  });
});

describe("Noise clean-up", () => {
  it("deletes Noise items after 90 days and leaves everything else", async () => {
    const old = new Date(Date.now() - 91 * DAY);
    await db.insert(tasksTable).values([
      { title: "Old noise", status: "noise", createdBy: "ollieos", updatedAt: old },
      { title: "New noise", status: "noise", createdBy: "ollieos" },
      { title: "Old done", status: "done", createdBy: "ollie", updatedAt: old },
    ]);
    // updatedAt is set on update by Drizzle; set it again directly.
    await db.update(tasksTable).set({ updatedAt: old }).where(eq(tasksTable.title, "Old noise"));
    expect(await clearOldNoise()).toBe(1);
    expect((await db.select().from(tasksTable)).map((t) => t.title).sort()).toEqual(["New noise", "Old done"]);
  });
});

describe("one-off imports", () => {
  it("imports tasks once, linking projects and people by name", async () => {
    const p = await project("Spring Launch");
    await person("Sam Lee");
    const body = { kind: "tasks", tasks: [{ title: "Book the venue", status: "now", project: "spring launch", person: "Sam Lee", dueDate: "2026-11-30" }, { title: "Draft the agenda", dueDate: "soon" }] };
    const res = await api("import", { method: "POST", body });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "tasks", created: { tasks: 2 } });
    expect(res.body.skipped[0]).toContain("due date was not a date");
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks[0]).toMatchObject({ title: "Book the venue", status: "now", projectId: p.id, dueDate: "2026-11-30" });
    expect(tasks[1]).toMatchObject({ status: "backlog", dueDate: null });
    expect((await api("import", { method: "POST", body })).status).toBe(409);
  });

  it("imports knowledge from Claude's memory once, keeping confidential flags and each fact's date", async () => {
    await organisation("Acme");
    const body = {
      kind: "knowledge",
      organisations: [{ name: "Acme" }, { name: "Northbridge University", type: "client" }],
      projects: [{ name: "Sale process", confidential: true }],
      people: [{ name: "Sam Lee", role: "Head of Partnerships", organisation: "Northbridge University", email: "sam@northbridge.example" }],
      facts: [
        { about: { type: "person", name: "Sam Lee" }, text: "Prefers calls to email", date: "2026-03-01" },
        { about: { type: "project", name: "Nothing like this" }, text: "Lost" },
      ],
    };
    const res = await ingest("import", { method: "POST", body });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: { organisations: 1, projects: 1, people: 1, facts: 1 }, matched: { organisations: 1 } });
    expect(res.body.skipped).toHaveLength(1);
    const [sale] = await db.select().from(projectsTable).where(eq(projectsTable.name, "Sale process"));
    expect(sale.confidential).toBe(true);
    const [sam] = await db.select().from(peopleTable).where(eq(peopleTable.name, "Sam Lee"));
    const [uni] = await db.select().from(organisationsTable).where(eq(organisationsTable.name, "Northbridge University"));
    expect(sam.organisationId).toBe(uni.id);
    const [fact] = await db.select().from(factsTable);
    expect(fact).toMatchObject({ entityType: "person", entityId: sam.id, source: "claude-memory" });
    expect(fact.lastConfirmedAt.toISOString().slice(0, 10)).toBe("2026-03-01");
    expect((await ingest("import", { method: "POST", body })).status).toBe(409);
    expect((await api("import")).body.map((r: { kind: string }) => r.kind)).toEqual(["knowledge"]);
  });

  it("needs the ingest key for Claude", async () => {
    expect((await ingest("import", { method: "POST", body: { kind: "tasks", tasks: [{ title: "x" }] }, key: "wrong" })).status).toBe(401);
    expect(KEY).toBeTruthy();
  });
});

describe("commercial data on client organisations (Part T)", () => {
  it("shows renewal date, contract value and account health in the pulse, and flags a renewal within 60 days", async () => {
    const acme = await organisation("Acme");
    await db.update(organisationsTable).set({ type: "client" }).where(eq(organisationsTable.id, acme.id));
    const at = new Date("2026-11-10T09:00:00Z");
    await db.insert(factsTable).values([
      { entityType: "organisation", entityId: acme.id, text: "Renews on 2026-12-20", attribute: "renewal_date", createdBy: "ollie", lastConfirmedAt: at },
      { entityType: "organisation", entityId: acme.id, text: "£48,000 a year", attribute: "contract_value", createdBy: "ollie", lastConfirmedAt: at },
      { entityType: "organisation", entityId: acme.id, text: "At risk: usage down 40%", attribute: "account_health", createdBy: "ollie", lastConfirmedAt: at },
    ]);
    const p = await pulseFor(acme.id, MONDAY);
    expect(p.commercial).toMatchObject({ renewsOn: "2026-12-20", renewalDate: { text: "Renews on 2026-12-20" }, contractValue: { text: "£48,000 a year" }, accountHealth: { text: "At risk: usage down 40%" } });
    expect(p.reasons).toContain("Renews in 34 days");
    expect(p.reasons).toContain("Account health: At risk: usage down 40%");
    expect(p.line).toContain("renews Sunday 20th December");
    expect((await api(`organisations/${acme.slug}/pulse`)).body.commercial.renewsOn).toBe("2026-12-20");
  });

  it("confirms an unchanged value read again, and opens a conflict review for a changed one", async () => {
    const acme = await organisation("Acme");
    const [f] = await db
      .insert(factsTable)
      .values({ entityType: "organisation", entityId: acme.id, text: "Renews on 2026-12-20", attribute: "renewal_date", createdBy: "ollie", lastConfirmedAt: new Date("2026-01-01T00:00:00Z") })
      .returning();
    const meta = { proposedBy: "Capture sweep", clientId: null, sourceType: "document" };
    const same = await propose(meta, { kind: "fact", entityType: "organisation", entityId: acme.id, payload: { text: "Renews on 2026-12-20", attribute: "renewal_date", supersedes: null, source: "HubSpot" } });
    expect(same.status).toBe("duplicate");
    const [after] = await db.select().from(factsTable).where(eq(factsTable.id, f.id));
    expect(after.lastConfirmedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const changed = await propose(meta, { kind: "fact", entityType: "organisation", entityId: acme.id, payload: { text: "Renews on 2027-01-31", attribute: "renewal_date", supersedes: null, source: "HubSpot" } });
    expect(changed.status).toBe("conflict");
    const [review] = await db.select().from(factReviewsTable);
    expect(review).toMatchObject({ kind: "conflict", factIds: [f.id] });
  });
});

describe("loose ends", () => {
  it("shows a merged card's source on the fact it was merged into", async () => {
    const { mergeSuggestion } = await import("../src/services/inboxMerge");
    const { factsFor } = await import("../src/services/knowledge/items");
    const acme = await organisation("Acme");
    const [f] = await db.insert(factsTable).values({ entityType: "organisation", entityId: acme.id, text: "Acme has 400 staff", createdBy: "ollie" }).returning();
    const r = await propose(
      { proposedBy: "Gmail", clientId: null, sourceType: "email", sourceLabel: "Email from Sam Lee", sourceUrl: "https://mail.google.com/mail/u/0/#all/abc" },
      { kind: "fact", entityType: "organisation", entityId: acme.id, payload: { text: "Acme employs about 400 people", attribute: null, supersedes: null, source: null } },
    );
    expect(r.status).toBe("suggested");
    await mergeSuggestion((r as { suggestionId: number }).suggestionId, "fact", f.id);
    const [view] = await factsFor("organisation", acme.id);
    expect(view.alsoFrom).toEqual([{ source: "Email from Sam Lee", url: "https://mail.google.com/mail/u/0/#all/abc", at: expect.any(Date) }]);
  });
});
