import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, decisionsTable, factReviewsTable, factsTable, linksTable, peopleTable, playbooksTable, rulesTable, suggestionsTable, weeklyRoundupsTable } from "@workspace/db";
import type { GmailRead, OutgoingDraft } from "../src/services/connectors/gmail";
import type { SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import type { JudgeCard, JudgeItem, JudgeVerdict } from "../src/services/contradictionJudge";
import { checkNewCards } from "../src/services/contradictions";
import { recheckContradictions } from "../src/services/migrations";
import { buildRoundupIfDue, lastRoundupTime } from "../src/services/roundup";
import { decision, fact, project } from "./helpers";
import { api, call, connect, mcp, useServer } from "./harness";

let nextGmail: GmailRead = { account: "ollie@example.com", units: [], found: 0, leftOut: 0, newest: null, more: false };
let nextSorted: SortedUnit[] = [];
const drafts: { threadId: string | null; draft: OutgoingDraft }[] = [];
/** What the stand-in model was shown, and a rule for what it finds. */
const judged: { card: JudgeCard; items: JudgeItem[] }[] = [];
let verdicts: (card: JudgeCard, items: JudgeItem[]) => JudgeVerdict[] = () => [];

vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  readGmail: async () => nextGmail,
  saveGmailDraft: async (threadId: string | null, draftId: string | null, draft: OutgoingDraft) => {
    drafts.push({ threadId, draft });
    return draftId ?? "draft-1";
  },
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[]) => units.map((_, i) => nextSorted[i] ?? { summary: "", project: "", items: [], knowledge: [] }),
}));
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
}));
vi.mock("../src/services/contradictionJudge", () => ({
  judgeContradictions: async (card: JudgeCard, items: JudgeItem[]) => {
    judged.push({ card, items });
    return verdicts(card, items);
  },
}));

useServer();

const DAY = 86_400_000;

/** Disagrees with any item mentioning the word. */
const disagreesWith = (word: string) => (_card: JudgeCard, items: JudgeItem[]) =>
  items.filter((i) => i.text.includes(word)).map((i) => ({ ref: i.ref, why: `One says ${word}, the other does not.` }));

async function samDecidesOn(projectId: number) {
  const [s] = await db.insert(peopleTable).values({ name: "Sam Lee", slug: "sam-lee", email: "sam@client.com" }).returning();
  await db.insert(linksTable).values({ fromType: "person", fromId: s.id, toType: "project", toId: projectId, relationship: "decides_on", createdBy: "ollie" });
  return s;
}

function email(id: string, text: string, at: Date): WorkUnit {
  return {
    source: "email",
    key: `gmail:${id}`,
    subject: "Atlas",
    channel: null,
    people: [{ name: "Sam Lee", email: "sam@client.com" }],
    messages: [{ ref: `gmail:${id}`, at, fromMe: false, fromName: "Sam Lee", fromAddress: "sam@client.com", text, url: `https://mail.google.com/mail/#all/${id}` }],
  };
}

/** A Gmail message from Sam saying the launch moved to March, read as a fact card on the project. */
async function marchEmail(at: Date) {
  nextGmail = { account: "ollie@example.com", units: [email("m1", "Heads up: the Atlas launch has moved to March.", at)], found: 1, leftOut: 0, newest: at, more: false };
  nextSorted = [
    {
      summary: "",
      project: "",
      items: [],
      knowledge: [{ ref: "gmail:m1", kind: "fact", about_type: "project", about: "Atlas launch", text: "Atlas launch is in March", said_by: "Sam Lee", quote: "the Atlas launch has moved to March", confidential: false }],
    },
  ];
  expect((await api("connectors/gmail/check", { method: "POST" })).body).toMatchObject({ ok: true });
  const [card] = await db.select().from(suggestionsTable);
  expect(card).toMatchObject({ kind: "fact", status: "pending" });
  return card;
}

/** Atlas launch with an approved fact saying February, a month old, and Sam deciding on it. */
async function atlas() {
  const p = await project("Atlas launch");
  const s = await samDecidesOn(p.id);
  const feb = await fact("project", p.id, "Atlas launch is in February");
  await db.update(factsTable).set({ createdBy: "ollie", createdAt: new Date(Date.now() - 30 * DAY), lastConfirmedAt: new Date(Date.now() - 30 * DAY) }).where(eq(factsTable.id, feb.id));
  return { p, s, feb };
}

type Contradicted = { ref: string; text: string; saidBy: { name: string } | null; saidAt: string | null; stronger: string; weighing: string; why: string };
type Item = { key: string; id: number; kind: string; text: string; saidBy: { name: string } | null; saidAt: string | null; contradicts?: Contradicted[] };

/* ---------- Contradictions ---------- */

describe("contradiction check", () => {
  it("criterion 1: a Gmail message saying March, against an approved fact saying February, appears under Conflicts with both sides", async () => {
    const { p, s, feb } = await atlas();
    const sent = new Date(Date.now() - DAY);
    const card = await marchEmail(sent);
    judged.length = 0;
    verdicts = disagreesWith("February");

    expect(await checkNewCards(new Date())).toEqual({ checked: 1, contradictions: 1 });
    expect(judged[0].card.text).toBe("Atlas launch is in March");
    expect(judged[0].items.map((i) => i.ref)).toEqual([`fact:${feb.id}`]);
    // Checked once only.
    expect(await checkNewCards(new Date())).toEqual({ checked: 0, contradictions: 0 });

    const inbox = (await api("suggestions?tab=conflicts")).body as { items: Item[]; counts: { conflicts: number; outOfDate: number } };
    expect(inbox.counts).toMatchObject({ conflicts: 1, outOfDate: 1 });
    const item = inbox.items.find((i) => i.kind === "contradiction")!;
    expect(item.text).toContain("March");
    expect(item.saidBy).toMatchObject({ name: "Sam Lee" });
    expect(new Date(item.saidAt!).toISOString()).toBe(sent.toISOString());
    expect(item.contradicts).toHaveLength(1);
    const old = item.contradicts![0];
    expect(old).toMatchObject({ ref: `fact:${feb.id}`, text: "Atlas launch is in February", stronger: "new" });
    expect(old.saidBy).not.toBeNull();
    expect(old.saidAt).not.toBeNull();
    expect(old.weighing).toMatch(/^New one looks stronger: Sam Lee decides on Atlas launch, and it is (four weeks|one month) newer\.$/);

    // The card cannot be approved round the side while the contradiction is open.
    const blocked = await api(`suggestions/${card.id}/approve`, { method: "POST" });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toContain("disagrees with something already approved");
    expect(s.id).toBeGreaterThan(0);
    expect(p.id).toBeGreaterThan(0);
  });

  it("criterion 3: the contradicted fact shows May be out of date on its page, in Needs a check, and to Claude, until Ollie decides", async () => {
    const { p, feb } = await atlas();
    await marchEmail(new Date(Date.now() - DAY));
    verdicts = disagreesWith("February");
    await checkNewCards(new Date());

    const page = (await api(`projects/${p.slug}`)).body as { facts: { id: number; outOfDate: boolean }[] };
    expect(page.facts.find((f) => f.id === feb.id)).toMatchObject({ outOfDate: true });

    const stale = (await api("suggestions?tab=stale")).body as { items: Item[] };
    expect(stale.items).toEqual([expect.objectContaining({ kind: "out_of_date", text: "Atlas launch is in February" })]);

    const c = await mcp((await connect()).access_token);
    const ctx = await call(c, "get_context", { name: "Atlas launch" });
    await c.close();
    expect(ctx.json.facts).toEqual([expect.objectContaining({ text: "Atlas launch is in February", needs_check: true })]);
  });

  it("criterion 2: New one is right replaces the fact and keeps the old one in history", async () => {
    const { p, feb } = await atlas();
    const card = await marchEmail(new Date(Date.now() - DAY));
    verdicts = disagreesWith("February");
    await checkNewCards(new Date());
    const [review] = await db.select().from(factReviewsTable).where(eq(factReviewsTable.kind, "contradiction"));

    const r = await api(`fact-reviews/${review.id}/resolve`, { body: { action: "new_right" } });
    expect(r.status).toBe(200);

    const page = (await api(`projects/${p.slug}`)).body as { facts: { id: number; text: string; outOfDate: boolean; needsCheck: boolean; history: { id: number; text: string }[] }[] };
    expect(page.facts).toHaveLength(1);
    expect(page.facts[0]).toMatchObject({ text: "Atlas launch is in March", outOfDate: false, needsCheck: false });
    expect(page.facts[0].history).toEqual([expect.objectContaining({ id: feb.id, text: "Atlas launch is in February" })]);
    expect((await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, card.id)))[0].status).toBe("approved");

    const after = (await api("suggestions?tab=conflicts")).body as { items: Item[]; counts: { conflicts: number; outOfDate: number } };
    expect(after.counts).toMatchObject({ conflicts: 0, outOfDate: 0 });
  });

  it("Old one stands rejects the card and confirms the fact; Both are true keeps both", async () => {
    const { p, feb } = await atlas();
    const card = await marchEmail(new Date(Date.now() - DAY));
    verdicts = disagreesWith("February");
    await checkNewCards(new Date());
    const [review] = await db.select().from(factReviewsTable).where(eq(factReviewsTable.kind, "contradiction"));
    expect((await api(`fact-reviews/${review.id}/resolve`, { body: { action: "old_stands" } })).status).toBe(200);
    expect((await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, card.id)))[0].status).toBe("rejected");
    const [kept] = await db.select().from(factsTable).where(eq(factsTable.id, feb.id));
    expect(kept).toMatchObject({ supersededBy: null, needsCheck: false });
    expect(kept.lastConfirmedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // A second card, settled as both true.
    const [second] = await db
      .insert(suggestionsTable)
      .values({ kind: "fact", entityType: "project", entityId: p.id, payload: { text: "Atlas launch has a soft start in February" }, normalisedText: "atlas soft start", proposedBy: "Claude" })
      .returning();
    await checkNewCards(new Date());
    const [r2] = await db.select().from(factReviewsTable).where(eq(factReviewsTable.suggestionId, second.id));
    expect((await api(`fact-reviews/${r2.id}/resolve`, { body: { action: "both_true" } })).status).toBe(200);
    const facts = (await api(`projects/${p.slug}`)).body.facts as { text: string }[];
    expect(facts.map((f) => f.text).sort()).toEqual(["Atlas launch has a soft start in February", "Atlas launch is in February"]);
  });

  it("the one-off redo withdraws open contradictions, lifts their out-of-date mark and checks the cards again", async () => {
    const { feb } = await atlas();
    const card = await marchEmail(new Date(Date.now() - DAY));
    verdicts = disagreesWith("February");
    await checkNewCards(new Date());
    expect((await db.select().from(factsTable).where(eq(factsTable.id, feb.id)))[0].needsCheck).toBe(true);

    expect(await recheckContradictions()).toBe(true);
    expect(await db.select().from(factReviewsTable)).toHaveLength(0);
    expect((await db.select().from(factsTable).where(eq(factsTable.id, feb.id)))[0].needsCheck).toBe(false);
    expect((await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, card.id)))[0].checkedAt).toBeNull();
    // Runs once only.
    expect(await recheckContradictions()).toBe(false);

    verdicts = () => [];
    expect(await checkNewCards(new Date())).toEqual({ checked: 1, contradictions: 0 });
  });

  it("a decision replaced by New one is right stays as history and AI no longer sees it", async () => {
    const p = await project("Atlas launch");
    const d = await decision(p.id, "Launch in February");
    await db
      .insert(suggestionsTable)
      .values({ kind: "decision", entityType: "project", entityId: p.id, payload: { text: "Launch in March", decided_at: "2026-11-10", project_id: p.id }, normalisedText: "launch in march", proposedBy: "Claude" });
    verdicts = disagreesWith("February");
    await checkNewCards(new Date());
    const [review] = await db.select().from(factReviewsTable);
    expect((await api(`decisions/${d.id}`)).body).toMatchObject({ outOfDate: true, replaced: false });

    expect((await api(`fact-reviews/${review.id}/resolve`, { body: { action: "new_right" } })).status).toBe(200);
    expect((await api(`decisions/${d.id}`)).body).toMatchObject({ outOfDate: false, replaced: true });
    const c = await mcp((await connect()).access_token);
    const ctx = await call(c, "get_context", { name: "Atlas launch" });
    await c.close();
    const texts = (ctx.json.decisions as { text: string }[]).map((x) => x.text);
    expect(texts).toContain("Launch in March");
    expect(texts).not.toContain("Launch in February");
  });

  it("never sends a card about something hidden, or hidden items, to the model", async () => {
    const secret = await project("Secret deal", { confidential: true });
    const open = await project("Open work");
    await fact("project", open.id, "Open work ends in February");
    await db.insert(suggestionsTable).values({ kind: "fact", entityType: "project", entityId: secret.id, payload: { text: "Secret deal closes in March" }, normalisedText: "secret march", proposedBy: "Claude" });
    await db.insert(suggestionsTable).values({ kind: "fact", entityType: "project", entityId: open.id, payload: { text: "Open work ends in March" }, normalisedText: "open march", proposedBy: "Claude" });
    judged.length = 0;
    verdicts = () => [];
    expect(await checkNewCards(new Date())).toEqual({ checked: 1, contradictions: 0 });
    expect(judged).toHaveLength(1);
    expect(judged[0].card.text).toBe("Open work ends in March");
    expect(JSON.stringify(judged)).not.toContain("Secret deal");
  });
});

/* ---------- Context packs ---------- */

describe("context packs", () => {
  it("criterion 4: a project's pack includes its facts, decisions and rules, and leaves out a confidential decision", async () => {
    const p = await project("Atlas launch", { summary: "A new product launch for Atlas." });
    await samDecidesOn(p.id);
    await fact("project", p.id, "Atlas launch is in February");
    await decision(p.id, "Use the blue logo");
    await decision(p.id, "Pay the agency £40k", true);
    const [scoped] = await db.insert(rulesTable).values({ title: "Launch copy", appliesWhen: "writing launch copy", rule: "Keep it under 50 words", createdBy: "ollie" }).returning();
    await db.insert(linksTable).values({ fromType: "rule", fromId: scoped.id, toType: "project", toId: p.id, createdBy: "ollie" });
    await db.insert(rulesTable).values({ title: "British English", appliesWhen: "writing anything", rule: "Use British spelling", createdBy: "ollie" });
    const [pb] = await db
      .insert(playbooksTable)
      .values({ title: "Launch checklist", whenToUse: "A launch is two weeks away", steps: [{ id: "a", text: "Brief the agency", personId: null, afterDays: null }] })
      .returning();
    await db.insert(linksTable).values({ fromType: "playbook", fromId: pb.id, toType: "project", toId: p.id, createdBy: "ollie" });

    const r = await api(`context-packs/project/${p.id}`);
    expect(r.status).toBe(200);
    const pack = r.body as { fileName: string; content: string; included: number; leftOut: number };
    expect(pack.fileName).toMatch(/^atlas-launch-context-\d{4}-\d{2}-\d{2}\.md$/);
    expect(pack.content).toContain("# Atlas launch: context for Claude");
    expect(pack.content).toContain("A copy of what OllieOS knew on");
    expect(pack.content).toContain("A new product launch for Atlas.");
    expect(pack.content).toContain("Sam Lee");
    expect(pack.content).toContain("Atlas launch is in February");
    expect(pack.content).toContain("Use the blue logo");
    expect(pack.content).toContain("Keep it under 50 words");
    expect(pack.content).toContain("Use British spelling");
    expect(pack.content).toContain("Launch checklist");
    expect(pack.content).toContain("Brief the agency");
    expect(pack.content).not.toContain("agency £40k");
    expect(pack.leftOut).toBe(1);
  });

  it("refuses a pack for a project hidden from AI", async () => {
    const p = await project("Secret deal", { confidential: true });
    const r = await api(`context-packs/project/${p.id}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("hidden from AI");
  });
});

/* ---------- Weekly round-up ---------- */

describe("weekly round-up", () => {
  it("criterion 5: the round-up lists the week's approvals and the conflict, and its Gmail draft leaves out a confidential item", async () => {
    const { p } = await atlas();
    await marchEmail(new Date(Date.now() - DAY));
    verdicts = disagreesWith("February");
    await checkNewCards(new Date());
    const [review] = await db.select().from(factReviewsTable).where(eq(factReviewsTable.kind, "contradiction"));
    await api(`fact-reviews/${review.id}/resolve`, { body: { action: "new_right" } });

    const secret = await project("Secret deal", { confidential: true });
    const [conf] = await db
      .insert(suggestionsTable)
      .values({ kind: "fact", entityType: "project", entityId: secret.id, payload: { text: "Secret deal is worth £2m" }, normalisedText: "secret worth", proposedBy: "Claude" })
      .returning();
    const [open] = await db
      .insert(suggestionsTable)
      .values({ kind: "fact", entityType: "project", entityId: p.id, payload: { text: "Atlas launch venue is London" }, normalisedText: "venue london", proposedBy: "Claude" })
      .returning();
    expect((await api(`suggestions/${conf.id}/approve`, { method: "POST" })).status).toBe(200);
    expect((await api(`suggestions/${open.id}/approve`, { method: "POST" })).status).toBe(200);

    const made = await api("roundups", { method: "POST" });
    expect(made.status).toBe(200);
    const r = made.body as { id: number; content: Record<string, { text: string; detail: string | null; private: boolean }[]> };
    const approved = r.content.approved.map((l) => l.text);
    expect(approved).toEqual(expect.arrayContaining(["Atlas launch is in March", "Secret deal is worth £2m", "Atlas launch venue is London"]));
    expect(r.content.approved.find((l) => l.text === "Secret deal is worth £2m")!.private).toBe(true);
    expect(r.content.contradictions).toHaveLength(1);
    expect(r.content.contradictions[0].text).toContain("February");
    expect(r.content.contradictions[0].detail).toContain("the new one was right");

    const page = (await api("roundups")).body as { roundup: { id: number }; weeks: { id: number }[] };
    expect(page.roundup.id).toBe(r.id);

    drafts.length = 0;
    expect((await api(`roundups/${r.id}/draft`, { method: "POST" })).body).toEqual({ saved: true });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].threadId).toBeNull();
    expect(drafts[0].draft.to).toBe("");
    expect(drafts[0].draft.body).toContain("Atlas launch venue is London");
    expect(drafts[0].draft.body).toContain("the new one was right");
    expect(drafts[0].draft.body).not.toContain("Secret deal");
  });

  it("is made once after the chosen day and time, which Settings can change", async () => {
    expect((await api("settings/roundup")).body).toEqual({ day: 5, hour: 16 });
    // Friday 13th November 2026, 16:30 London (GMT).
    const fri = new Date("2026-11-13T16:30:00Z");
    expect(lastRoundupTime(fri, { day: 5, hour: 16 }).toISOString()).toBe("2026-11-13T16:00:00.000Z");
    expect(lastRoundupTime(new Date("2026-11-13T15:30:00Z"), { day: 5, hour: 16 }).toISOString()).toBe("2026-11-06T16:00:00.000Z");
    expect(await buildRoundupIfDue(fri)).not.toBeNull();
    expect(await buildRoundupIfDue(fri)).toBeNull();
    expect(await db.select().from(weeklyRoundupsTable)).toHaveLength(1);

    expect((await api("settings/roundup", { method: "PUT", body: { day: 1, hour: 9 } })).body).toEqual({ day: 1, hour: 9 });
    expect((await api("settings/roundup", { method: "PUT", body: { day: 7, hour: 9 } })).status).toBe(400);
    expect(lastRoundupTime(fri, { day: 1, hour: 9 }).toISOString()).toBe("2026-11-09T09:00:00.000Z");
  });
});
