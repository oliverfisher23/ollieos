/** Knowledge Inbox: approving or rejecting many cards at once. */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, decisionsTable, factsTable, suggestionsTable } from "@workspace/db";
import { propose } from "../src/services/suggestions";
import { api, useServer } from "./harness";
import { organisation } from "./helpers";

useServer();

const meta = { proposedBy: "Gmail sorter", clientId: null, sourceType: "email" };
const fact = async (orgId: number, text: string, attribute: "status" | null = null) =>
  (await propose(meta, { kind: "fact", entityType: "organisation", entityId: orgId, payload: { text, attribute, supersedes: null, source: null } })) as { status: string; suggestionId: number };

describe("bulk decisions in the Knowledge Inbox", () => {
  it("approves many cards as they stand, and skips one waiting on the Conflicts tab", async () => {
    const acme = await organisation("Acme");
    const a = await fact(acme.id, "Acme has 400 staff");
    const b = await fact(acme.id, "Acme is based in Leeds");
    const d = (await propose(meta, { kind: "decision", entityType: null, entityId: null, payload: { text: "We will run the pilot in spring", decided_at: "2026-11-01" } })) as { suggestionId: number };
    await db.insert(factsTable).values({ entityType: "organisation", entityId: acme.id, text: "Status: talking", attribute: "status", createdBy: "ollie" });
    const c = await fact(acme.id, "Status: signed", "status");
    expect(c.status).toBe("conflict");

    const res = await api("suggestions/bulk", { method: "POST", body: { action: "approve", ids: [a.suggestionId, b.suggestionId, d.suggestionId, c.suggestionId, a.suggestionId] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ approved: 3, rejected: 0 });
    expect(res.body.skipped).toEqual([{ id: c.suggestionId, reason: expect.stringContaining("Conflicts tab") }]);
    expect((await db.select().from(factsTable).where(eq(factsTable.entityId, acme.id))).map((f) => f.text).sort()).toEqual(["Acme has 400 staff", "Acme is based in Leeds", "Status: talking"]);
    expect(await db.select().from(decisionsTable)).toHaveLength(1);

    // Already decided: skipped, not decided twice.
    const again = await api("suggestions/bulk", { method: "POST", body: { action: "reject", ids: [a.suggestionId] } });
    expect(again.body).toMatchObject({ approved: 0, rejected: 0, skipped: [{ id: a.suggestionId }] });
  });

  it("rejects many cards at once", async () => {
    const acme = await organisation("Acme");
    const ids = [(await fact(acme.id, "One")).suggestionId, (await fact(acme.id, "Two")).suggestionId];
    const res = await api("suggestions/bulk", { method: "POST", body: { action: "reject", ids } });
    expect(res.body).toEqual({ approved: 0, rejected: 2, skipped: [] });
    const rows = await db.select().from(suggestionsTable);
    expect(rows.every((r) => r.status === "rejected")).toBe(true);
    expect(await db.select().from(factsTable)).toHaveLength(0);
    expect((await api("suggestions/bulk", { method: "POST", body: { action: "reject", ids: [] } })).status).toBe(400);
  });
});
