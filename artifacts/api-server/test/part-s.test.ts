/**
 * Part S (build plan section 19): client pulse, relationships from people seen together, "works at"
 * from email domains, and details from email signatures.
 */
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { appSettingsTable, db, meetingTonesTable, organisationsTable, peopleTable, suggestionsTable, tasksTable } from "@workspace/db";
import { todayLondon } from "@workspace/shared";
import type { GmailRead } from "../src/services/connectors/gmail";
import type { WorkUnit } from "../src/services/connectors/messages";
import type { SortedUnit } from "../src/services/connectors/sorter";
import { buildDigest } from "../src/services/digest";
import { proposeSignature, proposeWorksAt, recordTogether, relationshipLookBackIdle } from "../src/services/peopleSignals";
import { api, useServer } from "./harness";
import { organisation, person } from "./helpers";

let nextGmail: GmailRead = { account: "ollie@example.com", units: [], found: 0, leftOut: 0, newest: null, more: false };
let nextSorted: Partial<SortedUnit>[] = [];
let threads: Record<string, { from: string; to: string[]; subject: string }> = {};

vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  readGmail: async () => nextGmail,
}));
vi.mock("../src/services/connectors/noReply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/noReply")>()),
  refreshNoReply: async () => null,
  threadMeta: async (id: string) => {
    const t = threads[id];
    if (!t) return null;
    const addr = (e: string) => ({ name: null, email: e });
    return [{ id: id + "m", at: new Date(), labels: new Set(["INBOX"]), from: addr(t.from), to: t.to.map(addr), cc: [], subject: t.subject, snippet: "", bulk: false, auto: false }];
  },
}));
vi.mock("../src/services/connectors/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/http")>()),
  proxyJson: async (_c: string, _n: string, path: string) => (path.startsWith("/gmail/v1/users/me/threads?") ? { threads: Object.keys(threads).map((id) => ({ id })) } : {}),
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[]) => units.map((_, i) => ({ summary: "", project: "", items: [], ...nextSorted[i] })),
}));
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

const DAY = 86_400_000;

async function at(org: { id: number }, name: string, email: string, o: Partial<typeof peopleTable.$inferInsert> = {}) {
  const p = await person(name, { organisationId: org.id });
  await db.update(peopleTable).set({ email, ...o }).where(eq(peopleTable.id, p.id));
  return p;
}

describe("client pulse", () => {
  it("says when a client needs attention, and why", async () => {
    const acme = await organisation("Acme");
    await db.update(organisationsTable).set({ type: "client" }).where(eq(organisationsTable.id, acme.id));
    const sam = await at(acme, "Sam Lee", "sam@acme.com", { lastContactAt: new Date(Date.now() - 40 * DAY) });
    await db.insert(tasksTable).values([
      { title: "Send Acme the proposal", status: "now", personId: sam.id, dueDate: "2026-01-02", createdBy: "ollie" },
      { title: "Acme to send the PO", status: "waiting", waitingOnPersonId: sam.id, createdBy: "ollie" },
    ]);
    await db.insert(meetingTonesTable).values({ granolaRef: "n1", title: "Quarterly review", at: new Date(Date.now() - 40 * DAY), tone: "concerned", reason: "Worried about delays", personIds: [sam.id] });
    await db.insert(appSettingsTable).values({ key: "email_inbox_snapshot", value: { candidates: [{ threadId: "t1", messageId: "m1", fromEmail: "sam@acme.com", at: new Date(Date.now() - 10 * DAY).toISOString() }] } });

    const p = (await api(`organisations/${acme.slug}/pulse`)).body;
    expect(p).toMatchObject({ name: "Acme", quietDays: 30, emailsWaiting: 1, owedToThem: 1, overdueToThem: 1, theyOwe: 1, needsAttention: true });
    expect(p.tone).toMatchObject({ tone: "concerned", reason: "Worried about delays" });
    expect(p.reasons).toEqual([
      "No contact for 40 days",
      "1 overdue for them",
      "An email from them has waited over 3 working days",
      "Last meeting sounded concerned: Worried about delays",
    ]);
    expect(p.line).toContain("1 email waiting on you");

    const list = (await api("organisations-pulse")).body;
    expect(list.map((x: { name: string }) => x.name)).toEqual(["Acme"]);
    const digest = await buildDigest(todayLondon());
    expect(digest.sections.quiet!.items[0]).toMatchObject({ text: "Acme: no contact for 40 days", href: "/knowledge/organisations/acme" });

    // A longer quiet period for this client: no longer quiet.
    const after = (await api(`organisations/${acme.slug}/pulse`, { method: "PATCH", body: { quietDays: 60 } })).body;
    expect(after.quietDays).toBe(60);
    expect(after.reasons.some((r: string) => r.startsWith("No contact"))).toBe(false);
  });

  it("only covers client organisations", async () => {
    const supplier = await organisation("Paper Co");
    await db.update(organisationsTable).set({ type: "supplier" }).where(eq(organisationsTable.id, supplier.id));
    expect((await api("organisations-pulse")).body).toEqual([]);
  });
});

describe("people signals", () => {
  it("proposes works with once for people on 5 threads together, and never counts someone hidden", async () => {
    const acme = await organisation("Acme");
    const a = await at(acme, "Sam Lee", "sam@acme.com");
    const b = await at(acme, "Amy Park", "amy@acme.com");
    const hidden = await at(acme, "Pat Doe", "pat@acme.com", { aiAccess: false });
    for (let i = 0; i < 4; i++) await recordTogether("email", "t" + i, "Pilot plan", new Date(), [a.id, b.id, hidden.id]);
    expect(await db.select().from(suggestionsTable).where(eq(suggestionsTable.kind, "relationship"))).toHaveLength(0);
    expect(await recordTogether("email", "t4", "Pilot plan", new Date(), [a.id, b.id, hidden.id])).toBe(1);
    const cards = await db.select().from(suggestionsTable).where(eq(suggestionsTable.kind, "relationship"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ entityType: "person", entityId: a.id });
    expect(cards[0].payload).toMatchObject({ relationship: "works_with", to_type: "person", to_id: b.id });
    expect((cards[0].payload as { note: string }).note).toBe('On 5 email threads together in the last 90 days, for example "Pilot plan".');
    // More threads: no second card, even after it is rejected.
    await db.update(suggestionsTable).set({ status: "rejected" }).where(eq(suggestionsTable.id, cards[0].id));
    await recordTogether("email", "t5", "Pilot plan", new Date(), [a.id, b.id]);
    expect(await db.select().from(suggestionsTable).where(eq(suggestionsTable.kind, "relationship"))).toHaveLength(1);
  });

  it("proposes works at from the email domain others at an organisation use", async () => {
    const acme = await organisation("Acme");
    await at(acme, "Sam Lee", "sam@acme.com");
    await at(acme, "Amy Park", "amy@acme.com");
    const jo = await person("Jo Bloggs");
    await db.update(peopleTable).set({ email: "jo@acme.com" }).where(eq(peopleTable.id, jo.id));
    expect(await proposeWorksAt([jo.id])).toBe(1);
    const [card] = await db.select().from(suggestionsTable).where(eq(suggestionsTable.kind, "summary_change"));
    expect(card).toMatchObject({ entityType: "person", entityId: jo.id });
    expect(card.payload).toMatchObject({ fields: { organisation: "Acme" }, organisation_id: acme.id });
  });

  it("proposes signature details OllieOS does not hold, from the Gmail check", async () => {
    const acme = await organisation("Acme");
    const sam = await at(acme, "Sam Lee", "sam@acme.com", { role: "Head of Partnerships" });
    // Same title as on file: nothing. A phone number: a change card that fills the Phone field.
    expect(await proposeSignature({ id: sam.id, name: "Sam Lee" }, { title: "Head of Partnerships", company: "Acme", phone: "" }, { ref: "gmail:x", url: null, label: "Email", at: new Date() })).toBe(0);

    const msg = { ref: "gmail:m1", at: new Date(), fromMe: false, fromName: "Sam Lee", fromAddress: "sam@acme.com", text: "Thanks, Sam", url: "https://mail.google.com/mail/#all/t1" };
    nextGmail = { account: "ollie@example.com", units: [{ source: "email", key: "gmail:m1", subject: "Pilot", channel: null, people: [{ name: "Sam Lee", email: "sam@acme.com" }], messages: [msg], conversation: { id: "t1", kind: "thread" } }], found: 1, leftOut: 0, newest: new Date(), more: false };
    nextSorted = [{ signature: { title: "Chief Partnerships Officer", company: "Acme", phone: "+44 20 7946 0000" } }];
    const r = await api("connectors/gmail/check", { method: "POST" });
    expect(r.body).toMatchObject({ ok: true });
    expect(r.body.counts.details).toBe(2);
    const facts = await db.select().from(suggestionsTable).where(eq(suggestionsTable.kind, "fact"));
    expect(facts.map((f) => (f.payload as { text: string; attribute: string | null }))).toEqual([expect.objectContaining({ text: "Sam Lee is Chief Partnerships Officer", attribute: "job_title" })]);
    const [phone] = await db.select().from(suggestionsTable).where(and(eq(suggestionsTable.kind, "summary_change"), eq(suggestionsTable.entityId, sam.id)));
    expect((phone.payload as { fields: Record<string, string> }).fields).toEqual({ phone: "+44 20 7946 0000" });
  });

  it("looks back over email headers for people on threads together", async () => {
    const acme = await organisation("Acme");
    await at(acme, "Sam Lee", "sam@acme.com");
    await at(acme, "Amy Park", "amy@acme.com");
    threads = Object.fromEntries([0, 1, 2, 3, 4].map((i) => ["th" + i, { from: "sam@acme.com", to: ["amy@acme.com", "ollie@example.com"], subject: "Renewal " + i }]));
    expect((await api("relationships/look-back", { method: "POST" })).status).toBe(202);
    await relationshipLookBackIdle();
    const s = (await api("relationships/look-back")).body;
    expect(s).toMatchObject({ status: "done", total: 5, done: 5, proposed: 1 });
  });
});
