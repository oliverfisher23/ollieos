import { describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { auditEventsTable, db, linksTable, suggestionsTable } from "@workspace/db";
import { api, call, connect, mcp, useServer } from "./harness";
import { decision, organisation, person, project, task } from "./helpers";

useServer();

async function claude() {
  return mcp((await connect()).access_token);
}

/** Acme employs Sam, Kim and a confidential person; Apollo is open, Zeus is confidential. */
async function world() {
  const acme = await organisation("Acme");
  const sam = await person("Sam Lee", { organisationId: acme.id, role: "Head of Sales" });
  const kim = await person("Kim Ross", { organisationId: acme.id });
  const secret = await person("Secret Person", { organisationId: acme.id, confidential: true });
  const apollo = await project("Apollo");
  const zeus = await project("Zeus", { confidential: true });
  await task("Send Sam the plan", { projectId: apollo.id, personId: sam.id });
  const zeusDecision = await decision(zeus.id, "Zeus goes ahead");
  await api("relationships", { method: "PUT", body: { fromType: "person", fromId: secret.id, toType: "project", toId: zeus.id, relationship: "advises" } });
  await api("relationships", { method: "PUT", body: { fromType: "person", fromId: sam.id, toType: "project", toId: zeus.id, relationship: "works_with" } });
  return { acme, sam, kim, secret, apollo, zeus, zeusDecision };
}

describe("explore for AI tools", () => {
  it("returns what is around an item as sentences and never shows or follows hidden items", async () => {
    const w = await world();
    const c = await claude();
    const out = await call(c, "explore", { item: "Sam Lee", depth: 2 });
    expect(out.isError).toBeFalsy();
    const items = (out.json.items as { ref: string }[]).map((i) => i.ref);
    expect(items).toEqual(expect.arrayContaining([`organisation:${w.acme.id}`, `person:${w.kim.id}`, `project:${w.apollo.id}`]));
    expect(items).not.toContain(`person:${w.secret.id}`);
    expect(items).not.toContain(`project:${w.zeus.id}`);
    expect(items).not.toContain(`decision:${w.zeusDecision.id}`);
    const says = (out.json.links as { says: string }[]).map((l) => l.says);
    expect(says).toContain("Sam Lee works at Acme");
    expect(says.join(" ")).not.toMatch(/Secret|Zeus/);
    expect(out.json.hidden_items).toBeGreaterThan(0);

    // Every item returned is logged as read by the tool.
    const reads = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "read"));
    expect(reads.length).toBeGreaterThan(0);

    // A hidden item cannot be the centre either.
    expect((await call(c, "explore", { item: `person:${w.secret.id}` })).isError).toBe(true);
  });

  it("finds a connection only through visible items", async () => {
    const w = await world();
    const c = await claude();
    const out = await call(c, "find_connection", { from: `person:${w.sam.id}`, to: "Kim Ross" });
    expect(out.isError).toBeFalsy();
    const paths = out.json.paths as { steps: string[] }[];
    expect(paths[0].steps).toEqual(["Sam Lee works at Acme", "Kim Ross works at Acme"]);

    // Zeus is only reachable through hidden items, so there is no route to it.
    expect((await call(c, "find_connection", { from: "Sam Lee", to: `project:${w.zeus.id}` })).isError).toBe(true);
  });

  it("fetches one item in full, but not a hidden one", async () => {
    const w = await world();
    const apolloDecision = await decision(w.apollo.id, "Apollo launches in March");
    const c = await claude();
    const ok = await call(c, "fetch", { id: `decision:${apolloDecision.id}` });
    expect(ok.json).toMatchObject({ id: `decision:${apolloDecision.id}`, title: "Apollo launches in March" });
    expect(ok.json.text).toContain("Apollo launches in March");
    expect((await call(c, "fetch", { id: `decision:${w.zeusDecision.id}` })).isError).toBe(true);
  });
});

describe("Ollie's map", () => {
  it("shows hidden items marked, but does not follow them", async () => {
    const w = await world();
    const r = await api(`graph/explore?ref=person:${w.sam.id}&depth=2`);
    expect(r.status).toBe(200);
    const nodes = r.body.nodes as { ref: string; hidden: boolean }[];
    expect(nodes.find((n) => n.ref === `person:${w.secret.id}`)?.hidden).toBe(true);
    expect(nodes.find((n) => n.ref === `project:${w.zeus.id}`)?.hidden).toBe(true);
    // The Zeus decision sits behind a hidden project, so it is not on the map.
    expect(nodes.map((n) => n.ref)).not.toContain(`decision:${w.zeusDecision.id}`);

    const all = await api("graph/overview");
    expect((all.body.nodes as { ref: string }[]).map((n) => n.ref)).toEqual(expect.arrayContaining([`organisation:${w.acme.id}`, `person:${w.sam.id}`]));
    expect((await api("graph/explore?ref=person:99999")).status).toBe(404);
  });
});

describe("relationships", () => {
  it("are set, read from both ends, replaced and removed", async () => {
    const sam = await person("Sam Lee");
    const kim = await person("Kim Ross");
    const apollo = await project("Apollo");
    const set = await api("relationships", { method: "PUT", body: { fromType: "person", fromId: sam.id, toType: "person", toId: kim.id, relationship: "reports_to", note: "Since October" } });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ phrase: "reports to", other: { name: "Kim Ross" }, note: "Since October" });
    const fromKim = await api(`relationships?type=person&id=${kim.id}`);
    expect(fromKim.body).toEqual([expect.objectContaining({ phrase: "manages", direction: "in", other: expect.objectContaining({ name: "Sam Lee" }) })]);

    // One relationship per pair: a new one replaces the old.
    await api("relationships", { method: "PUT", body: { fromType: "person", fromId: kim.id, toType: "person", toId: sam.id, relationship: "works_with" } });
    expect((await api(`relationships?type=person&id=${sam.id}`)).body.map((r: { phrase: string }) => r.phrase)).toEqual(["works with"]);
    expect((await api("relationships", { method: "PUT", body: { fromType: "person", fromId: sam.id, toType: "person", toId: sam.id, relationship: "works_with" } })).status).toBe(400);

    // Removing a project relationship keeps the person on the project.
    await api("relationships", { method: "PUT", body: { fromType: "person", fromId: sam.id, toType: "project", toId: apollo.id, relationship: "advises" } });
    expect((await api("relationships", { method: "DELETE", body: { fromType: "person", fromId: sam.id, toType: "project", toId: apollo.id } })).body).toEqual({ removed: true });
    const left = await db.select().from(linksTable).where(and(eq(linksTable.fromType, "person"), eq(linksTable.toType, "project")));
    expect(left).toHaveLength(1);
    expect(left[0].relationship).toBeNull();
    await api("relationships", { method: "DELETE", body: { fromType: "person", fromId: sam.id, toType: "person", toId: kim.id } });
    expect((await api(`relationships?type=person&id=${sam.id}`)).body).toEqual([]);
  });

  it("proposed by AI wait in the Knowledge Inbox, then apply with their source", async () => {
    const acme = await organisation("Acme");
    const beta = await organisation("Beta Ltd");
    const c = await claude();
    const out = await call(c, "propose_relationship", {
      from: { name: "Beta Ltd" },
      relationship: "customer_of",
      to: { name: "Acme" },
      evidence: "Beta signed with Acme in October",
      source: "Email from Beta, 3rd November",
    });
    expect(out.isError).toBeFalsy();
    expect(await db.select().from(linksTable).where(isNotNull(linksTable.relationship))).toHaveLength(0);

    const inbox = await api("suggestions?tab=suggested");
    const card = (inbox.body.items as { kind: string; text: string; id: string }[]).find((i) => i.kind === "new_relationship");
    expect(card?.text).toBe("Beta Ltd is a customer of Acme");

    const [s] = await db.select().from(suggestionsTable).where(eq(suggestionsTable.kind, "relationship"));
    expect((await api(`suggestions/${s.id}/approve`, { body: {} })).status).toBe(200);
    const [row] = await db.select().from(linksTable).where(isNotNull(linksTable.relationship));
    expect(row).toMatchObject({ fromType: "organisation", fromId: beta.id, toType: "organisation", toId: acme.id, relationship: "customer_of", note: "Beta signed with Acme in October" });
    expect(row.source).toBeTruthy();

    // Proposing what is already there is a duplicate, not a new card.
    const again = await call(c, "propose_relationship", { from: { name: "Beta Ltd" }, relationship: "customer_of", to: { name: "Acme" } });
    expect(again.json.status).toBe("duplicate");
  });
});
