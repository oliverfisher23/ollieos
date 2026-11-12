/**
 * Functions and clients: Delivery, Product, Sales and Marketing are fixed records every project can
 * belong to, and a project's clients are its linked customer or partner organisations. AI suggests
 * both as Knowledge Inbox cards Ollie approves.
 */
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, factsTable, linksTable, organisationsTable, projectsTable } from "@workspace/db";
import { api, call, connect, mcp, useServer } from "./harness";

/** What the fake Haiku answers, by project name, and what it was shown */
let answers: Record<string, { function: string; function_why?: string; client: string; client_why?: string; client_summary?: string }> = {};
const shown: string[] = [];

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    shown.push(content);
    const name = /<project>\n([^:\n]+)/.exec(content)![1];
    return { reasoning: "", function_why: "", client_why: "", client_summary: "", ...(answers[name] ?? { function: "unclear", client: "" }) };
  },
}));

useServer();

type ListItem = { id: number; slug: string; name: string; function: string | null; isFunction: boolean; clients: string[] };
const list = async () => (await api("projects")).body as unknown as ListItem[];

describe("functions", () => {
  it("turns the old Go-to-market project into Sales, keeping what is on it, and adds the rest", async () => {
    const gtm = (await api("projects", { body: { name: "Go-to-market" } })).body;
    await db.insert(factsTable).values({ entityType: "project", entityId: gtm.id, text: "Pipeline review is every Monday.", createdBy: "ollie" });
    const all = await list();
    const fns = all.filter((p) => p.isFunction);
    expect(fns.map((p) => p.function).sort()).toEqual(["delivery", "marketing", "product", "sales"]);
    const sales = fns.find((p) => p.function === "sales")!;
    expect(sales.id).toBe(gtm.id);
    expect(sales.name).toBe("Sales");
    // Running again changes nothing.
    expect((await list()).filter((p) => p.isFunction)).toHaveLength(4);

    const page = (await api(`projects/${sales.slug}`)).body;
    expect(page.project.isFunction).toBe(true);
    expect(page.facts.map((f: { text: string }) => f.text)).toContain("Pipeline review is every Monday.");

    // A function cannot be renamed, given a function or archived.
    expect((await api(`projects/${sales.slug}`, { method: "PATCH", body: { name: "Selling" } })).status).toBe(400);
    expect((await api(`projects/${sales.slug}`, { method: "PATCH", body: { archived: true } })).status).toBe(400);
    expect((await api(`projects/${sales.slug}`, { method: "PATCH", body: { function: "delivery" } })).status).toBe(400);
    // Its summary can change.
    expect((await api(`projects/${sales.slug}`, { method: "PATCH", body: { summary: "Winning and renewing clients." } })).status).toBe(200);
  });

  it("files a project under a function and lists it on the function's page with its clients", async () => {
    await list();
    const p = (await api("projects", { body: { name: "Client Rollout", function: "delivery" } })).body;
    expect(p.function).toBe("delivery");
    expect((await api(`projects/${p.slug}`, { method: "PATCH", body: { function: "nonsense" } })).status).toBe(400);
    const org = (await api("organisations", { body: { name: "Acme Partner", type: "Customer" } })).body;
    await db.insert(linksTable).values({ fromType: "project", fromId: p.id, toType: "organisation", toId: org.id, createdBy: "ollie" });

    const item = (await list()).find((x) => x.id === p.id)!;
    expect(item.clients).toEqual(["Acme Partner"]);
    const page = (await api(`projects/${p.slug}`)).body;
    expect(page.clientIds).toEqual([org.id]);
    const delivery = (await list()).find((x) => x.isFunction && x.function === "delivery")!;
    const fnPage = (await api(`projects/${delivery.slug}`)).body;
    expect(fnPage.functionProjects).toEqual([expect.objectContaining({ id: p.id, clients: ["Acme Partner"], documentCount: 0, openTaskCount: 0 })]);
  });
});

describe("AI suggestions for functions and clients", () => {
  it("proposes functions and clients, and only applies them when Ollie approves", async () => {
    await list();
    const known = (await api("organisations", { body: { name: "Known Partner", type: "Partner" } })).body;
    const a = (await api("projects", { body: { name: "Alpha Programme" } })).body;
    const b = (await api("projects", { body: { name: "Beta Pilot" } })).body;
    const c = (await api("projects", { body: { name: "Gamma Review" } })).body;
    await api("projects", { body: { name: "Secret Work", confidential: true } });
    for (const p of [a, b, c]) {
      await db.insert(factsTable).values({ entityType: "project", entityId: p.id, text: `${p.name} is running this term.`, createdBy: "ollie" });
    }
    answers = {
      "Alpha Programme": { function: "delivery", function_why: "The facts describe running it.", client: "known partner", client_why: "The facts name them." },
      "Beta Pilot": { function: "sales", client: "New Customer Ltd", client_summary: "A company piloting with Springpod." },
      "Gamma Review": { function: "unclear", client: "" },
    };

    const r = (await api("projects/suggest-functions", { body: {} })).body;
    expect(r).toEqual({ checked: 3, functions: 2, clients: 2, workTypes: 0, unclear: 1 });
    expect(shown.some((s) => s.includes("Secret Work"))).toBe(false);
    expect(shown.some((s) => /<project>\n(Delivery|Product|Sales|Marketing)\b/.test(s))).toBe(false);
    expect(shown.find((s) => s.includes("<project>\nAlpha Programme"))).toMatch(/Alpha Programme is running this term/);

    const inbox = (await api("suggestions?tab=suggested")).body;
    const cards = inbox.items as { id: number; kind: string; text: string; target: { name: string } | null }[];
    const alpha = cards.filter((i) => i.target?.name === "Alpha Programme");
    expect(alpha.map((i) => i.text).sort()).toEqual(["Client: Known Partner\nWhy: The facts name them.", "Function: Delivery\nWhy: The facts describe running it."]);
    const newOrg = cards.find((i) => i.kind === "new_organisation")!;
    expect(newOrg.text).toMatch(/New Customer Ltd/);
    expect(newOrg.text).toMatch(/Client for Beta Pilot/);

    // Nothing changed yet; and a second run asks about nothing that has a card waiting.
    expect((await list()).find((p) => p.id === a.id)?.function).toBeNull();
    expect((await api("projects/suggest-functions", { body: {} })).body).toEqual({ checked: 1, functions: 0, clients: 0, workTypes: 0, unclear: 1 });

    for (const card of [...alpha, newOrg]) expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    const after = await list();
    expect(after.find((p) => p.id === a.id)).toMatchObject({ function: "delivery", clients: ["Known Partner"] });
    expect(after.find((p) => p.id === b.id)?.clients).toEqual(["New Customer Ltd"]);
    const [made] = await db.select().from(organisationsTable).where(eq(organisationsTable.name, "New Customer Ltd"));
    expect(made.type).toBe("customer");
    const [link] = await db.select().from(linksTable).where(and(eq(linksTable.fromType, "project"), eq(linksTable.fromId, a.id), eq(linksTable.toId, known.id)));
    expect(link).toBeDefined();
  });

  it("adds a second project to an organisation card already waiting", async () => {
    await list();
    const a = (await api("projects", { body: { name: "One Project" } })).body;
    const b = (await api("projects", { body: { name: "Two Project" } })).body;
    for (const p of [a, b]) await db.insert(factsTable).values({ entityType: "project", entityId: p.id, text: `${p.name} is for Shared Client.`, createdBy: "ollie" });
    answers = {
      "One Project": { function: "unclear", client: "Shared Client" },
      "Two Project": { function: "unclear", client: "Shared Client" },
    };
    expect((await api("projects/suggest-functions", { body: {} })).body.clients).toBe(2);
    const inbox = (await api("suggestions?tab=suggested")).body;
    const orgs = (inbox.items as { id: number; kind: string; text: string }[]).filter((i) => i.kind === "new_organisation");
    expect(orgs).toHaveLength(1);
    expect((await api(`suggestions/${orgs[0].id}/approve`, { body: {} })).status).toBe(200);
    const after = await list();
    expect(after.find((p) => p.id === a.id)?.clients).toEqual(["Shared Client"]);
    expect(after.find((p) => p.id === b.id)?.clients).toEqual(["Shared Client"]);
  });

  it("lets Claude give a function and client when proposing a project", async () => {
    await list();
    await api("organisations", { body: { name: "Claude Client", type: "Customer" } });
    const existing = (await api("projects", { body: { name: "Existing Work" } })).body;
    const c = await mcp((await connect()).access_token);
    const r = await call(c, "upsert_project", { name: "Existing Work", function: "product", function_why: "It changes the platform." });
    expect(r.json.function.status).toBe("suggested");
    const fresh = await call(c, "upsert_project", { name: "Fresh Work", function: "marketing", client: "Claude Client" });
    expect(fresh.json.status).toBe("suggested");
    await c.close();

    const inbox = (await api("suggestions?tab=suggested")).body;
    const items = inbox.items as { id: number; kind: string; text: string; target: { name: string } | null }[];
    expect(items.find((i) => i.target?.name === "Existing Work")?.text).toBe("Function: Product\nWhy: It changes the platform.");
    const card = items.find((i) => i.kind === "new_project")!;
    expect(card.text).toMatch(/Function: Marketing/);
    expect(card.text).toMatch(/Client: Claude Client/);
    expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    const [made] = await db.select().from(projectsTable).where(eq(projectsTable.name, "Fresh Work"));
    expect(made.function).toBe("marketing");
    expect((await list()).find((p) => p.id === made.id)?.clients).toEqual(["Claude Client"]);
    expect(existing.function).toBeNull();
  });
});
