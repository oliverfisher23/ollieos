import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { appSettingsTable, calendarEventsTable, db, legacyPlaybooksTable, linksTable, peopleTable, rulesTable, suggestionsTable } from "@workspace/db";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import type { Extracted } from "../src/services/documents/knowledge";
import { readWaiting } from "../src/services/documents/reader";
import { migrateRules } from "../src/services/migrations";
import { organisation, person, project } from "./helpers";
import { api, call, connect, ingest, mcp, useServer } from "./harness";

/* What the fake document reader finds, and what each brief was given. */
let extract: Extracted;
const briefDocs: AiDoc[][] = [];

const nothing = (): Extracted => ({ summary: "A document.", confidential: false, projects: [], facts: [], decisions: [], people: [], organisations: [], rules: [], relationships: [] });

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  modelJson: async () => extract,
}));
vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  draftCheckInFromDocs: async () => ({ text: "Hi", refs: [] }),
  writeBriefFromDocs: async (_meeting: unknown, docs: AiDoc[]) => {
    briefDocs.push(docs);
    return { why: [], questions: [], questionsNote: "" };
  },
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

async function claude() {
  return mcp((await connect()).access_token);
}

/** Opens the app once, which creates the seed goals and the six rules. */
async function seed() {
  expect((await api("goals")).status).toBe(200);
}

const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `Step ${i + 1}` }));

/* ---------- Start-up migration ---------- */

describe("rules migration", () => {
  it("moves the old playbooks into rules with the same ids, and every reference with them", async () => {
    const p = await project("Apollo");
    await db.insert(legacyPlaybooksTable).values([
      { title: "Tone", appliesWhen: "Writing anything", rule: "British English." },
      { title: "Credits", appliesWhen: "Talking about credits", rule: "Say experience credits.", enabled: false },
    ]);
    const old = await db.select().from(legacyPlaybooksTable).orderBy(legacyPlaybooksTable.id);
    await db.insert(linksTable).values({ fromType: "playbook", fromId: old[0].id, toType: "project", toId: p.id, createdBy: "test" });

    expect(await migrateRules()).toBe(true);

    const rules = await db.select().from(rulesTable).orderBy(rulesTable.id);
    expect(rules.map((r) => [r.id, r.title, r.rule, r.enabled])).toEqual(old.map((r) => [r.id, r.title, r.rule, r.enabled]));
    expect(await db.select().from(legacyPlaybooksTable)).toEqual([]);
    const links = await db.select().from(linksTable);
    expect(links).toEqual([expect.objectContaining({ fromType: "rule", fromId: old[0].id, toType: "project", toId: p.id })]);

    // It runs once; a new rule takes the next id.
    expect(await migrateRules()).toBe(false);
    const made = await api("rules", { body: { title: "New", appliesWhen: "Always", rule: "Be brief." } });
    expect(made.status).toBe(201);
    expect(made.body.id).toBe(old[1].id + 1);
  });

  it("never runs again once process playbooks exist", async () => {
    await api("playbooks", { body: { title: "Onboarding", whenToUse: "A partner signs", steps: steps(1) } });
    await db.delete(appSettingsTable).where(eq(appSettingsTable.key, "migrated_part_m_rules"));
    await db.insert(linksTable).values({ fromType: "playbook", fromId: 1, toType: "project", toId: (await project("Apollo")).id, createdBy: "test" });
    expect(await migrateRules()).toBe(false);
    expect((await db.select().from(linksTable))[0].fromType).toBe("playbook");
  });
});

/* ---------- Rules, renamed ---------- */

describe("rules", () => {
  it("criterion 1: the six seed rules show under Rules, and get_rules and get_playbooks both return them", async () => {
    await seed();
    const list = (await api("rules")).body as unknown as { title: string }[];
    expect(list).toHaveLength(6);
    const c = await claude();
    const a = await call(c, "get_rules", {});
    const b = await call(c, "get_playbooks", {});
    expect((a.json.rules as unknown[]).length).toBe(6);
    expect(b.json).toEqual(a.json);
  });

  it("a rule linked to a product applies to a project linked to that product", async () => {
    const p = await project("Apollo");
    const prod = (await api("products", { body: { name: "Micro Internships" } })).body;
    const r = (await api("rules", { body: { title: "Applied work", appliesWhen: "Describing it", rule: "Say applied work, not a course.", productIds: [prod.id] } })).body;
    await api("links", { body: { fromType: "project", fromId: p.id, toType: "product", toId: prod.id } });
    const page = (await api(`projects/${p.slug}`)).body;
    expect(page.rules.map((x: { id: number }) => x.id)).toContain(r.id);
    expect(page.products.map((x: { id: number }) => x.id)).toEqual([prod.id]);
    const c = await claude();
    const out = await call(c, "get_rules", { context: { name: "Apollo" } });
    expect((out.json.rules as { title: string }[]).map((x) => x.title)).toContain("Applied work");
  });
});

/* ---------- Playbooks ---------- */

describe("playbooks", () => {
  it("criterion 2: a five-step playbook can be added, reordered and linked to a project, and shows on its page", async () => {
    const p = await project("Apollo");
    const made = await api("playbooks", { body: { title: "Partner onboarding", whenToUse: "A new university partner signs", steps: steps(5), state: "draft" } });
    expect(made.status).toBe(201);
    expect(made.body.state).toBe("draft");
    const ids = made.body.steps.map((s: { id: string }) => s.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);

    // Move the last step to the top, keeping every step's id.
    const reordered = [made.body.steps[4], ...made.body.steps.slice(0, 4)].map((s: { id: string; text: string }) => ({ id: s.id, text: s.text }));
    const up = await api(`playbooks/${made.body.id}`, { method: "PATCH", body: { steps: reordered, projectIds: [p.id], state: "in_use" } });
    expect(up.status).toBe(200);
    expect(up.body.steps.map((s: { text: string }) => s.text)).toEqual(["Step 5", "Step 1", "Step 2", "Step 3", "Step 4"]);
    expect(up.body.steps.map((s: { id: string }) => s.id)).toEqual([ids[4], ...ids.slice(0, 4)]);
    expect(up.body.projects).toEqual([expect.objectContaining({ id: p.id })]);

    const page = (await api(`projects/${p.slug}`)).body;
    expect(page.playbooks).toEqual([expect.objectContaining({ id: made.body.id, title: "Partner onboarding" })]);

    // Claude sees it now it is in use, with its steps in order.
    const c = await claude();
    const one = await call(c, "get_playbook", { playbook: "Partner onboarding" });
    expect((one.json.playbook as { steps: { text: string }[] }).steps.map((s) => s.text)[0]).toBe("Step 5");
  });

  it("a draft playbook never reaches Claude", async () => {
    await api("playbooks", { body: { title: "Secret process", whenToUse: "Sometimes", steps: steps(2), state: "draft" } });
    const c = await claude();
    expect((await call(c, "get_playbook", {})).json.playbooks).toEqual([]);
    expect((await call(c, "get_playbook", { playbook: "Secret process" })).isError).toBe(true);
    expect((await call(c, "search", { query: "Secret process" })).text).not.toMatch(/Secret process/);
  });

  it("a playbook follows a confidential project it is linked to unless set", async () => {
    const p = await project("Board work", { confidential: true });
    await api("playbooks", { body: { title: "Board pack", whenToUse: "Before a board", steps: steps(2), projectIds: [p.id] } });
    const c = await claude();
    expect((await call(c, "get_playbook", {})).text).not.toMatch(/Board pack/);
  });

  it("criterion 3: a document that describes a process gives a Playbook card; approving it creates the playbook with its source", async () => {
    const p = await project("Apollo");
    const sam = await person("Sam Lee");
    const doc = await api("documents/text", { body: { title: "Onboarding guide", text: "How we onboard partners, step by step.", buildKnowledge: true } });
    extract = {
      ...nothing(),
      projects: ["Apollo"],
      playbooks: [
        {
          title: "Partner onboarding",
          existing: "",
          when_to_use: "A new university partner signs",
          purpose: "Get partners live in a month",
          owner: "Sam Lee",
          steps: [
            { text: "Send the welcome pack", person: "", day: "0" },
            { text: "Book the kick-off call", person: "Sam Lee", day: "3" },
            { text: "Set up their dashboard", person: "", day: "" },
          ],
        },
      ],
    };
    expect(await readWaiting(5)).toBe(1);

    const inbox = (await api("suggestions?origin=documents")).body;
    const card = inbox.items.find((i: { kind: string }) => i.kind === "new_playbook");
    expect(card).toBeTruthy();
    expect(card.fromDocument).toBe(`document:${doc.body.id}`);
    expect(card.playbook.steps.map((s: { text: string; change: string }) => [s.text, s.change])).toEqual([
      ["Send the welcome pack", "new"],
      ["Book the kick-off call", "new"],
      ["Set up their dashboard", "new"],
    ]);
    expect(card.playbook.steps[1]).toMatchObject({ person: "Sam Lee", afterDays: 3 });

    expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    const list = (await api("playbooks")).body as unknown as { id: number; title: string; source: string; ownerId: number; steps: unknown[] }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Partner onboarding", ownerId: sam.id });
    expect(list[0].steps).toHaveLength(3);
    expect(list[0].source).toMatch(/Onboarding guide/);
    void p;
  });

  it("a proposed change shows the steps added, changed and removed, and approving it counts as a check", async () => {
    const made = (await api("playbooks", { body: { title: "Partner onboarding", whenToUse: "A partner signs", steps: [{ text: "Send the pack" }, { text: "Book a call" }, { text: "Old step" }] } })).body;
    await db.execute(sql`update process_playbooks set last_checked_at = now() - interval '200 days' where id = ${made.id}`);
    const c = await claude();
    const got = (await call(c, "get_playbook", { playbook: `playbook:${made.id}` })).json.playbook as { steps: { id: string; text: string }[] };
    const r = await call(c, "propose_playbook", {
      playbook: `playbook:${made.id}`,
      steps: [{ id: got.steps[0].id, text: "Send the pack" }, { id: got.steps[1].id, text: "Book a kick-off call" }, { text: "Set up the dashboard" }],
      reason: "The guide changed",
    });
    expect(r.isError).toBeFalsy();
    const card = (await api("suggestions")).body.items.find((i: { kind: string }) => i.kind === "playbook_change");
    expect(card.playbook.steps.map((s: { change: string }) => s.change)).toEqual(["same", "changed", "added", "removed"]);
    expect(card.playbook.steps[1].before).toMatch(/Book a call/);

    expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    const after = (await api(`playbooks/${made.id}`)).body;
    expect(after.steps.map((s: { text: string }) => s.text)).toEqual(["Send the pack", "Book a kick-off call", "Set up the dashboard"]);
    expect(Date.now() - new Date(after.lastCheckedAt).getTime()).toBeLessThan(60_000);
  });
});

/* ---------- Products ---------- */

describe("products", () => {
  it("criterion 4: a product with two facts and a linked rule shows them, and a brief for a meeting with a linked organisation includes both", async () => {
    const org = await organisation("Acme University");
    const prod = (await api("products", { body: { name: "Micro Internships", description: "Short applied projects" } })).body;
    for (const text of ["Runs for four weeks", "Students earn experience credits"]) {
      expect((await api("facts", { body: { entityType: "product", entityId: prod.id, text } })).status).toBe(201);
    }
    const rule = (await api("rules", { body: { title: "Applied work", appliesWhen: "Describing it", rule: "Say applied work, not a course.", productIds: [prod.id] } })).body;
    await api("links", { body: { fromType: "organisation", fromId: org.id, toType: "product", toId: prod.id } });

    const page = (await api(`products/${prod.slug}`)).body;
    expect(page.facts.map((f: { text: string }) => f.text).sort()).toEqual(["Runs for four weeks", "Students earn experience credits"]);
    expect(page.rules.map((r: { id: number }) => r.id)).toEqual([rule.id]);
    expect(page.organisations).toEqual([expect.objectContaining({ id: org.id })]);

    const jo = await person("Jo Bloggs", { organisationId: org.id });
    await db.update(peopleTable).set({ email: "jo@acme.test" }).where(eq(peopleTable.id, jo.id));
    await api("facts", { body: { entityType: "person", entityId: jo.id, text: "Jo is renewing in spring" } });
    const starts = new Date(Date.now() + 30 * 60_000);
    await ingest("calendar", {
      body: { events: [{ source_ref: "pm1", title: "Catch-up", starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 1_800_000).toISOString(), attendees: ["jo@acme.test"], personal: false }] },
    });
    const [ev] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, "pm1"));
    const brief = (await api(`briefs/${ev.id}`)).body;
    expect(brief.products).toEqual([expect.objectContaining({ id: prod.id, name: "Micro Internships", ruleIds: [rule.id] })]);
    expect(brief.rules.map((r: { id: number }) => r.id)).toContain(rule.id);
    const sent = briefDocs.at(-1)!.map((d) => d.text).join("\n");
    expect(sent).toMatch(/Micro Internships/);
  });

  it("criterion 5: a confidential product and its facts never reach Claude", async () => {
    const org = await organisation("Acme University");
    const prod = (await api("products", { body: { name: "Project Kestrel", confidential: true } })).body;
    await api("facts", { body: { entityType: "product", entityId: prod.id, text: "Kestrel launches in secret" } });
    await api("links", { body: { fromType: "organisation", fromId: org.id, toType: "product", toId: prod.id } });
    await api("rules", { body: { title: "Kestrel naming", appliesWhen: "Writing", rule: "Call it the new thing.", productIds: [prod.id] } });

    const c = await claude();
    const outs = [
      await call(c, "search", { query: "Kestrel" }),
      await call(c, "get_context", { name: "Acme University" }),
      await call(c, "get_rules", { product: "Project Kestrel" }),
      await call(c, "fetch", { id: `product:${prod.id}` }),
      await call(c, "explore", { item: `organisation:${org.id}` }),
    ];
    for (const o of outs) expect(o.text).not.toMatch(/Kestrel launches/);
    for (const o of outs.slice(0, 2)) expect(o.text).not.toMatch(/Project Kestrel/);
    expect(outs[3].isError).toBe(true);

    // Nor does it go to the brief writer.
    const jo = await person("Jo Bloggs", { organisationId: org.id });
    await db.update(peopleTable).set({ email: "jo@acme.test" }).where(eq(peopleTable.id, jo.id));
    await api("facts", { body: { entityType: "person", entityId: jo.id, text: "Jo is renewing in spring" } });
    const starts = new Date(Date.now() + 30 * 60_000);
    await ingest("calendar", {
      body: { events: [{ source_ref: "pm2", title: "Catch-up", starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 1_800_000).toISOString(), attendees: ["jo@acme.test"], personal: false }] },
    });
    const [ev] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, "pm2"));
    briefDocs.length = 0;
    await api(`briefs/${ev.id}`);
    expect(briefDocs).toHaveLength(1);
    for (const docs of briefDocs) expect(docs.map((d) => d.text).join("\n")).not.toMatch(/Kestrel/);
  });

  it("propose_product goes to the Knowledge Inbox, and approving it adds the product with its facts", async () => {
    const c = await claude();
    const r = await call(c, "propose_product", { name: "Foundation Year", description: "A year before the degree", facts: ["Starts in September"] });
    expect(r.isError).toBeFalsy();
    const [s] = await db.select().from(suggestionsTable);
    expect(s).toMatchObject({ kind: "product", status: "pending" });
    const card = (await api("suggestions")).body.items.find((i: { kind: string }) => i.kind === "new_product");
    expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    const list = (await api("products")).body as unknown as { slug: string; name: string }[];
    expect(list.map((p) => p.name)).toEqual(["Foundation Year"]);
    const page = (await api(`products/${list[0].slug}`)).body;
    expect(page.facts.map((f: { text: string }) => f.text)).toEqual(["Starts in September"]);
  });
});
