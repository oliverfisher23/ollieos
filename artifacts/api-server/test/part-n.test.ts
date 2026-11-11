import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, db, factReviewsTable, factsTable, peopleTable, suggestionsTable, tasksTable } from "@workspace/db";
import type { GmailRead } from "../src/services/connectors/gmail";
import type { SlackRead } from "../src/services/connectors/slack";
import type { SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { fact, person, project } from "./helpers";
import { api, call, connect, ingest, mcp, useServer } from "./harness";

let nextGmail: GmailRead = { account: "ollie@example.com", units: [], found: 0, leftOut: 0, newest: null, more: false };
let nextSlack: SlackRead = { account: "ollie at Example", units: [], found: 0, leftOut: 0, checked: 0, state: { since: new Date().toISOString(), convs: {} } };
let nextSorted: SortedUnit[] = [];
let knowledgeAllowed: boolean[] = [];

vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  readGmail: async () => nextGmail,
}));
vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => nextSlack,
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[], ctx: { readKnowledge?: (i: number) => boolean }) => {
    knowledgeAllowed = units.map((_, i) => ctx.readKnowledge?.(i) ?? false);
    return units.map((_, i) => nextSorted[i] ?? { summary: "", project: "", items: [], knowledge: [] });
  },
}));
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
}));
vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  draftCheckInFromDocs: async () => ({ text: "Hi", refs: [] }),
  writeBriefFromDocs: async () => ({ why: [], questions: [], questionsNote: "" }),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

const at = new Date("2026-11-10T09:00:00Z");

const task = (ref: string, title: string): SortedUnit["items"][0] => ({
  ref,
  type: "task",
  title,
  action: "",
  priority: "medium",
  due: "",
  project: "",
  person: "",
  quote: "",
  confidential: false,
});

function emailUnit(id: string, from: string, text = "Could you send the numbers?"): WorkUnit {
  return {
    source: "email",
    key: `gmail:${id}`,
    subject: "Numbers",
    channel: null,
    people: [{ name: "Sam Lee", email: from }],
    messages: [{ ref: `gmail:${id}`, at, fromMe: false, fromName: "Sam Lee", fromAddress: from, text, url: `https://mail.google.com/mail/#all/${id}` }],
  };
}

function slackUnit(ts: string, text: string, slackId = "U0SAM"): WorkUnit {
  const ref = `slack:D1:${ts}`;
  return {
    source: "slack",
    key: ref,
    subject: null,
    channel: "Sam",
    people: [{ name: "Sam", email: null, slackId }],
    messages: [{ ref, at, fromMe: false, fromName: "Sam", fromAddress: null, fromSlackId: slackId, text, url: `https://x.slack.com/archives/D1/p${ts.replace(".", "")}` }],
  };
}

const slackRead = (units: WorkUnit[]): SlackRead => ({ account: "ollie at Example", units, found: units.length, leftOut: 0, checked: 1, state: { since: at.toISOString(), convs: {} } });

/** Sam Lee with a work address, a personal address and a Slack account. */
async function sam() {
  const [row] = await db
    .insert(peopleTable)
    .values({ name: "Sam Lee", slug: "sam-lee", email: "sam@client.com", otherEmails: ["sam.lee@home.example"], slackUserId: "U0SAM" })
    .returning();
  return row;
}

/* ---------- 1. One person across every tool ---------- */

describe("one person across every tool", () => {
  it("criterion 1: a person with two addresses is matched from an email to either address, and from Slack", async () => {
    const s = await sam();
    nextGmail = { account: "ollie@example.com", units: [emailUnit("m1", "sam@client.com"), emailUnit("m2", "Sam.Lee@home.example")], found: 2, leftOut: 0, newest: at, more: false };
    nextSorted = [
      { summary: "", project: "", items: [task("gmail:m1", "Send Sam the numbers")], knowledge: [] },
      { summary: "", project: "", items: [task("gmail:m2", "Book lunch with Sam")], knowledge: [] },
    ];
    expect((await api("connectors/gmail/check", { method: "POST" })).body).toMatchObject({ ok: true });

    nextSlack = slackRead([slackUnit("1731229200.000100", "Can you review the plan?")]);
    nextSorted = [{ summary: "", project: "", items: [task("slack:D1:1731229200.000100", "Review Sam's plan")], knowledge: [] }];
    expect((await api("connectors/slack/check", { method: "POST" })).body).toMatchObject({ ok: true });

    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks.map((t) => [t.title, t.personId])).toEqual([
      ["Send Sam the numbers", s.id],
      ["Book lunch with Sam", s.id],
      ["Review Sam's plan", s.id],
    ]);
  });

  it("other emails and the Slack account are saved from the person page, and an address is matched once", async () => {
    const p = await person("Jo Bloggs");
    const r = await api(`people/${p.slug}`, { method: "PATCH", body: { otherEmails: ["Jo@Home.example", "jo@home.example"], slackUserId: "U0JO" } });
    expect(r.status).toBe(200);
    const [row] = await db.select().from(peopleTable).where(eq(peopleTable.id, p.id));
    expect(row.otherEmails).toEqual(["jo@home.example"]);
    expect(row.slackUserId).toBe("U0JO");
    expect((await api(`people/${p.slug}`)).body.person).toMatchObject({ otherEmails: ["jo@home.example"], slackUserId: "U0JO" });
  });

  it("criterion 2: merging two people moves a fact, a task and a meeting onto the one kept", async () => {
    const keep = await sam();
    const gone = await person("Samuel Lee");
    await db.update(peopleTable).set({ email: "samuel@other.example" }).where(eq(peopleTable.id, gone.id));
    const f = await fact("person", gone.id, "Samuel prefers calls to email");
    const [t] = await db.insert(tasksTable).values({ title: "Call Samuel", personId: gone.id, createdBy: "ollie" }).returning();
    const soon = new Date(Date.now() + 2 * 3_600_000);
    const ev = await ingest("calendar", {
      body: { events: [{ source_ref: "ev1", title: "Catch-up", starts_at: soon.toISOString(), ends_at: new Date(soon.getTime() + 1_800_000).toISOString(), attendees: [{ name: "Samuel Lee", email: "samuel@other.example" }], personal: false }] },
    });
    expect(ev.status).toBe(200);
    const [evRow] = await db.update(calendarEventsTable).set({ personIds: [gone.id] }).where(eq(calendarEventsTable.sourceRef, "ev1")).returning();

    const r = await api(`people/${keep.slug}/merge`, { body: { otherId: gone.id } });
    expect(r.status).toBe(200);
    expect(r.body.moved).toMatchObject({ facts: 1, tasks: 1, meetings: 1 });

    expect((await db.select().from(factsTable).where(eq(factsTable.id, f.id)))[0].entityId).toBe(keep.id);
    expect((await db.select().from(tasksTable).where(eq(tasksTable.id, t.id)))[0].personId).toBe(keep.id);
    expect((await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, evRow.id)))[0].personIds).toEqual([keep.id]);
    expect(await db.select().from(peopleTable).where(eq(peopleTable.id, gone.id))).toEqual([]);
    const [kept] = await db.select().from(peopleTable).where(eq(peopleTable.id, keep.id));
    expect(kept.email).toBe("sam@client.com");
    expect([...kept.otherEmails].sort()).toEqual(["sam.lee@home.example", "samuel@other.example"]);
  });

  it("lists possible duplicates, and forgets a pair marked as different people", async () => {
    const a = await person("Alex Kim");
    const [b] = await db.insert(peopleTable).values({ name: "alex  kim", slug: "alex-kim-2" }).returning();
    const list = (await api("people/duplicates")).body as unknown as { a: { id: number }; b: { id: number } }[];
    expect(list.map((d) => [d.a.id, d.b.id])).toEqual([[a.id, b.id]]);
    expect((await api("people/duplicates/not-same", { body: { aId: b.id, bId: a.id } })).status).toBe(200);
    expect((await api("people/duplicates")).body).toEqual([]);
  });

  it("never merges Ollie's own profile away", async () => {
    await api("goals");
    const other = await person("Somebody");
    const [self] = await db.select().from(peopleTable).where(eq(peopleTable.isSelf, true));
    if (!self) return;
    const r = await api(`people/${other.slug}/merge`, { body: { otherId: self.id } });
    expect(r.status).toBe(400);
  });
});

/* ---------- 2. Who decides ---------- */

describe("who decides", () => {
  it("criterion 3: 'Sam Lee decides on Atlas launch' shows on the project page and in a brief with Sam in the room", async () => {
    const s = await sam();
    const p = await project("Atlas launch");
    const set = await api("relationships", { method: "PUT", body: { fromType: "person", fromId: s.id, toType: "project", toId: p.id, relationship: "decides_on" } });
    expect(set.status).toBe(200);

    // The project page reads its relationships.
    const rels = (await api(`relationships?type=project&id=${p.id}`)).body as unknown as { relationship: string; direction: string; other: { id: number } }[];
    expect(rels).toEqual([expect.objectContaining({ relationship: "decides_on", direction: "in", other: expect.objectContaining({ id: s.id }) })]);

    // Claude reads it.
    const c = await mcp((await connect()).access_token);
    const ctx = await call(c, "get_context", { name: "Atlas launch" });
    expect(JSON.stringify(ctx.json.who_decides)).toContain("Sam Lee");

    // The brief shows it beside Sam.
    await fact("person", s.id, "Sam is hiring two graduates in January");
    const starts = new Date(Date.now() + 30 * 60_000);
    await ingest("calendar", {
      body: { events: [{ source_ref: "b1", title: "Catch-up", starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + 1_800_000).toISOString(), attendees: [{ name: "Sam Lee", email: "sam@client.com" }], personal: false }] },
    });
    const [ev] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, "b1"));
    const view = (await api(`briefs/${ev.id}`)).body;
    expect(view.attendees[0].person.decidesOn).toEqual([expect.objectContaining({ type: "project", id: p.id, name: "Atlas launch" })]);
  });

  it("only a person can decide, and only on a project, product or organisation", async () => {
    const s = await sam();
    const other = await person("Jo Bloggs");
    const p = await project("Atlas launch");
    expect((await api("relationships", { method: "PUT", body: { fromType: "project", fromId: p.id, toType: "person", toId: s.id, relationship: "decides_on" } })).status).toBe(400);
    expect((await api("relationships", { method: "PUT", body: { fromType: "person", fromId: other.id, toType: "person", toId: s.id, relationship: "decides_on" } })).status).toBe(400);
  });
});

/* ---------- 3. Knowledge from Slack and Gmail, with who said it ---------- */

describe("knowledge from Slack and Gmail", () => {
  it("criterion 4: a Slack message stating a decision about a known project makes a Decision card saying who said it, citing the message", async () => {
    const s = await sam();
    const p = await project("Atlas launch");
    const ref = "slack:D1:1731229200.000200";
    nextSlack = slackRead([slackUnit("1731229200.000200", "We're going with March for the Atlas launch. Final.")]);
    nextSorted = [
      {
        summary: "",
        project: "",
        items: [],
        knowledge: [{ ref, kind: "decision", about_type: "project", about: "Atlas launch", text: "Atlas launch moves to March", said_by: "Sam", quote: "We're going with March", confidential: false }],
      },
    ];
    const check = await api("connectors/slack/check", { method: "POST" });
    expect(check.body).toMatchObject({ ok: true });
    expect(knowledgeAllowed).toEqual([true]);

    const [card] = await db.select().from(suggestionsTable);
    expect(card).toMatchObject({ kind: "decision", entityType: "project", entityId: p.id, sourceRef: ref, sourceUrl: "https://x.slack.com/archives/D1/p1731229200000200", saidById: s.id });

    const inbox = (await api("suggestions?tab=suggested")).body;
    const item = (inbox.items as { id: number; saidBy: unknown; saidAt: string; text: string; source: string }[]).find((i) => i.id === card.id)!;
    expect(item.saidBy).toEqual({ name: "Sam Lee", personId: s.id, slug: "sam-lee", isSelf: false });
    expect(new Date(item.saidAt).toISOString()).toBe(at.toISOString());
    expect(item.text).toContain("Atlas launch moves to March");
    expect(item.source).toContain("Slack message from Sam");
  });

  it("never reads for knowledge an exchange with someone hidden from AI", async () => {
    await db.insert(peopleTable).values({ name: "Sam Lee", slug: "sam-lee", slackUserId: "U0SAM", confidential: true });
    await project("Atlas launch");
    nextSlack = slackRead([slackUnit("1731229200.000300", "Atlas launch is March.")]);
    nextSorted = [
      {
        summary: "",
        project: "",
        items: [],
        knowledge: [{ ref: "slack:D1:1731229200.000300", kind: "decision", about_type: "project", about: "Atlas launch", text: "March", said_by: "Sam", quote: "", confidential: false }],
      },
    ];
    await api("connectors/slack/check", { method: "POST" });
    expect(knowledgeAllowed).toEqual([false]);
    expect(await db.select().from(suggestionsTable)).toEqual([]);
  });

  it("Claude can say who said a claim", async () => {
    const s = await sam();
    await project("Atlas launch");
    const c = await mcp((await connect()).access_token);
    const r = await call(c, "add_fact", { entity: { name: "Atlas launch" }, text: "Atlas launch has a budget of 40k", said_by: "sam@client.com", said_at: "2026-11-09" });
    expect(r.json).toBeTruthy();
    const [card] = await db.select().from(suggestionsTable);
    expect(card.saidById).toBe(s.id);
  });
});

/* ---------- 4. Same as existing ---------- */

describe("same as existing", () => {
  it("criterion 5: 'Same as existing' marks the approved fact as checked and adds no new fact", async () => {
    const p = await project("Garden shed");
    const old = new Date("2026-06-01T09:00:00Z");
    const [f] = await db.insert(factsTable).values({ entityType: "project", entityId: p.id, text: "The budget is £3k", createdBy: "ollie", lastConfirmedAt: old, needsCheck: true }).returning();
    await db.insert(factReviewsTable).values({ kind: "stale", factIds: [f.id], status: "pending" });

    const r = await ingest("suggestions", { body: { suggestions: [{ kind: "fact", entity: "Garden shed", text: "Budget for the shed is three thousand pounds", source_type: "email", source: "Email from Jo" }] } });
    expect(r.status).toBe(200);
    const [card] = await db.select().from(suggestionsTable);
    expect(card.status).toBe("pending");

    const options = (await api(`suggestions/${card.id}/merge-options`)).body as unknown as { itemType: string; id: number }[];
    expect(options.map((o) => [o.itemType, o.id])).toEqual([["fact", f.id]]);

    const merged = await api(`suggestions/${card.id}/merge`, { body: { itemType: "fact", itemId: f.id } });
    expect(merged.status).toBe(200);
    expect(merged.body).toMatchObject({ status: "merged", result: { type: "fact", id: f.id } });

    const facts = await db.select().from(factsTable);
    expect(facts).toHaveLength(1);
    expect(facts[0].needsCheck).toBe(false);
    expect(facts[0].lastConfirmedAt!.getTime()).toBeGreaterThan(old.getTime());
    const [review] = await db.select().from(factReviewsTable);
    expect(review.status).toBe("resolved");
    const [after] = await db.select().from(suggestionsTable);
    expect(after).toMatchObject({ status: "merged", resultType: "fact", resultId: f.id });

    // It cannot be dealt with twice, or merged into a different kind of thing.
    expect((await api(`suggestions/${card.id}/merge`, { body: { itemType: "fact", itemId: f.id } })).status).toBe(400);
  });

  it("refuses a fact about something else", async () => {
    const a = await project("Garden shed");
    const b = await project("Kitchen");
    const other = await fact("project", b.id, "Kitchen is blue");
    await ingest("suggestions", { body: { suggestions: [{ kind: "fact", entity: "Garden shed", text: "Budget is 3k", source_type: "email", source: "Email" }] } });
    const [card] = await db.select().from(suggestionsTable);
    expect(card.entityId).toBe(a.id);
    expect((await api(`suggestions/${card.id}/merge`, { body: { itemType: "fact", itemId: other.id } })).status).toBe(400);
    expect((await api(`suggestions/${card.id}/merge`, { body: { itemType: "decision", itemId: 1 } })).status).toBe(400);
  });
});
