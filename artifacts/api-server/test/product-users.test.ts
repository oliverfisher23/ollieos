/**
 * A product's primary user: Ollie sets it from his fixed list, and AI suggests it from what OllieOS
 * knows, as a Knowledge Inbox card he approves.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, factsTable, productsTable } from "@workspace/db";
import { api, call, connect, mcp, useServer } from "./harness";

/** What the fake Haiku answers, by product name, and what it was shown */
let answers: Record<string, { primary_user: string; why: string }> = {};
const shown: string[] = [];

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    shown.push(content);
    const name = /<product>\n([^:\n]+)/.exec(content)![1];
    return { reasoning: "", ...(answers[name] ?? { primary_user: "unclear", why: "" }) };
  },
}));

useServer();

describe("primary user", () => {
  it("is set and cleared by Ollie, and shows in the list", async () => {
    const made = (await api("products", { body: { name: "Job Simulations", primaryUser: "students" } })).body;
    expect(made.primaryUser).toBe("students");
    expect((await api(`products/${made.slug}`, { method: "PATCH", body: { primaryUser: "employers" } })).body.primaryUser).toBe("employers");
    expect((await api(`products/${made.slug}`, { method: "PATCH", body: { primaryUser: "parents" } })).status).toBe(400);
    const list = (await api("products")).body as unknown as { slug: string; primaryUser: string | null }[];
    expect(list.find((p) => p.slug === made.slug)?.primaryUser).toBe("employers");
    expect((await api(`products/${made.slug}`, { method: "PATCH", body: { primaryUser: null } })).body.primaryUser).toBeNull();
  });

  it("is suggested by AI from what OllieOS knows, and only set when Ollie approves", async () => {
    answers = {
      "Skills Labs": { primary_user: "students", why: "The facts describe students completing it online." },
      "Talent Networks": { primary_user: "unclear", why: "" },
    };
    const labs = (await api("products", { body: { name: "Skills Labs" } })).body;
    await api("products", { body: { name: "Talent Networks" } });
    await api("products", { body: { name: "Opportunities", primaryUser: "employers" } });
    await api("products", { body: { name: "Hidden One", confidential: true } });
    await db.insert(factsTable).values({ entityType: "product", entityId: labs.id, text: "Students complete Skills Labs online in a week.", createdBy: "ollie" });

    const r = (await api("products/suggest-users", { body: {} })).body;
    expect(r).toEqual({ checked: 2, suggested: 1, unclear: 1 });
    // Confidential products and ones that already have a primary user are never sent.
    expect(shown.some((c) => c.includes("Hidden One") || c.includes("<product>\nOpportunities"))).toBe(false);
    expect(shown.find((c) => c.includes("<product>\nSkills Labs"))).toMatch(/Students complete Skills Labs online/);

    const inbox = (await api("suggestions?tab=suggested")).body;
    const card = inbox.items.find((i: { target: { name: string } | null }) => i.target?.name === "Skills Labs");
    expect(card.kind).toBe("changed_details");
    expect(card.text).toBe("Primary user: Students\nWhy: The facts describe students completing it online.");
    expect(card.fields).toEqual([expect.objectContaining({ key: "primary_user", value: "Students", editable: false })]);
    const [before] = await db.select().from(productsTable).where(eq(productsTable.id, labs.id));
    expect(before.primaryUser).toBeNull();

    // A card already waiting means the product is not asked about again.
    expect((await api("products/suggest-users", { body: {} })).body).toEqual({ checked: 1, suggested: 0, unclear: 1 });

    expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    const [after] = await db.select().from(productsTable).where(eq(productsTable.id, labs.id));
    expect(after.primaryUser).toBe("students");
  });

  it("can be proposed by Claude for an existing or a new product", async () => {
    const known = (await api("products", { body: { name: "Micro Internships" } })).body;
    const c = await mcp((await connect()).access_token);
    const r = await call(c, "propose_product", { name: "Micro Internships", primary_user: "students", primary_user_why: "Students do them over a fortnight." });
    expect(r.json.status).toBe("suggested");
    const again = await call(c, "propose_product", { name: "Career Moments", primary_user: "schools" });
    expect(again.json.status).toBe("suggested");
    await c.close();

    const inbox = (await api("suggestions?tab=suggested")).body;
    const change = inbox.items.find((i: { target: { name: string } | null }) => i.target?.name === "Micro Internships");
    expect(change.text).toBe("Primary user: Students\nWhy: Students do them over a fortnight.");
    const fresh = inbox.items.find((i: { kind: string }) => i.kind === "new_product");
    expect(fresh.text).toMatch(/Primary user: Schools/);
    expect((await api(`suggestions/${fresh.id}/approve`, { body: {} })).status).toBe(200);
    const [made] = await db.select().from(productsTable).where(eq(productsTable.name, "Career Moments"));
    expect(made.primaryUser).toBe("schools");
    expect(known.primaryUser).toBeNull();
  });
});
