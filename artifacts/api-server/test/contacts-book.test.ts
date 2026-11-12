/**
 * Contacts as an address book and organisations as accounts: relationship strength, tags, phone,
 * archive, bulk changes, email domains, merging organisations, people missing from Contacts, who
 * can introduce Ollie, and the reporting lines behind an organisation's chart.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityTable, calendarEventsTable, contactFinderSeenTable, db, factsTable, linksTable, organisationsTable, peopleTable, suggestionsTable } from "@workspace/db";
import { cleanEmailDomain, cleanTags, relationshipStrength } from "@workspace/shared";
import { recordContact } from "../src/services/cadence";
import { nameFromEmail } from "../src/services/missingContacts";
import { proposeSignature } from "../src/services/peopleSignals";
import { fact, link, organisation, person, project, task } from "./helpers";
import { api, useServer } from "./harness";

useServer();

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function touches(personId: number, agos: number[]) {
  await db.insert(activityTable).values(agos.map((ago) => ({ entityType: "person" as const, entityId: personId, kind: "email" as const, summary: "Touch", occurredAt: daysAgo(ago), createdBy: "test" })));
  await db.update(peopleTable).set({ lastContactAt: daysAgo(Math.min(...agos)) }).where(eq(peopleTable.id, personId));
}
async function withEmail(name: string, email: string, opts: Parameters<typeof person>[1] = {}) {
  const p = await person(name, opts);
  await db.update(peopleTable).set({ email }).where(eq(peopleTable.id, p.id));
  return p;
}
const listed = async () => new Map(((await api("people")).body as unknown as Record<string, any>[]).map((p) => [p.slug as string, p]));
async function relate(fromId: number, relationship: "reports_to" | "works_with", toId: number) {
  await db.insert(linksTable).values({ fromType: "person", fromId, toType: "person", toId, relationship, createdBy: "test" });
}

describe("Shared rules", () => {
  it("rates a relationship from how often and how recently", () => {
    expect(relationshipStrength({ daysSince: 5, contactDays: 8 })).toBe("strong");
    expect(relationshipStrength({ daysSince: 40, contactDays: 8 })).toBe("warm");
    expect(relationshipStrength({ daysSince: 10, contactDays: 1 })).toBe("warm");
    expect(relationshipStrength({ daysSince: 30, contactDays: 1 })).toBe("cooling");
    expect(relationshipStrength({ daysSince: 100, contactDays: 3 })).toBe("cooling");
    expect(relationshipStrength({ daysSince: 121, contactDays: 0 })).toBe("cold");
    expect(relationshipStrength({ daysSince: null, contactDays: 0 })).toBe("cold");
  });

  it("cleans tags and email domains", () => {
    expect(cleanTags([" Investors ", "investors", "", "Careers  leads"])).toEqual(["Investors", "Careers leads"]);
    expect(["@Acme.com", "https://www.acme.com/about", "sam@acme.co.uk", "acme"].map(cleanEmailDomain)).toEqual(["acme.com", "acme.com", "acme.co.uk", null]);
    expect(nameFromEmail("anna.clarke@riverbank.example")).toBe("Anna Clarke");
  });
});

describe("People list", () => {
  it("carries strength, tags and details, and marks who is worth archiving", async () => {
    const strong = await person("Sam Strong");
    await touches(strong.id, [2, 9, 16, 23, 30, 37]);
    const cooling = await person("Cara Cooling");
    await touches(cooling.id, [60]);
    // No contact for over a year, no cadence, no project, nothing open.
    const old = await person("Olly Old");
    await db.update(peopleTable).set({ lastContactAt: daysAgo(400) }).where(eq(peopleTable.id, old.id));
    // Same silence, but an open task keeps them in.
    const owed = await person("Owen Owed");
    await db.update(peopleTable).set({ lastContactAt: daysAgo(400) }).where(eq(peopleTable.id, owed.id));
    await task("Send Owen the deck", { personId: owed.id });
    // Same silence, but on an active project.
    const onProject = await person("Pat Project");
    await db.update(peopleTable).set({ lastContactAt: daysAgo(400) }).where(eq(peopleTable.id, onProject.id));
    await link("person", onProject.id, "project", (await project("Pilot")).id);

    const people = await listed();
    expect(people.get(strong.slug)).toMatchObject({ strength: "strong", archiveCandidate: false, tags: [], archived: false });
    expect(people.get(cooling.slug)).toMatchObject({ strength: "cooling" });
    expect(people.get(old.slug)).toMatchObject({ strength: "cold", archiveCandidate: true });
    expect(people.get(owed.slug)).toMatchObject({ archiveCandidate: false });
    expect(people.get(onProject.slug)).toMatchObject({ archiveCandidate: false });
    expect((await api(`people/${strong.slug}`)).body).toMatchObject({ strength: "strong", introductions: [] });
  });

  it("saves a phone number and tags; archiving clears the cadence and new contact brings them back", async () => {
    const p = await person("Anna Clarke");
    const r = await api(`people/${p.slug}`, { method: "PATCH", body: { phone: " 020 7946 0000 ", tags: ["Investors", "investors", "Advisors"], cadence: "monthly" } });
    expect(r.body).toMatchObject({ phone: "020 7946 0000", tags: ["Investors", "Advisors"], cadence: "monthly", archived: false });

    expect((await api(`people/${p.slug}`, { method: "PATCH", body: { archived: true } })).body).toMatchObject({ archived: true, cadence: "none" });
    expect((await api("people/cadence")).body.people).toEqual([]);
    expect((await listed()).get(p.slug)).toMatchObject({ archived: true, archiveCandidate: false });

    await recordContact(db, [p.id], new Date());
    expect((await listed()).get(p.slug)).toMatchObject({ archived: false });
  });

  it("changes several people at once", async () => {
    const org = await organisation("Kestrel Bank");
    const a = await person("Anna Clarke");
    const b = await person("Ben Hall");
    const c = await person("Chloe Ng");
    await db.update(peopleTable).set({ tags: ["Old"] }).where(eq(peopleTable.id, a.id));

    const r = await api("people/bulk", { body: { ids: [a.id, b.id], cadence: "quarterly", addTag: "Investors", removeTag: "old", organisationId: org.id } });
    expect(r.body).toEqual({ updated: 2 });
    const people = await listed();
    for (const p of [a, b]) expect(people.get(p.slug)).toMatchObject({ tags: ["Investors"], organisation: { id: org.id }, cadence: { cadence: "quarterly" } });
    expect(people.get(c.slug)).toMatchObject({ tags: [], organisation: null });

    expect((await api("people/bulk", { body: { ids: [a.id, c.id], archived: true } })).body).toEqual({ updated: 2 });
    expect((await listed()).get(a.slug)).toMatchObject({ archived: true, cadence: { cadence: "none" } });
    expect((await api("people/bulk", { body: { ids: [a.id] } })).status).toBe(400);
  });

  it("a phone number in a signature fills the Phone field through a change card", async () => {
    const sam = await withEmail("Sam Lee", "sam@acme.example");
    const source = { ref: "gmail:p1", url: null, label: "Email", at: new Date() };
    expect(await proposeSignature({ id: sam.id, name: "Sam Lee" }, { title: "", company: "", phone: "+44 20 7946 0000" }, source)).toBe(1);
    const [card] = await db.select().from(suggestionsTable).where(eq(suggestionsTable.entityId, sam.id));
    expect(card).toMatchObject({ kind: "summary_change" });
    expect((card.payload as any).fields).toEqual({ phone: "+44 20 7946 0000" });
    expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    expect((await api(`people/${sam.slug}`)).body.person.phone).toBe("+44 20 7946 0000");
    // The same number again: nothing. A different one: a fact, so Ollie decides.
    expect(await proposeSignature({ id: sam.id, name: "Sam Lee" }, { title: "", company: "", phone: "+44 20-7946-0000" }, { ...source, ref: "gmail:p2" })).toBe(0);
    expect(await proposeSignature({ id: sam.id, name: "Sam Lee" }, { title: "", company: "", phone: "07700 900123" }, { ...source, ref: "gmail:p3" })).toBe(1);
  });
});

describe("Organisation email domains", () => {
  it("places people with no organisation, and new people added later", async () => {
    const kestrel = await organisation("Kestrel Bank");
    const other = await organisation("Atlas Partners");
    const loose = await withEmail("Dev Patel", "dev@kestrel.example");
    const elsewhere = await withEmail("Eve Moran", "eve@kestrel.example", { organisationId: other.id });

    expect((await api(`organisations/${kestrel.slug}/domains`, { method: "PUT", body: { domains: ["gmail.com"] } })).status).toBe(400);
    expect((await api(`organisations/${kestrel.slug}/domains`, { method: "PUT", body: { domains: ["not a domain"] } })).status).toBe(400);
    const r = await api(`organisations/${kestrel.slug}/domains`, { method: "PUT", body: { domains: ["@Kestrel.example", "kestrel.example"] } });
    expect(r.body).toMatchObject({ domains: ["kestrel.example"], placed: [{ id: loose.id, name: "Dev Patel" }] });
    expect((await api(`organisations/${kestrel.slug}`)).body.organisation.domains).toEqual(["kestrel.example"]);
    const people = await listed();
    expect(people.get(loose.slug)!.organisation).toMatchObject({ id: kestrel.id });
    // Someone already at another organisation is left where they are.
    expect(people.get(elsewhere.slug)!.organisation).toMatchObject({ id: other.id });

    const taken = await api(`organisations/${other.slug}/domains`, { method: "PUT", body: { domains: ["kestrel.example"] } });
    expect(taken.status).toBe(400);
    expect(taken.body.error).toContain("Kestrel Bank");

    const added = await api("people", { body: { name: "Finn Ortiz", email: "finn@kestrel.example" } });
    expect(added.body.organisation).toMatchObject({ id: kestrel.id });
  });
});

describe("Merging organisations", () => {
  it("moves people, facts, links and domains, and removes the merged record", async () => {
    const keep = await organisation("BT Group");
    const gone = await organisation("BT");
    await db.update(organisationsTable).set({ domains: ["bt.example"], type: "client" }).where(eq(organisationsTable.id, gone.id));
    const anna = await person("Anna Clarke", { organisationId: gone.id });
    await fact("organisation", gone.id, "BT renews in March");
    const pilot = await project("BT pilot");
    await db.insert(linksTable).values({ fromType: "project", fromId: pilot.id, toType: "organisation", toId: gone.id, createdBy: "test" });
    await db.insert(linksTable).values({ fromType: "person", fromId: anna.id, toType: "organisation", toId: gone.id, relationship: "decides_on", createdBy: "test" });

    const r = await api(`organisations/${keep.slug}/merge`, { body: { otherId: gone.id } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ kept: { id: keep.id }, removed: { name: "BT" }, moved: { people: 1, facts: 1, links: 2 } });

    expect(await db.select().from(organisationsTable).where(eq(organisationsTable.id, gone.id))).toEqual([]);
    const [kept] = await db.select().from(organisationsTable).where(eq(organisationsTable.id, keep.id));
    expect(kept).toMatchObject({ name: "BT Group", type: "client", domains: ["bt.example"] });
    expect((await db.select().from(peopleTable).where(eq(peopleTable.id, anna.id)))[0].organisationId).toBe(keep.id);
    expect(await db.select().from(factsTable).where(and(eq(factsTable.entityType, "organisation"), eq(factsTable.entityId, keep.id)))).toHaveLength(1);
    const links = await db.select().from(linksTable).where(and(eq(linksTable.toType, "organisation"), eq(linksTable.toId, keep.id)));
    expect(links.map((l) => [l.fromType, l.relationship]).sort()).toEqual([["person", "decides_on"], ["project", null]]);

    expect((await api(`organisations/${keep.slug}/merge`, { body: { otherId: keep.id } })).status).toBe(400);
    expect((await api(`organisations/${gone.slug}`)).status).toBe(404);
  });
});

describe("Missing from Contacts", () => {
  const meeting = (ref: string, ago: number, attendees: { name: string; email: string; response?: "accepted" | "declined" }[], personal = false) => ({
    sourceRef: ref,
    title: `Meeting ${ref}`,
    startsAt: daysAgo(ago),
    endsAt: new Date(daysAgo(ago).getTime() + 1800_000),
    attendeeDetails: attendees,
    personal,
  });

  it("lists people on two or more work meetings who are not in Contacts, and adds them", async () => {
    const kestrel = await organisation("Kestrel Bank");
    await db.update(organisationsTable).set({ domains: ["kestrel.example"] }).where(eq(organisationsTable.id, kestrel.id));
    await withEmail("Known Person", "known@kestrel.example");
    const me = { name: "Ollie", email: "ollie-test@example.com" };
    const gita = { name: "Gita Rao", email: "Gita@Kestrel.example" };
    await db.insert(calendarEventsTable).values([
      meeting("a", 20, [me, gita, { name: "Known Person", email: "known@kestrel.example" }, { name: "Once Only", email: "once@kestrel.example" }]),
      meeting("b", 6, [me, gita, { name: "", email: "info@kestrel.example" }, { name: "Dee Clined", email: "dee@kestrel.example", response: "declined" }]),
      meeting("c", -2, [me, gita, { name: "Dee Clined", email: "dee@kestrel.example", response: "declined" }]),
      meeting("d", 3, [me, { name: "Private Friend", email: "friend@home.example" }], true),
      meeting("e", 2, [me, { name: "Private Friend", email: "friend@home.example" }], true),
    ]);

    const list = (await api("contacts/missing")).body.people as Record<string, any>[];
    expect(list.map((m) => m.email)).toEqual(["gita@kestrel.example"]);
    expect(list[0]).toMatchObject({ name: "Gita Rao", meetings: 3, organisation: { id: kestrel.id, name: "Kestrel Bank" } });
    expect(list[0].nextMeetingAt).not.toBeNull();

    const added = await api("contacts/missing/add", { body: { email: "gita@kestrel.example" } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ name: "Gita Rao", email: "gita@kestrel.example", organisation: { id: kestrel.id } });
    const events = await db.select().from(calendarEventsTable);
    expect(events.filter((e) => e.personIds.includes(added.body.id)).map((e) => e.sourceRef).sort()).toEqual(["a", "b", "c"]);
    const [row] = await db.select().from(peopleTable).where(eq(peopleTable.id, added.body.id));
    expect(Math.round((Date.now() - row.lastContactAt!.getTime()) / DAY)).toBe(6);
    expect((await api("contacts/missing")).body.people).toEqual([]);
    expect((await db.select().from(contactFinderSeenTable).where(eq(contactFinderSeenTable.key, "gita@kestrel.example")))[0]).toMatchObject({ status: "added" });
  });

  it("Not now stops someone being listed", async () => {
    const me = { name: "Ollie", email: "ollie-test@example.com" };
    const hal = { name: "Hal Jones", email: "hal@atlas.example" };
    await db.insert(calendarEventsTable).values([meeting("a", 9, [me, hal]), meeting("b", 2, [me, hal])]);
    expect((await api("contacts/missing")).body.people).toHaveLength(1);
    expect((await api("contacts/missing/dismiss", { body: { email: "hal@atlas.example" } })).status).toBe(200);
    expect((await api("contacts/missing")).body.people).toEqual([]);
  });
});

describe("Who can introduce me, and the org chart", () => {
  it("finds people Ollie knows well who are connected to someone he does not", async () => {
    const riverbank = await organisation("Riverbank University");
    const target = await person("Tara Target", { organisationId: riverbank.id });
    const direct = await person("Dina Direct");
    await touches(direct.id, [1, 8, 15, 22, 29, 36]);
    await relate(direct.id, "works_with", target.id);
    const colleague = await person("Cole League", { organisationId: riverbank.id });
    await touches(colleague.id, [3, 20]);
    const middle = await person("Mia Middle");
    await relate(target.id, "reports_to", middle.id);
    const second = await person("Sol Second");
    await touches(second.id, [4, 30]);
    await relate(second.id, "works_with", middle.id);
    // Connected, but Ollie does not know them well either.
    const stranger = await person("Stan Stranger");
    await relate(stranger.id, "works_with", target.id);

    const intro = (await api(`people/${target.slug}`)).body.introductions as { via: { name: string; strength: string }; how: string; kind: string }[];
    expect(intro.map((i) => [i.via.name, i.kind, i.how])).toEqual([
      ["Dina Direct", "direct", "works with Tara Target"],
      ["Cole League", "organisation", "also at Riverbank University"],
      ["Sol Second", "second", "works with Mia Middle, who manages Tara Target"],
    ]);
    expect(intro[0].via.strength).toBe("strong");

    // Once Ollie knows them well himself, there is nothing to suggest.
    await touches(target.id, [1, 5]);
    expect((await api(`people/${target.slug}`)).body.introductions).toEqual([]);
  });

  it("gives the reporting lines between people at an organisation", async () => {
    const org = await organisation("Kestrel Bank");
    const boss = await person("Bea Boss", { organisationId: org.id });
    const a = await person("Anna Clarke", { organisationId: org.id });
    const outsider = await person("Otto Outside");
    await relate(a.id, "reports_to", boss.id);
    await relate(outsider.id, "reports_to", boss.id);
    expect((await api(`organisations/${org.slug}`)).body.reportsTo).toEqual([{ personId: a.id, managerId: boss.id }]);
  });
});
