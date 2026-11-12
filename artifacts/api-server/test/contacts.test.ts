/**
 * Contacts: the people and organisation lists carry what the combined Contacts page needs (cadence
 * status, internal flag, last contact per organisation), and Suggest cadences proposes a cadence from
 * how often Ollie has actually been in touch.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityTable, calendarEventsTable, db, organisationsTable, peopleTable } from "@workspace/db";
import { cadenceForGap, gapsOf, judge } from "../src/services/cadenceSuggestions";
import { link, organisation, person, project } from "./helpers";
import { api, useServer } from "./harness";

useServer();

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

async function touch(personId: number, ago: number, kind: "email" | "meeting" | "slack" | "note" = "email") {
  await db.insert(activityTable).values({ entityType: "person", entityId: personId, kind, summary: "Touch", occurredAt: daysAgo(ago), createdBy: "test" });
}

describe("Suggest cadences: the rhythm", () => {
  it("maps the typical gap to a cadence", () => {
    expect([3, 10, 11, 21, 30, 45, 60, 75, 90].map(cadenceForGap)).toEqual([
      "weekly",
      "weekly",
      "fortnightly",
      "fortnightly",
      "monthly",
      "monthly",
      "two_monthly",
      "two_monthly",
      "quarterly",
    ]);
  });

  it("counts gaps between contact days", () => {
    expect(gapsOf(["2026-10-01", "2026-10-08", "2026-10-22"])).toEqual([7, 14]);
  });

  it("needs three contact days, or active work, before it suggests anything", () => {
    expect(judge({ days: ["2026-10-01", "2026-10-08"], activeProjects: [], client: false, orgName: null })).toBeNull();
    const onProject = judge({ days: ["2026-10-01"], activeProjects: [{ id: 1, name: "Pilot", slug: "pilot", lifecycle: "active" }], client: false, orgName: null });
    expect(onProject).toMatchObject({ cadence: "monthly" });
    expect(onProject!.reason).toBe("In touch once in the last 4 months. On Pilot.");
    const weekly = judge({ days: ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"], activeProjects: [], client: true, orgName: "Riipen" });
    expect(weekly).toMatchObject({ cadence: "weekly", gap: 7 });
    expect(weekly!.reason).toBe("In touch on 4 days in the last 4 months, about every 7 days. Riipen is a client or partner.");
  });
});

describe("Contacts lists", () => {
  it("people carry cadence status and whether they are internal", async () => {
    const home = await organisation("Springpod");
    await db.update(organisationsTable).set({ internal: true }).where(eq(organisationsTable.id, home.id));
    const riipen = await organisation("Riipen");
    await db.update(organisationsTable).set({ type: "partner" }).where(eq(organisationsTable.id, riipen.id));
    const sam = await person("Sam Colleague", { organisationId: home.id });
    const anna = await person("Anna Clarke", { organisationId: riipen.id });
    await db.update(peopleTable).set({ cadence: "monthly", lastContactAt: daysAgo(40) }).where(eq(peopleTable.id, anna.id));

    const r = await api("people");
    expect(r.status).toBe(200);
    const bySlug = new Map((r.body as { slug: string }[]).map((p) => [p.slug, p as Record<string, any>]));
    expect(bySlug.get(sam.slug)).toMatchObject({ internal: true, isSelf: false, organisationType: null, cadence: { cadence: "none", status: "none" } });
    expect(bySlug.get(anna.slug)).toMatchObject({ internal: false, organisationType: "partner", cadence: { cadence: "monthly", cadenceLabel: "Monthly", status: "overdue" } });
    expect(bySlug.get(anna.slug)!.cadence.daysOverdue).toBeGreaterThanOrEqual(9);
  });

  it("organisations carry the latest contact with anyone there", async () => {
    const riipen = await organisation("Riipen");
    const a = await person("Anna Clarke", { organisationId: riipen.id });
    const b = await person("Ben Hall", { organisationId: riipen.id });
    const recent = daysAgo(3);
    await db.update(peopleTable).set({ lastContactAt: daysAgo(30) }).where(eq(peopleTable.id, a.id));
    await db.update(peopleTable).set({ lastContactAt: recent }).where(eq(peopleTable.id, b.id));
    const org = ((await api("organisations")).body as { slug: string; lastContactAt: string | null }[]).find((o) => o.slug === riipen.slug)!;
    expect(new Date(org.lastContactAt!).getTime()).toBe(recent.getTime());
  });
});

describe("Suggest cadences", () => {
  const list = async () => (await api("people/cadence-suggestions")).body as { suggestions: { person: { slug: string }; cadence: string; reason: string }[]; dismissed: number };

  it("suggests from email, Slack and meetings, ignores notes, and skips people who already have one", async () => {
    const weekly = await person("Wendy Weekly");
    for (const ago of [2, 9, 16, 23, 30]) await touch(weekly.id, ago, ago % 2 ? "slack" : "email");
    const monthly = await person("Mo Monthly");
    await db.insert(calendarEventsTable).values(
      [5, 35, 65].map((ago) => ({ sourceRef: `cal-${ago}`, title: "Catch-up", startsAt: daysAgo(ago), endsAt: new Date(daysAgo(ago).getTime() + 1800_000), personIds: [monthly.id] })),
    );
    const notesOnly = await person("Nora Notes");
    for (const ago of [2, 9, 16, 23]) await touch(notesOnly.id, ago, "note");
    const set = await person("Sid Set");
    for (const ago of [2, 9, 16]) await touch(set.id, ago);
    await db.update(peopleTable).set({ cadence: "quarterly" }).where(eq(peopleTable.id, set.id));
    const pilot = await project("Pilot scheme");
    const onProject = await person("Pat Project");
    await link("person", onProject.id, "project", pilot.id);
    await touch(onProject.id, 50);

    const r = await list();
    const bySlug = new Map(r.suggestions.map((s) => [s.person.slug, s]));
    expect(bySlug.get(weekly.slug)).toMatchObject({ cadence: "weekly" });
    expect(bySlug.get(monthly.slug)).toMatchObject({ cadence: "monthly" });
    expect(bySlug.get(onProject.slug)).toMatchObject({ cadence: "monthly" });
    expect(bySlug.get(onProject.slug)!.reason).toContain("On Pilot scheme");
    expect(bySlug.has(notesOnly.slug)).toBe(false);
    expect(bySlug.has(set.slug)).toBe(false);
  });

  it("Not now hides a person until the list is restored, and setting a cadence removes them", async () => {
    const a = await person("Anna Clarke");
    const b = await person("Ben Hall");
    for (const p of [a, b]) for (const ago of [3, 10, 17]) await touch(p.id, ago);
    expect((await list()).suggestions).toHaveLength(2);

    expect((await api("people/cadence-suggestions/dismiss", { body: { personId: a.id } })).status).toBe(200);
    let r = await list();
    expect(r.suggestions.map((s) => s.person.slug)).toEqual([b.slug]);
    expect(r.dismissed).toBe(1);

    expect((await api(`people/${b.slug}`, { method: "PATCH", body: { cadence: "weekly" } })).status).toBe(200);
    expect((await list()).suggestions).toEqual([]);

    expect((await api("people/cadence-suggestions/restore", { body: {} })).status).toBe(200);
    r = await list();
    expect(r.suggestions.map((s) => s.person.slug)).toEqual([a.slug]);
    expect(r.dismissed).toBe(0);
  });
});
