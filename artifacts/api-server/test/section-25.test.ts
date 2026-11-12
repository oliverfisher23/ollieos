/**
 * Build plan section 25: the contact finder, and approving a new person with their organisation.
 * The model is stood in at recordedCreate, so the real prompt is built and the real answer parsed.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { contactFinderSeenTable, contactSightingsTable, db, organisationsTable, peopleTable, suggestionsTable, tasksTable } from "@workspace/db";
import type { AgentKey } from "../src/lib/agents";
import { approveSuggestion, approveWithPeople, propose } from "../src/services/suggestions";
import { findContacts, qualifies, recordSightings, sightingsFromThread, sightingsFromUnits, setContactFinderSettings, undoAutoAdded, type Sighting } from "../src/services/contactFinder";
import { loadPeople } from "../src/services/connectors/capture";
import type { WorkUnit } from "../src/services/connectors/messages";
import { api, useServer } from "./harness";
import { organisation, person } from "./helpers";

type Call = { agent: AgentKey; system: string; content: string };
const calls: Call[] = [];
const answers: Partial<Record<AgentKey, (c: Call) => unknown>> = {};

vi.mock("../src/lib/aiRuns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/aiRuns")>()),
  recordedCreate: async (agent: AgentKey, params: { system: string; messages: { content: string }[] }) => {
    const c = { agent, system: String(params.system), content: String(params.messages[0].content) };
    calls.push(c);
    const answer = answers[agent];
    if (!answer) throw new Error(`No stand-in answer for ${agent}`);
    return { content: [{ type: "text", text: JSON.stringify(answer(c)) }], usage: {} };
  },
}));

useServer();

const reset = () => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k as AgentKey];
};
const meta = { proposedBy: "Claude", clientId: null };
const DAY = 86_400_000;

/** Sightings of one address in several places. */
async function seen(email: string, name: string, places: { source?: "email" | "meeting"; ollie: boolean; they: boolean; label?: string; company?: string; title?: string }[]) {
  const list: Sighting[] = places.map((p, i) => ({
    email,
    name,
    source: p.source ?? "email",
    ref: `${p.source ?? "email"}:${email}:${i}`,
    label: p.label ?? `Thread ${i}`,
    at: new Date(Date.now() - i * DAY),
    ollieWrote: p.ollie,
    theyWrote: p.they,
    company: p.company ?? null,
    title: p.title ?? null,
  }));
  await recordSightings(list);
}

/** The stand-in model: everyone is a person unless the address says "bot"; domains are companies named from their first label. */
function standIn() {
  answers.contact_finder = (c) => ({
    people: [...c.content.matchAll(/\[(p\d+)\] (\S+?),? (?:shown as "([^"]+)")?/g)].map((m) => ({
      ref: m[1],
      reasoning: "Looks like one person",
      is_person: !m[2].includes("bot"),
      name: m[3] ?? m[2].split("@")[0],
      role: m[2].startsWith("jo") ? "Head of Partnerships" : "",
      relationship: "Talks to you about the pilot — weekly",
    })),
    organisations: [...c.content.matchAll(/^- ([a-z0-9.-]+\.[a-z]+)/gm)].map((m) => ({
      domain: m[1],
      reasoning: "A company",
      is_company: true,
      name: m[1].split(".")[0].replace(/^./, (x) => x.toUpperCase()) + " Ltd",
      type: "partner",
      summary: "",
    })),
  });
}

describe("Approving a new person with their organisation", () => {
  it("links an organisation of that name, approves the card they came with, or creates one", async () => {
    reset();
    const acme = await organisation("Acme");
    const a = (await propose(meta, { kind: "person", payload: { name: "Ann Lee", organisation_name: "acme" } })) as { suggestionId: number };
    const b = (await propose(meta, { kind: "person", payload: { name: "Bo Chen", organisation_name: "Brand New Co" } })) as { suggestionId: number };
    const org = (await propose(meta, { kind: "organisation", payload: { name: "Waiting Org", domains: ["waiting.org", "nonsense"] } })) as { suggestionId: number };
    const c = (await propose(meta, { kind: "person", payload: { name: "Cy Ray", organisation_name: "Waiting Org", organisation_suggestion_id: org.suggestionId } })) as { suggestionId: number };

    await approveSuggestion(a.suggestionId);
    await approveSuggestion(b.suggestionId);
    await approveSuggestion(c.suggestionId);
    const people = await db.select().from(peopleTable);
    const orgs = await db.select().from(organisationsTable);
    const orgOf = (name: string) => orgs.find((o) => o.id === people.find((p) => p.name === name)!.organisationId)?.name;
    expect(orgOf("Ann Lee")).toBe("Acme");
    expect(orgOf("Bo Chen")).toBe("Brand New Co");
    expect(orgOf("Cy Ray")).toBe("Waiting Org");
    expect(orgs.find((o) => o.name === "Waiting Org")!.domains).toEqual(["waiting.org"]);
    expect((await db.select().from(suggestionsTable).where(eq(suggestionsTable.id, org.suggestionId)))[0].status).toBe("approved");
    expect(orgs.filter((o) => o.name === "Acme")).toHaveLength(1);
    expect(acme.id).toBe(orgs.find((o) => o.name === "Acme")!.id);
  });

  it("approves a New organisation card together with the people waiting on it", async () => {
    reset();
    const org = (await propose(meta, { kind: "organisation", payload: { name: "Globex" } })) as { suggestionId: number };
    for (const n of ["Dee One", "Eve Two"]) await propose(meta, { kind: "person", payload: { name: n, organisation_name: "Globex", organisation_suggestion_id: org.suggestionId } });
    const listed = await api("suggestions");
    expect(listed.body.items.find((i: { id: number }) => i.id === org.suggestionId).peopleWaiting).toBe(2);
    const r = await api(`suggestions/${org.suggestionId}/approve-with-people`, { method: "POST" });
    expect(r.body).toMatchObject({ organisation: { type: "organisation" }, people: 2, skipped: [] });
    const [globex] = await db.select().from(organisationsTable);
    expect((await db.select().from(peopleTable)).every((p) => p.organisationId === globex.id)).toBe(true);
  });
});

describe("Sightings", () => {
  it("records only unknown people from exchanges AI may read, never automated or shared addresses", async () => {
    reset();
    const known = await person("Sam Known");
    await db.update(peopleTable).set({ email: "sam@acme.com" }).where(eq(peopleTable.id, known.id));
    const at = new Date();
    const unit = (key: string, people: string[], msgs: { from: string; me?: boolean }[]): WorkUnit => ({
      source: "email",
      key,
      subject: "Pilot",
      channel: null,
      people: people.map((e) => ({ name: e.split("@")[0], email: e })),
      messages: msgs.map((m, i) => ({ ref: `${key}#${i}`, at, fromMe: !!m.me, fromName: m.me ? null : m.from.split("@")[0], fromAddress: m.me ? null : m.from, text: "Hi", url: "" })),
      conversation: { id: key, kind: "thread" },
    });
    const units = [
      unit("t1", ["jo@globex.com", "sam@acme.com", "noreply@globex.com", "info@globex.com"], [{ from: "jo@globex.com" }, { from: "", me: true }]),
      unit("t2", ["kim@hidden.com"], [{ from: "kim@hidden.com" }]),
    ];
    const people = await loadPeople(units, []);
    const sorted = [{ summary: "", project: "", items: [], signature: { title: "Head of Partnerships", company: "Globex Group", phone: "" } }, { summary: "", project: "", items: [] }];
    const list = sightingsFromUnits(units, sorted, [true, false], people);
    expect(list.map((s) => s.email)).toEqual(["jo@globex.com", "noreply@globex.com", "info@globex.com"]);
    expect(await recordSightings(list)).toBe(1);
    const [row] = await db.select().from(contactSightingsTable);
    expect(row).toMatchObject({ key: "jo@globex.com", ollieWrote: true, theyWrote: true, title: "Head of Partnerships", company: "Globex Group", ref: "email:t1" });

    // Seen again in the same thread: one row, still two-way.
    await recordSightings([{ email: "JO@globex.com", source: "email", ref: "email:t1", at, ollieWrote: false, theyWrote: false }]);
    expect(await db.select().from(contactSightingsTable)).toHaveLength(1);
  });

  it("reads the look back's threads, and skips a thread with anyone hidden from AI", async () => {
    reset();
    const hidden = await person("Hidden One", { confidential: true });
    await db.update(peopleTable).set({ email: "hid@x.com" }).where(eq(peopleTable.id, hidden.id));
    const at = new Date();
    const msg = (from: string, to: string[], sent = false) => ({ at, labels: new Set(sent ? ["SENT"] : []), from: { name: null, email: from }, to: to.map((e) => ({ name: null, email: e })), cc: [], subject: "Hello" });
    const s = await sightingsFromThread("th1", [msg("ollie@springpod.com", ["new@co.com"], true), msg("new@co.com", ["ollie@springpod.com"])]);
    expect(s).toEqual([expect.objectContaining({ email: "new@co.com", ollieWrote: true, theyWrote: true, ref: "email:th1" })]);
    expect(await sightingsFromThread("th2", [msg("ollie@springpod.com", ["new@co.com", "hid@x.com"], true)])).toEqual([]);
  });

  it("needs real two-way contact before anyone is a candidate", () => {
    const base = { meetings: 0, twoWay: 0, places: 1, wrote: 0, slack: 0 };
    expect(qualifies(base)).toBe(false);
    expect(qualifies({ ...base, places: 5 })).toBe(false); // only ever wrote to Ollie
    expect(qualifies({ ...base, meetings: 1 })).toBe(true);
    expect(qualifies({ ...base, twoWay: 1, places: 2 })).toBe(true);
    expect(qualifies({ ...base, wrote: 2, places: 2 })).toBe(true);
  });
});

describe("Contact finder", () => {
  it("proposes people under their organisation, a new company as one card, and an email for a same-name person", async () => {
    reset();
    standIn();
    const acme = await organisation("Acme");
    await db.update(organisationsTable).set({ domains: ["acme.com"] }).where(eq(organisationsTable.id, acme.id));
    await person("Pat Older"); // in Contacts, no email
    await seen("jo@globex.com", "Jo Smith", [{ ollie: true, they: true, company: "Globex Group" }, { ollie: true, they: true }]);
    await seen("li@globex.com", "Li Wu", [{ source: "meeting", ollie: true, they: true }]);
    await seen("ann@acme.com", "Ann Lee", [{ ollie: true, they: true }, { ollie: true, they: false }]);
    await seen("friend@gmail.com", "A Friend", [{ ollie: true, they: true }, { ollie: true, they: true }]);
    await seen("pat@older.org", "Pat Older", [{ source: "meeting", ollie: true, they: true }]);
    await seen("bot@acme.com", "Acme Bot", [{ ollie: true, they: true }, { ollie: true, they: true }]);
    await seen("cold@spam.com", "Cold Caller", [{ ollie: false, they: true }, { ollie: false, they: true }, { ollie: false, they: true }]);

    const r = await findContacts();
    expect(r).toMatchObject({ people: 4, organisations: 2, emails: 1, ignored: 1, added: 0, failed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].content).not.toContain("cold@spam.com");
    expect(calls[0].content).toContain("signatures say: Globex Group");

    const cards = await db.select().from(suggestionsTable).where(eq(suggestionsTable.proposedBy, "Contact finder"));
    const card = (name: string) => cards.find((c) => (c.payload as { name?: string }).name === name);
    const globex = card("Globex Ltd")!;
    expect(globex.payload).toMatchObject({ domains: ["globex.com"], type: "partner" });
    expect(card("Jo Smith")!.payload).toMatchObject({ email: "jo@globex.com", role: "Head of Partnerships", organisation_suggestion_id: globex.id, relationship_summary: "Talks to you about the pilot, weekly" });
    expect(card("Li Wu")!.payload).toMatchObject({ organisation_suggestion_id: globex.id });
    expect(card("Ann Lee")!.payload).toMatchObject({ organisation_id: acme.id });
    expect(card("A Friend")!.payload).toMatchObject({ organisation_id: null, organisation_suggestion_id: null });
    expect(card("Acme Bot")).toBeUndefined();
    const change = cards.find((c) => c.kind === "summary_change")!;
    expect(change.payload).toMatchObject({ fields: { email: "pat@older.org" } });

    // Nothing is proposed twice; a card Ollie rejects is never proposed again.
    calls.length = 0;
    expect((await findContacts()).looked).toBe(0);
    await api(`suggestions/${card("A Friend")!.id}/reject`, { method: "POST" });
    await findContacts();
    const [f] = await db.select().from(contactFinderSeenTable).where(eq(contactFinderSeenTable.key, "friend@gmail.com"));
    expect(f).toMatchObject({ status: "ignored", why: "You rejected the card" });

    // Approving Globex with its people puts both under it.
    await api(`suggestions/${globex.id}/approve-with-people`, { method: "POST" });
    const people = await db.select().from(peopleTable);
    const [g] = await db.select().from(organisationsTable).where(eq(organisationsTable.name, "Globex Ltd"));
    expect(people.filter((p) => p.organisationId === g.id).map((p) => p.name).sort()).toEqual(["Jo Smith", "Li Wu"]);
  });

  it("adds the clearest people itself only when turned on, and Undo removes them for good", async () => {
    reset();
    standIn();
    const acme = await organisation("Acme");
    await db.update(organisationsTable).set({ domains: ["acme.com"] }).where(eq(organisationsTable.id, acme.id));
    await seen("ann@acme.com", "Ann Lee", [{ ollie: true, they: true }, { ollie: true, they: true }]);
    await seen("bob@acme.com", "Bob Day", [{ ollie: true, they: true }, { ollie: true, they: false }]);
    await seen("jo@globex.com", "Jo Smith", [{ ollie: true, they: true }, { ollie: true, they: true }]);
    await setContactFinderSettings({ autoAdd: true });

    const r = await findContacts();
    // Ann: two-way twice at a known organisation. Bob: not sure enough. Jo: new organisation, so a card.
    expect(r).toMatchObject({ added: 1, people: 2 });
    const [ann] = await db.select().from(peopleTable).where(eq(peopleTable.name, "Ann Lee"));
    expect(ann).toMatchObject({ organisationId: acme.id, email: "ann@acme.com" });
    expect(ann.autoAddedAt).not.toBeNull();
    const listed = (await api("people")).body as { name: string; autoAddedAt: string | null }[];
    expect(listed.find((p) => p.name === "Ann Lee")!.autoAddedAt).not.toBeNull();

    // Undo is refused once something is linked to them, and works otherwise.
    const [t] = await db.insert(tasksTable).values({ title: "Call Ann", personId: ann.id, createdBy: "ollie" }).returning();
    expect((await api(`contacts/${ann.id}/undo-auto-add`, { method: "POST" })).status).toBe(400);
    await db.delete(tasksTable).where(eq(tasksTable.id, t.id));
    await undoAutoAdded(ann.id);
    expect(await db.select().from(peopleTable).where(eq(peopleTable.name, "Ann Lee"))).toHaveLength(0);
    const [seenAnn] = await db.select().from(contactFinderSeenTable).where(eq(contactFinderSeenTable.key, "ann@acme.com"));
    expect(seenAnn.status).toBe("ignored");
    expect((await db.select().from(suggestionsTable).where(eq(suggestionsTable.proposedBy, "Contact finder"))).find((s) => (s.payload as { name: string }).name === "Ann Lee")!.status).toBe("rejected");

    // Off by default: the setting reads back.
    await setContactFinderSettings({ autoAdd: false });
    expect((await api("settings/contact-finder")).body).toEqual({ autoAdd: false });
  });
});
