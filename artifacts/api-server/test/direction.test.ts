import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, db, goalsTable, peopleTable, playbooksTable } from "@workspace/db";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import { link, person, project, task } from "./helpers";
import { api, call, connect, ingest, mcp, useServer } from "./harness";

/** What the check-in model was given, so the test can see which threads it could cite. */
const checkInDocs: AiDoc[][] = [];

vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  // Cites every task and project it was given, the way a good draft mentions open threads.
  draftCheckInFromDocs: async (opts: { to: string; docs: AiDoc[] }) => {
    checkInDocs.push(opts.docs);
    const refs = opts.docs.map((d) => d.ref).filter((r) => r.startsWith("task:") || r.startsWith("project:"));
    return { text: `Hi ${opts.to.split(" ")[0]}, checking in on a few things.`, refs };
  },
}));

useServer();

async function claude() {
  return mcp((await connect()).access_token);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** Runs the first-run seed (goals and playbooks) the way opening the app does. */
async function seed() {
  expect((await api("goals")).status).toBe(200);
}

/* ---------- 04 Goals ---------- */

describe("04 Goals", () => {
  it("criterion 1: a task in the RAF Micro Internship project counts towards that project's goal", async () => {
    await seed();
    const [growth] = await db.select().from(goalsTable).where(eq(goalsTable.name, "Growth"));
    const raf = await project("RAF Micro Internship");
    expect((await api(`projects/${raf.slug}`, { method: "PATCH", body: { goalId: growth.id } })).status).toBe(200);
    const t = await task("Send the RAF feedback form", { projectId: raf.id });

    const page = (await api("goals")).body;
    const g = page.goals.find((x: { id: number }) => x.id === growth.id);
    expect(g.openTasks).toBe(1);
    expect(page.supporting).toBe(1);
    expect(page.unlinked.map((u: { id: number }) => u.id)).not.toContain(t.id);
    const detail = (await api(`tasks/${t.id}`)).body;
    expect(detail.task.goal).toMatchObject({ id: growth.id, inherited: true });
  });

  it("criterion 2: a goal with no open tasks has zero open tasks, which the screen shows as the warning", async () => {
    await seed();
    const page = (await api("goals")).body;
    expect(page.goals.length).toBe(3);
    for (const g of page.goals) expect(g.openTasks).toBe(0);
  });

  it("criterion 3: linking an unlinked task from the Goals screen updates the counts, and Not goal work drops it", async () => {
    await seed();
    const [efficiency] = await db.select().from(goalsTable).where(eq(goalsTable.name, "Efficiency"));
    const a = await task("Automate invoicing");
    const b = await task("Buy a birthday card");
    let page = (await api("goals")).body;
    expect(page.unlinked.map((u: { id: number }) => u.id).sort()).toEqual([a.id, b.id]);
    expect(page.supporting).toBe(0);

    expect((await api(`tasks/${a.id}`, { method: "PATCH", body: { goalId: efficiency.id } })).status).toBe(200);
    expect((await api(`tasks/${b.id}`, { method: "PATCH", body: { notGoalWork: true } })).status).toBe(200);
    page = (await api("goals")).body;
    expect(page.goals.find((x: { id: number }) => x.id === efficiency.id).openTasks).toBe(1);
    expect(page.supporting).toBe(1);
    expect(page.unlinked).toEqual([]);
  });

  it("criterion 4: MCP list_goals never returns the target text of a confidential goal", async () => {
    await seed();
    const [growth] = await db.select().from(goalsTable).where(eq(goalsTable.name, "Growth"));
    const [expansion] = await db.select().from(goalsTable).where(eq(goalsTable.name, "Product and market expansion"));
    await api(`goals/${growth.id}`, { method: "PATCH", body: { targetText: "Revenue of 2.4m by October", statement: "Grow the business" } });
    await api(`goals/${expansion.id}`, { method: "PATCH", body: { targetText: "Two new markets" } });
    const sub = (await api("goals", { body: { name: "Grow RAF work", parentId: growth.id } })).body;
    await api(`goals/${sub.id}`, { method: "PATCH", body: { targetText: "Sub target 900k", confidential: false } });

    const c = await claude();
    const r = await call(c, "list_goals", {});
    await c.close();
    expect(r.text).not.toMatch(/2\.4m|900k/);
    const out = r.json.goals as { name: string; target_text?: string; statement: string; sub_goals: { target_text?: string }[] }[];
    const g = out.find((x) => x.name === "Growth")!;
    expect(g).not.toHaveProperty("target_text");
    expect(g.statement).toBe("Grow the business");
    expect(g.sub_goals[0]).not.toHaveProperty("target_text");
    expect(out.find((x) => x.name === "Product and market expansion")!.target_text).toBe("Two new markets");
  });
});

/* ---------- 05 Relationship cadence ---------- */

describe("05 Relationship cadence", () => {
  async function monthlyAnna() {
    const anna = await person("Anna Clarke", { role: "Programme lead" });
    await db.update(peopleTable).set({ cadence: "monthly", lastContactAt: daysAgo(32) }).where(eq(peopleTable.id, anna.id));
    return anna;
  }
  const statusOf = async (slug: string) =>
    ((await api("people/cadence")).body.people as { slug: string; status: string; daysOverdue: number | null }[]).find((p) => p.slug === slug);

  it("criterion 1: a monthly-cadence person with no activity for 32 days shows Overdue", async () => {
    const anna = await monthlyAnna();
    const row = await statusOf(anna.slug);
    expect(row).toMatchObject({ status: "overdue" });
    expect(row!.daysOverdue).toBeGreaterThanOrEqual(1);
    const overdue = (await api("people/cadence?tab=overdue")).body;
    expect(overdue.counts.overdue).toBe(1);
    expect(overdue.people.map((p: { slug: string }) => p.slug)).toEqual([anna.slug]);

    const c = await claude();
    const r = await call(c, "list_overdue_contacts", {});
    await c.close();
    expect((r.json.people as { name: string; status: string }[]).map((p) => [p.name, p.status])).toEqual([["Anna Clarke", "overdue"]]);
  });

  it("criterion 2: logging an email moves them to On track", async () => {
    const anna = await monthlyAnna();
    const c = await claude();
    const r = await call(c, "log_activity", { kind: "email", summary: "Replied about the pilot dates", occurred_at: new Date().toISOString(), people: ["Anna Clarke"] });
    await c.close();
    expect(r.isError).toBeFalsy();
    expect(await statusOf(anna.slug)).toMatchObject({ status: "on_track" });
  });

  it("criterion 3: Draft a check-in cites open threads and is never sent", async () => {
    const anna = await monthlyAnna();
    const pilot = await project("Pilot scheme");
    await link("person", anna.id, "project", pilot.id);
    const owe = await task("Send Anna the pilot timetable", { personId: anna.id });
    const before = await db.select().from(auditEventsTable);
    checkInDocs.length = 0;

    const r = await api(`people/${anna.slug}/check-in-draft`, { body: {} });
    expect(r.status).toBe(200);
    expect(r.body.text).toMatch(/^Hi Anna/);
    expect(r.body.threads.map((t: { ref: string }) => t.ref)).toEqual(expect.arrayContaining([`task:${owe.id}`, `project:${pilot.id}`]));
    // Nothing is sent: the only new audit rows are the AI reads and one "draft" record, and there is no send field in the response.
    const after = await db.select().from(auditEventsTable);
    const added = after.slice(before.length).map((a) => a.action);
    expect(added.filter((a) => a !== "read")).toEqual(["draft"]);
    expect(Object.keys(r.body).sort()).toEqual(expect.not.arrayContaining(["sent", "sentAt"]));
    // The person is still overdue: drafting is not contact.
    expect(await statusOf(anna.slug)).toMatchObject({ status: "overdue" });
  });

  it("criterion 4: pausing their project removes them from Overdue", async () => {
    const anna = await monthlyAnna();
    const pilot = await project("Pilot scheme");
    await link("person", anna.id, "project", pilot.id);
    expect(await statusOf(anna.slug)).toMatchObject({ status: "overdue" });

    expect((await api(`projects/${pilot.slug}`, { method: "PATCH", body: { lifecycle: "paused" } })).status).toBe(200);
    expect(await statusOf(anna.slug)).toMatchObject({ status: "paused" });
    expect((await api("people/cadence?tab=overdue")).body.people).toEqual([]);
    const c = await claude();
    const r = await call(c, "list_overdue_contacts", { include_due_soon: true });
    await c.close();
    expect(r.json.people).toEqual([]);
  });
});

/* ---------- 06 Document index ---------- */

describe("06 Document index", () => {
  it("criterion 1: pasting a Dropbox or Drive link creates a document with the right location", async () => {
    const d1 = await api("documents", { body: { url: "https://www.dropbox.com/scl/fi/abc123/RAF-proposal-v3.pdf?rlkey=x&dl=0", projectIds: [] } });
    expect(d1.status).toBe(201);
    expect(d1.body).toMatchObject({ location: "dropbox" });
    expect(d1.body.title).toMatch(/RAF/);
    const d2 = await api("documents", { body: { url: "https://docs.google.com/document/d/1AbC/edit", title: "PwC brief", projectIds: [] } });
    expect(d2.body).toMatchObject({ location: "gdrive", title: "PwC brief" });
    const d3 = await api("documents", { body: { url: "https://drive.google.com/drive/folders/xyz", projectIds: [] } });
    expect(d3.body.location).toBe("gdrive");
    expect((await api("documents", { body: { url: "not a link", projectIds: [] } })).status).toBe(400);
  });

  it("criterion 2: the project page lists its documents", async () => {
    const raf = await project("RAF Micro Internship");
    const other = await project("Garden shed");
    const doc = (await api("documents", { body: { url: "https://www.dropbox.com/s/1/brief.pdf", title: "RAF brief", projectIds: [raf.id] } })).body;
    await api("documents", { body: { url: "https://www.dropbox.com/s/2/shed.pdf", title: "Shed plans", projectIds: [other.id] } });
    const page = (await api(`projects/${raf.slug}`)).body;
    expect(page.documents.map((d: { id: number }) => d.id)).toEqual([doc.id]);
  });

  it("criterion 3: a confidential document never appears in MCP results", async () => {
    const raf = await project("RAF Micro Internship");
    const secret = await project("Sale process", { confidential: true });
    await api("documents", { body: { url: "https://www.dropbox.com/s/1/brief.pdf", title: "RAF brief", summary: "Programme brief", projectIds: [raf.id] } });
    await api("documents", { body: { url: "https://www.dropbox.com/s/2/terms.pdf", title: "RAF salary terms", summary: "Programme pay", projectIds: [raf.id], confidential: true } });
    await api("documents", { body: { url: "https://www.dropbox.com/s/3/valuation.pdf", title: "RAF valuation", summary: "Programme valuation", projectIds: [secret.id] } });

    const c = await claude();
    const found = await call(c, "find_documents", { query: "RAF" });
    const searched = await call(c, "search", { query: "RAF" });
    const ctx = await call(c, "get_context", { name: "RAF Micro Internship" });
    await c.close();
    for (const r of [found, searched, ctx]) {
      expect(r.text).toMatch(/RAF brief/);
      expect(r.text).not.toMatch(/salary|valuation/i);
    }
  });
});

/* ---------- 07 Playbooks ---------- */

describe("07 Playbooks", () => {
  it("criterion 1: get_context for PwC Skills for Tomorrow includes the PwC terminology playbook", async () => {
    await seed();
    await project("PwC Skills for Tomorrow");
    const c = await claude();
    const r = await call(c, "get_context", { name: "PwC Skills for Tomorrow" });
    await c.close();
    const titles = (r.json.playbooks as { title: string; rule: string }[]).map((p) => p.title);
    expect(titles).toContain("PwC terminology");
    expect(r.text).toMatch(/experience credits/);
  });

  it("criterion 2: pausing a playbook removes it from all AI responses immediately", async () => {
    await seed();
    const pwc = await project("PwC Skills for Tomorrow");
    const anna = await person("Anna Clarke");
    await db.update(peopleTable).set({ cadence: "monthly", lastContactAt: daysAgo(40) }).where(eq(peopleTable.id, anna.id));
    await link("person", anna.id, "project", pwc.id);
    const [pb] = await db.select().from(playbooksTable).where(eq(playbooksTable.title, "PwC terminology"));
    expect((await api(`playbooks/${pb.id}`, { method: "PATCH", body: { enabled: false } })).status).toBe(200);

    const c = await claude();
    const outs = [
      await call(c, "get_context", { name: "PwC Skills for Tomorrow" }),
      await call(c, "get_context", { name: "Anna Clarke" }),
      await call(c, "get_playbooks", {}),
      await call(c, "get_playbooks", { context: { name: "PwC Skills for Tomorrow" } }),
      await call(c, "search", { query: "experience credits" }),
    ];
    await c.close();
    for (const r of outs) expect(r.text).not.toMatch(/PwC terminology|experience credits/);

    checkInDocs.length = 0;
    expect((await api(`people/${anna.slug}/check-in-draft`, { body: {} })).status).toBe(200);
    expect(checkInDocs[0].map((d) => d.ref)).not.toContain(`playbook:${pb.id}`);

    // Switching it back on brings it straight back.
    await api(`playbooks/${pb.id}`, { method: "PATCH", body: { enabled: true } });
    const c2 = await claude();
    expect((await call(c2, "get_context", { name: "PwC Skills for Tomorrow" })).text).toMatch(/PwC terminology/);
    await c2.close();
  });

  it("criterion 3: a playbook proposed by AI appears in the Knowledge Inbox and stays inactive until approved", async () => {
    await seed();
    const r = await ingest("suggestions", {
      body: { suggestions: [{ kind: "playbook", title: "Defence acronyms", applies_when: "Any defence material", rule: "Spell out every acronym on first use.", source: "Chat with Claude" }] },
    });
    expect(r.status).toBe(200);
    expect(r.body.results[0].status).toBe("suggested");

    const inbox = (await api("suggestions?tab=suggested")).body;
    const item = inbox.items.find((i: { kind: string }) => i.kind === "new_playbook");
    expect(item).toBeTruthy();
    expect(await db.select().from(playbooksTable).where(eq(playbooksTable.title, "Defence acronyms"))).toEqual([]);
    const c = await claude();
    expect((await call(c, "get_playbooks", {})).text).not.toMatch(/Defence acronyms/);

    expect((await api(`suggestions/${item.id}/approve`, { body: {} })).status).toBe(200);
    const [row] = await db.select().from(playbooksTable).where(eq(playbooksTable.title, "Defence acronyms"));
    expect(row.enabled).toBe(true);
    expect((await call(c, "get_playbooks", {})).text).toMatch(/Defence acronyms/);
    await c.close();
  });
});

