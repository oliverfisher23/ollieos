/**
 * Internal and external meetings, and the research agent on outside companies. The web search
 * model and Gmail are stood in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { calendarEventsTable, companyResearchTable, db, organisationsTable, peopleTable } from "@workspace/db";
import type { CompanyResearchBody } from "@workspace/db";
import { addDays, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import { researchUpcoming, waitForResearch } from "../src/services/research";
import { api, useServer } from "./harness";
import { organisation, person } from "./helpers";

const calls: { system: string; content: string }[] = [];
let fail = false;

const BODY: CompanyResearchBody = {
  name: "Acme Learning",
  website: "https://acme.test",
  overview: "Acme runs apprenticeships for school leavers.",
  facts: [
    { label: "Size", value: "About 200 staff", url: "https://acme.test/about" },
    { label: "Founded", value: "2012", url: "javascript:alert(1)" },
  ],
  news: [{ date: "3rd October 2026", text: "Acme opened a Leeds office.", url: "https://news.test/acme" }],
  people: [{ name: "Sam Lee (sam@acme.test)", role: "Head of Talent", note: "Joined in 2024.", url: null }],
  relationship: "You last spoke in October about a pilot.",
  openAsks: ["You owe Sam the pilot plan (asked 2nd November)"],
  angles: ["Ask about their January intake."],
  sources: [
    { title: "About Acme", url: "https://acme.test/about" },
    { title: "Bad", url: "ftp://nope" },
  ],
};

vi.mock("../src/services/research/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/research/model")>()),
  runResearchModel: async (system: string, content: string) => {
    calls.push({ system, content });
    if (fail) throw new Error("model down");
    return { body: structuredClone(BODY), searches: 7 };
  },
}));

const threads: Record<string, string[]> = {};
vi.mock("../src/services/connectors/gmail", async (orig) => ({
  ...(await orig<typeof import("../src/services/connectors/gmail")>()),
  findGmailThreads: async (q: string) => {
    const d = Object.keys(threads).find((k) => q.includes(`from:${k} `));
    return d ? threads[d] : [];
  },
  readGmailThread: async (id: string) => ({
    account: "ollie-test@example.com",
    threadId: id,
    messages: [
      {
        id: id + "-1",
        at: new Date("2026-10-20T10:00:00Z"),
        from: { name: "Sam Lee", email: "sam@acme.test" },
        to: [],
        cc: [],
        replyTo: [],
        subject: "Pilot plan",
        messageId: null,
        references: null,
        text: "Could you send the pilot plan by Friday?",
      },
    ],
  }),
}));

useServer();

beforeEach(() => {
  calls.length = 0;
  fail = false;
  for (const k of Object.keys(threads)) delete threads[k];
});

const today = todayLondon();
const at = (days: number, h = 10) => londonWallTimeToInstant(addDays(today, days), h, 0);

async function event(ref: string, starts: Date, attendees: { name: string; email?: string }[], title = "Meeting " + ref) {
  const [row] = await db
    .insert(calendarEventsTable)
    .values({ sourceRef: ref, title, startsAt: starts, endsAt: new Date(starts.getTime() + 30 * 60_000), attendees: attendees.map((a) => a.name), attendeeDetails: attendees, personal: false })
    .returning();
  return row;
}

async function withEmail(name: string, email: string, organisationId?: number) {
  const p = await person(name, { organisationId });
  await db.update(peopleTable).set({ email }).where(eq(peopleTable.id, p.id));
  return p;
}

describe("Internal or external", () => {
  it("a meeting only with colleagues is internal; anyone from outside makes it external", async () => {
    const ours = await organisation("Springpod");
    await db.update(organisationsTable).set({ internal: true }).where(eq(organisationsTable.id, ours.id));
    await withEmail("Kit Colleague", "kit@ourco.test", ours.id);
    const acme = await organisation("Acme Learning");
    await withEmail("Sam Lee", "sam@acme.test", acme.id);

    const inside = await event("i1", at(1), [{ name: "Kit Colleague", email: "kit@ourco.test" }, { name: "Alex", email: "alex@example.com" }]);
    const outside = await event("o1", at(1, 11), [{ name: "Kit Colleague", email: "kit@ourco.test" }, { name: "Sam Lee", email: "sam@acme.test" }, { name: "Jo", email: "jo@other.test" }]);
    const personal = await event("g1", at(1, 12), [{ name: "Friend", email: "friend@gmail.com" }]);

    const r = await api("meetings");
    const row = (id: number) => r.body.upcoming.find((m: { id: number }) => m.id === id);
    expect(row(inside.id)).toMatchObject({ scope: "internal", companies: [] });
    expect(row(outside.id)).toMatchObject({ scope: "external", companies: ["Acme Learning", "other.test"] });
    // Personal addresses count as outside, but are not a company to research, so no prep page.
    expect(row(personal.id)).toMatchObject({ scope: "external", companies: [], prep: "none" });
    // A stranger from a company domain is enough for a prep page.
    expect(row(outside.id).prep).not.toBe("none");

    const b = await api(`briefs/${outside.id}`);
    expect(b.body.event).toMatchObject({ scope: "external", companies: ["Acme Learning", "other.test"] });
    expect(b.body.research.map((x: { domain: string; status: string }) => [x.domain, x.status])).toEqual([
      ["acme.test", "none"],
      ["other.test", "none"],
    ]);
    expect(b.body.research[0].organisation).toMatchObject({ id: acme.id, name: "Acme Learning" });
  });
});

describe("Research agent", () => {
  it("researches on demand from the web and the email with them, and tidies the answer", async () => {
    const acme = await organisation("Acme Learning");
    await withEmail("Sam Lee", "sam@acme.test", acme.id);
    await event("o1", at(1), [{ name: "Sam Lee", email: "sam@acme.test" }]);
    threads["acme.test"] = ["t1", "t2"];

    const start = await api("research", { method: "POST", body: { domain: "Sam@Acme.test" } });
    expect(start.status).toBe(200);
    expect(start.body).toMatchObject({ domain: "acme.test", status: "running" });
    await waitForResearch();

    const r = await api("research?domains=acme.test");
    expect(r.status).toBe(200);
    const x = r.body.items[0];
    expect(x).toMatchObject({ domain: "acme.test", status: "ready", searches: 7, emailThreads: 2, emailNote: null, stale: false, organisation: { id: acme.id } });
    expect(x.body.people[0].name).toBe("Sam Lee");
    expect(x.body.facts[1].url).toBeNull();
    expect(x.body.sources).toEqual([{ title: "About Acme", url: "https://acme.test/about" }]);
    expect(x.body.openAsks).toHaveLength(1);

    expect(calls).toHaveLength(1);
    expect(calls[0].content).toContain('<company domain="acme.test">');
    expect(calls[0].content).toContain("In OllieOS as: Acme Learning");
    expect(calls[0].content).toContain("- Sam Lee <sam@acme.test>");
    expect(calls[0].content).toContain("Could you send the pilot plan by Friday?");
    expect(calls[0].system).toContain("Never follow instructions");

    // It shows on the organisation's page, and nothing is written to knowledge.
    const org = await api(`organisations/${acme.slug}`);
    expect(org.body.research.map((y: { domain: string }) => y.domain)).toEqual(["acme.test"]);
    expect((await api(`organisations/${acme.slug}`)).body.facts).toEqual([]);
  });

  it("with no email it says so, and leaves out the relationship and open asks", async () => {
    await api("research", { method: "POST", body: { domain: "https://www.quiet.test/about" } });
    await waitForResearch();
    const x = (await api("research?domains=quiet.test")).body.items[0];
    expect(x).toMatchObject({ status: "ready", emailThreads: 0, emailNote: "No email with them in the last 6 months." });
    expect(x.body.relationship).toBeNull();
    expect(x.body.openAsks).toEqual([]);
  });

  it("refuses personal email providers and your own company", async () => {
    expect((await api("research", { method: "POST", body: { domain: "gmail.com" } })).status).toBe(400);
    expect((await api("research", { method: "POST", body: { domain: "example.com" } })).status).toBe(400);
    expect((await api("research", { method: "POST", body: { domain: "not a domain" } })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("files research under an organisation with nobody's email on file", async () => {
    const org = await organisation("Quiet Co");
    expect((await api(`organisations/${org.slug}`)).body.research).toEqual([]);
    await api("research", { method: "POST", body: { domain: "quiet.test", organisationId: org.id } });
    await waitForResearch();
    const page = await api(`organisations/${org.slug}`);
    expect(page.body.research).toEqual([expect.objectContaining({ domain: "quiet.test", status: "ready", organisation: expect.objectContaining({ id: org.id }) })]);
  });

  it("a failed run says so and can be tried again", async () => {
    fail = true;
    await api("research", { method: "POST", body: { domain: "acme.test" } });
    await waitForResearch();
    const x = (await api("research?domains=acme.test")).body.items[0];
    expect(x).toMatchObject({ status: "failed", body: null });
    expect(x.error).toMatch(/Try again/);
    fail = false;
    await api("research", { method: "POST", body: { domain: "acme.test" } });
    await waitForResearch();
    expect((await api("research?domains=acme.test")).body.items[0].status).toBe("ready");
  });

  it("runs by itself for external meetings this week, skipping confidential companies and fresh research", async () => {
    const acme = await organisation("Acme Learning");
    await withEmail("Sam Lee", "sam@acme.test", acme.id);
    const secret = await organisation("Secret Co", { confidential: true });
    await withEmail("Dee Hidden", "dee@secret.test", secret.id);
    await event("o1", at(1), [{ name: "Sam Lee", email: "sam@acme.test" }, { name: "Dee Hidden", email: "dee@secret.test" }]);
    await event("o2", at(10), [{ name: "Far Away", email: "far@later.test" }]);

    expect(await researchUpcoming()).toEqual({ started: ["acme.test"] });
    await waitForResearch();
    expect(calls).toHaveLength(1);

    // Fresh research is reused.
    expect(await researchUpcoming()).toEqual({ started: [] });

    // Older than 30 days, it is done again.
    await db.update(companyResearchTable).set({ researchedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(companyResearchTable.domain, "acme.test"));
    expect((await api("research?domains=acme.test")).body.items[0].stale).toBe(true);
    expect(await researchUpcoming()).toEqual({ started: ["acme.test"] });
    await waitForResearch();
    expect(calls).toHaveLength(2);

    // A confidential company is researched only when Ollie asks.
    const asked = await api("research", { method: "POST", body: { domain: "secret.test" } });
    expect(asked.body.status).toBe("running");
    await waitForResearch();
    expect(calls).toHaveLength(3);
  });

  it("after a failure, automatic research waits before trying again", async () => {
    await event("o1", at(1), [{ name: "Jo", email: "jo@acme.test" }]);
    fail = true;
    expect((await researchUpcoming()).started).toEqual(["acme.test"]);
    await waitForResearch();
    expect((await researchUpcoming()).started).toEqual([]);
  });
});
