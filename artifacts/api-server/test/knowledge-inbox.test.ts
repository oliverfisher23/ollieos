/**
 * Milestone 6, "Trust": feature 01 (Knowledge Inbox) and feature 02 (stale and conflicting facts).
 */
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { auditEventsTable, db, decisionsTable, factReviewsTable, factsTable, suggestionsTable } from "@workspace/db";
import { loadVisibleDocs } from "../src/lib/ai-data/retrieve";
import { onSweepFinished } from "../src/services/factReviews";
import { client, project, scopeFor } from "./helpers";
import { api, call, connect, ingest, mcp, useServer } from "./harness";

useServer();

const DAY = 86_400_000;

async function claude() {
  return mcp((await connect()).access_token);
}

async function inbox(tab: "suggested" | "conflicts" | "stale" = "suggested") {
  const r = await api(`suggestions?tab=${tab}`);
  expect(r.status).toBe(200);
  return r.body as { counts: Record<string, number>; items: Record<string, any>[] };
}

async function currentFacts(projectId: number) {
  return db
    .select()
    .from(factsTable)
    .where(and(eq(factsTable.entityType, "project"), eq(factsTable.entityId, projectId), isNull(factsTable.supersededBy)));
}

async function addFact(projectId: number, text: string, opts: { attribute?: "status" | "next_step"; confirmedDaysAgo?: number } = {}) {
  const at = new Date(Date.now() - (opts.confirmedDaysAgo ?? 0) * DAY);
  const [row] = await db
    .insert(factsTable)
    .values({ entityType: "project", entityId: projectId, text, attribute: opts.attribute ?? null, createdBy: "ollie", createdAt: at, lastConfirmedAt: at })
    .returning();
  return row;
}

/* ---------- Feature 01 ---------- */

describe("Knowledge Inbox (feature 01)", () => {
  it("criterion 1: add_fact creates a pending suggestion, not a fact", async () => {
    const shed = await project("Garden shed");
    const c = await claude();
    const r = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k", source: "Email from Jo, 3rd November" });
    await c.close();
    expect(r.json).toMatchObject({ status: "suggested", suggestion_id: expect.any(Number) });
    expect(await db.select().from(factsTable)).toEqual([]);
    const [s] = await db.select().from(suggestionsTable);
    expect(s).toMatchObject({ kind: "fact", status: "pending", entityType: "project", entityId: shed.id, proposedBy: "Claude", sourceLabel: "Email from Jo, 3rd November" });
    const view = await inbox();
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ kind: "new_fact", by: "Claude", text: "Budget is 3k", target: { name: "Garden shed" } });
  });

  it("a look-back decision with no speaker still carries the meeting date", async () => {
    await db.insert(suggestionsTable).values({
      kind: "decision",
      payload: { text: "Cap client review at three rounds", decided_at: "2026-07-29", decided_by: null, source: "Granola: Workshop" },
      normalisedText: "cap client review at three rounds",
      proposedBy: "Granola look back",
      sourceType: "meeting",
      sourceLabel: "Granola: Workshop",
    });
    const view = await inbox();
    expect(view.items[0]).toMatchObject({ lookBack: true, saidBy: null, saidAt: "2026-07-29T12:00:00.000Z" });
  });

  it("criterion 2: approving creates the fact with its source and audit event; rejecting creates nothing", async () => {
    const shed = await project("Garden shed");
    const c = await claude();
    const keep = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k", source: "Email from Jo" });
    const drop = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Roof is felt" });
    const decision = await call(c, "log_decision", { project: { name: "Garden shed" }, text: "Go with timber", decided_at: "2026-11-02" });
    await c.close();

    const ok = await api(`suggestions/${keep.json.suggestion_id}/approve`, { body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "approved", result: { type: "fact" } });
    const facts = await currentFacts(shed.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ text: "Budget is 3k", source: "Email from Jo", createdBy: "Claude", suggestionId: keep.json.suggestion_id });
    expect(facts[0].approvedAt).not.toBeNull();
    const audit = await db.select().from(auditEventsTable).where(eq(auditEventsTable.entityType, "fact"));
    expect(audit).toEqual([expect.objectContaining({ action: "create", entityId: facts[0].id, actor: "ollie" })]);

    const no = await api(`suggestions/${drop.json.suggestion_id}/reject`, { body: {} });
    expect(no.body).toMatchObject({ status: "rejected", result: null });
    expect(await currentFacts(shed.id)).toHaveLength(1);
    expect((await api(`suggestions/${drop.json.suggestion_id}/approve`, { body: {} })).status).toBe(400);

    // A decision stays a proposal until approved.
    expect(await db.select().from(decisionsTable)).toEqual([]);
    await api(`suggestions/${decision.json.suggestion_id}/approve`, { body: {} });
    expect(await db.select().from(decisionsTable)).toEqual([expect.objectContaining({ text: "Go with timber", decidedAt: "2026-11-02", createdBy: "Claude" })]);
    expect((await inbox()).items).toEqual([]);
  });

  it("criterion 3: edit, then approve saves the edited text", async () => {
    const shed = await project("Garden shed");
    const c = await claude();
    const r = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k" });
    await c.close();
    expect((await api(`suggestions/${r.json.suggestion_id}/approve`, { body: { fields: { name: "x" } } })).status).toBe(400);
    const ok = await api(`suggestions/${r.json.suggestion_id}/approve`, { body: { fields: { text: "Budget is 3.5k including VAT" } } });
    expect(ok.status).toBe(200);
    expect((await currentFacts(shed.id)).map((f) => f.text)).toEqual(["Budget is 3.5k including VAT"]);
  });

  it("criterion 4: a rejected suggestion is not re-created within 30 days", async () => {
    await project("Garden shed");
    const c = await claude();
    const first = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k" });
    await api(`suggestions/${first.json.suggestion_id}/reject`, { body: {} });
    const again = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "budget is 3k." });
    expect(again.json).toMatchObject({ status: "previously_rejected", suggestion_id: first.json.suggestion_id });
    expect(await db.select().from(suggestionsTable)).toHaveLength(1);
    const mine = await call(c, "list_my_suggestions", { status: "rejected" });
    expect(mine.json.suggestions).toEqual([expect.objectContaining({ suggestion_id: first.json.suggestion_id, status: "rejected", text: "Budget is 3k" })]);

    // After 30 days it may come back, and the sweep clears the old rejection.
    await db.update(suggestionsTable).set({ decidedAt: new Date(Date.now() - 31 * DAY) });
    expect((await onSweepFinished(new Date())).cleared).toBe(1);
    expect((await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k" })).json.status).toBe("suggested");
    await c.close();
  });

  it("criterion 5: the pending count shows on Home", async () => {
    await project("Garden shed");
    const c = await claude();
    await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k" });
    await call(c, "upsert_person", { name: "Jo Bloggs", role: "Builder" });
    await c.close();
    const home = await api("home");
    expect(home.body.knowledgeInbox).toEqual({ suggested: 2, conflicts: 0, outOfDate: 0, stale: 0, total: 2 });
  });

  it("list_my_suggestions shows only this client's suggestions on things it can see", async () => {
    const shed = await project("Garden shed");
    await project("Greenhouse");
    const c = await claude();
    await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k" });
    await call(c, "add_fact", { entity: { name: "Greenhouse" }, text: "Glass panels" });
    await call(c, "log_decision", { project: { name: "Greenhouse" }, text: "Private call", confidential: true });
    const other = await client("Other tool");
    await db.insert(suggestionsTable).values({ kind: "fact", entityType: "project", entityId: shed.id, payload: { text: "Not mine" }, normalisedText: "not mine", proposedBy: other.name, clientId: other.id });
    await db.execute(`update projects set confidential = true where name = 'Greenhouse'` as never);
    const mine = await call(c, "list_my_suggestions", {});
    await c.close();
    expect((mine.json.suggestions as { text: string }[]).map((s) => s.text)).toEqual(["Budget is 3k"]);
  });

  it("ingest proposes knowledge and reports each item", async () => {
    const shed = await project("Garden shed", { summary: "Timber shed" });
    const r = await ingest("suggestions", {
      body: {
        suggestions: [
          { kind: "fact", entity: "Garden shed", text: "Budget is 3k", source_type: "email", source: "Email from Jo" },
          { kind: "person", name: "Jo Bloggs", email: "jo@example.com", role: "Builder" },
          { kind: "project", name: "Garden shed", summary: "Timber shed" },
          { kind: "project", name: "Garden shed", status: "Waiting on quote" },
          { kind: "fact", entity: "Nowhere", text: "x" },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { status: string }) => x.status)).toEqual(["suggested", "suggested", "unchanged", "suggested", "error"]);
    expect(r.body.counts).toMatchObject({ suggested: 3, unchanged: 1, error: 1 });
    const view = await inbox();
    const change = view.items.find((i) => i.kind === "changed_details" || i.kind === "changed_summary");
    expect(change).toMatchObject({ target: { id: shed.id }, by: "Capture sweep" });
    expect(await db.select().from(factsTable)).toEqual([]);
  });
});

/* ---------- Feature 02 ---------- */

describe("Stale and conflicting facts (feature 02)", () => {
  it("criterion 1: a status fact unconfirmed for 31 days appears under Needs a check after the weekly job", async () => {
    const shed = await project("Garden shed");
    const stale = await addFact(shed.id, "On track", { attribute: "status", confirmedDaysAgo: 31 });
    await addFact(shed.id, "Built in 2019", { confirmedDaysAgo: 31 });
    await addFact(shed.id, "Next: order timber", { attribute: "next_step", confirmedDaysAgo: 5 });
    expect((await inbox("stale")).items).toEqual([]);
    const check = await api("settings/knowledge/check", { body: {} });
    expect(check.body).toEqual({ stale: 1, conflicts: 0 });
    const view = await inbox("stale");
    expect(view.items).toEqual([expect.objectContaining({ kind: "stale_fact", text: "On track", attribute: "Status" })]);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, stale.id));
    expect(row.needsCheck).toBe(true);
    // Running again does not add the same fact twice.
    expect((await api("settings/knowledge/check", { body: {} })).body).toEqual({ stale: 0, conflicts: 0 });
  });

  it("runs on the first sweep finish after Sunday 18:00 and not again that week", async () => {
    const shed = await project("Garden shed");
    await addFact(shed.id, "On track", { attribute: "status", confirmedDaysAgo: 40 });
    expect((await onSweepFinished(new Date())).check).toEqual({ stale: 1, conflicts: 0 });
    await addFact(shed.id, "Next: order timber", { attribute: "next_step", confirmedDaysAgo: 40 });
    expect((await onSweepFinished(new Date())).check).toBeNull();
  });

  it("shelf lives can be changed in settings", async () => {
    const shed = await project("Garden shed");
    await addFact(shed.id, "Built in 2019", { confirmedDaysAgo: 31 });
    expect((await api("settings/knowledge")).body.shelfLifeDays.general).toBe(90);
    const r = await api("settings/knowledge", { method: "PATCH", body: { shelfLifeDays: { general: 30 } } });
    expect(r.body.shelfLifeDays).toMatchObject({ general: 30, status: 30 });
    expect((await api("settings/knowledge", { method: "PATCH", body: { shelfLifeDays: { general: 0 } } })).status).toBe(400);
    expect((await api("settings/knowledge/check", { body: {} })).body.stale).toBe(1);
  });

  it("criterion 2: Still true removes it from the list and resets its shelf life", async () => {
    const shed = await project("Garden shed");
    const f = await addFact(shed.id, "On track", { attribute: "status", confirmedDaysAgo: 31 });
    await api("settings/knowledge/check", { body: {} });
    const [card] = (await inbox("stale")).items;
    const before = Date.now();
    expect((await api(`fact-reviews/${card.id}/resolve`, { body: { action: "still_true" } })).status).toBe(200);
    expect((await inbox("stale")).items).toEqual([]);
    const [row] = await db.select().from(factsTable).where(eq(factsTable.id, f.id));
    expect(row.needsCheck).toBe(false);
    expect(row.lastConfirmedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.supersededBy).toBeNull();
    expect((await api(`fact-reviews/${card.id}/resolve`, { body: { action: "still_true" } })).status).toBe(400);
  });

  it("criteria 3 and 4: two current facts that disagree make one conflict card; resolving supersedes the loser and history keeps both", async () => {
    const shed = await project("Garden shed");
    const a = await addFact(shed.id, "On track", { attribute: "status" });
    const b = await addFact(shed.id, "Delayed by two weeks", { attribute: "status" });
    expect((await api("settings/knowledge/check", { body: {} })).body).toEqual({ stale: 0, conflicts: 1 });
    const view = await inbox("conflicts");
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toMatchObject({ kind: "conflict", attribute: "Status" });
    expect(view.items[0].options.map((o: { ref: string }) => o.ref).sort()).toEqual([`fact:${a.id}`, `fact:${b.id}`]);

    await api(`fact-reviews/${view.items[0].id}/resolve`, { body: { action: "keep", ref: `fact:${b.id}` } });
    expect((await inbox("conflicts")).items).toEqual([]);
    const [loser] = await db.select().from(factsTable).where(eq(factsTable.id, a.id));
    expect(loser.supersededBy).toBe(b.id);
    const page = await api(`projects/${shed.slug}`);
    expect(page.body.facts).toHaveLength(1);
    expect(page.body.facts[0]).toMatchObject({ id: b.id, needsCheck: false });
    expect(page.body.facts[0].history.map((h: { id: number }) => h.id)).toEqual([a.id]);
  });

  it("a proposed fact that disagrees with a current one goes to Conflicts, not Suggested", async () => {
    const shed = await project("Garden shed");
    const current = await addFact(shed.id, "On track", { attribute: "status" });
    const c = await claude();
    const r = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Delayed", attribute: "status" });
    await c.close();
    expect(r.json).toMatchObject({ status: "conflict", review_id: expect.any(Number) });
    expect((await inbox()).items).toEqual([]);
    const conflicts = await inbox("conflicts");
    expect(conflicts.items).toHaveLength(1);
    expect((await api(`suggestions/${r.json.suggestion_id}/approve`, { body: {} })).status).toBe(400);
    const options = conflicts.items[0].options.map((o: { ref: string }) => o.ref);
    expect(options).toEqual(expect.arrayContaining([`fact:${current.id}`, `suggestion:${r.json.suggestion_id}`]));

    await api(`fact-reviews/${conflicts.items[0].id}/resolve`, { body: { action: "keep", ref: `suggestion:${r.json.suggestion_id}` } });
    const facts = await currentFacts(shed.id);
    expect(facts.map((f) => f.text)).toEqual(["Delayed"]);
    const [s] = await db.select().from(suggestionsTable);
    expect(s.status).toBe("approved");
    expect((await db.select().from(factReviewsTable))[0].status).toBe("resolved");
  });

  it("criterion 5: facts that need a check are marked for Ask and for AI tools", async () => {
    const shed = await project("Garden shed");
    const f = await addFact(shed.id, "On track", { attribute: "status", confirmedDaysAgo: 31 });
    await api("settings/knowledge/check", { body: {} });
    const asker = await client("Ask OllieOS");
    const docs = await loadVisibleDocs(await scopeFor(asker), [`fact:${f.id}`]);
    expect(docs[0].text).toContain("NEEDS A CHECK");
    const c = await claude();
    const ctx = await call(c, "get_context", { name: "Garden shed" });
    expect(ctx.json.facts).toEqual([expect.objectContaining({ text: "On track", attribute: "status", needs_check: true })]);
    const found = await call(c, "search", { query: "track" });
    expect(JSON.stringify(found.json)).toContain('"needs_check":true');
    await c.close();
  });
});
