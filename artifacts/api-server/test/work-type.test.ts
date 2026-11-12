/** Client work or internal: on projects, from the suggester, on Tasks' data, in time and the digest. */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, linksTable, meetingHistoryTable, projectsTable, suggestionsTable, tasksTable } from "@workspace/db";
import { timeReport } from "../src/services/timeAndMeetings";
import { buildDigest } from "../src/services/digest";
import { api, useServer } from "./harness";
import { project } from "./helpers";

let answers: Record<string, { function: string; client: string; work: string }> = {};
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    const name = /<project>\n([^:\n]+)/.exec(content)![1];
    return { reasoning: "", function_why: "", client_why: "", client_summary: "", work_why: "Hiring and finance for Springpod itself", ...(answers[name] ?? { function: "unclear", client: "", work: "unclear" }) };
  },
}));
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

type Item = { id: number; slug: string; name: string; workType: string | null; isFunction: boolean };
const list = async () => (await api("projects")).body as unknown as Item[];

async function clientProject(name: string) {
  const p = await project(name);
  const org = (await api("organisations", { body: { name: name + " Ltd", type: "Customer" } })).body;
  await db.insert(linksTable).values({ fromType: "project", fromId: p.id, toType: "organisation", toId: org.id, createdBy: "ollie" });
  return p;
}

describe("client work or internal", () => {
  it("counts a project with a client as client work, function records as internal, and the rest as not sorted until set", async () => {
    const pilot = await clientProject("Northbridge Pilot");
    const hiring = await project("Hiring");
    const all = await list();
    expect(all.find((p) => p.id === pilot.id)!.workType).toBe("client");
    expect(all.find((p) => p.id === hiring.id)!.workType).toBeNull();
    expect(all.filter((p) => p.isFunction).every((p) => p.workType === "internal")).toBe(true);

    expect((await api(`projects/${hiring.slug}`, { method: "PATCH", body: { workType: "internal" } })).body.workType).toBe("internal");
    // An explicit choice wins over a linked client.
    await api(`projects/${pilot.slug}`, { method: "PATCH", body: { workType: "internal" } });
    expect((await list()).find((p) => p.id === pilot.id)!.workType).toBe("internal");
    await api(`projects/${pilot.slug}`, { method: "PATCH", body: { workType: null } });
    expect((await list()).find((p) => p.id === pilot.id)!.workType).toBe("client");
    expect((await api(`projects/${pilot.slug}`, { method: "PATCH", body: { workType: "maybe" } })).status).toBe(400);
  });

  it("is suggested for projects not sorted yet, as a card that sets it when approved", async () => {
    const hiring = await project("Hiring");
    const unclear = await project("Misc");
    await clientProject("Northbridge Pilot");
    answers = { Hiring: { function: "unclear", client: "", work: "internal" } };
    const r = (await api("projects/suggest-functions", { body: {} })).body;
    expect(r.workTypes).toBe(1);
    const [card] = await db.select().from(suggestionsTable).where(eq(suggestionsTable.entityId, hiring.id));
    expect(card).toMatchObject({ kind: "summary_change", entityType: "project" });
    expect((card.payload as { fields: Record<string, string> }).fields).toEqual({ work_type: "internal" });
    const inbox = (await api("suggestions")).body;
    const item = inbox.items.find((i: { id: number }) => i.id === card.id);
    expect(item.fields).toEqual([expect.objectContaining({ key: "work_type", label: "Client or internal", value: "Internal" })]);
    expect((await api(`suggestions/${card.id}/approve`, { body: {} })).status).toBe(200);
    const [row] = await db.select().from(projectsTable).where(eq(projectsTable.id, hiring.id));
    expect(row.workType).toBe("internal");
    expect((await db.select().from(suggestionsTable).where(eq(suggestionsTable.entityId, unclear.id)))).toHaveLength(0);
  });

  it("splits meeting time into client work and internal, and puts client work first in the digest", async () => {
    const pilot = await clientProject("Northbridge Pilot");
    const hiring = await project("Hiring");
    await db.update(projectsTable).set({ workType: "internal" }).where(eq(projectsTable.id, hiring.id));
    const at = new Date("2026-11-17T10:00:00Z");
    await db.insert(meetingHistoryTable).values([
      { sourceRef: "1", title: "Pilot review", startsAt: at, minutes: 90, scope: "external", projectId: pilot.id },
      { sourceRef: "2", title: "Hiring panel", startsAt: at, minutes: 60, scope: "internal", projectId: hiring.id },
      { sourceRef: "3", title: "Catch-up", startsAt: at, minutes: 30, scope: "internal" },
    ]);
    const w = (await timeReport(new Date("2026-11-18T12:00:00Z"))).weeks[0];
    expect(w.byWork).toEqual([
      { key: "client", label: "Client work", hours: 1.5 },
      { key: "internal", label: "Internal", hours: 1 },
      { key: "none", label: "Not linked", hours: 0.5 },
    ]);

    // New promises: the client one comes first in Moved.
    await db.insert(tasksTable).values([
      { title: "Send the hiring plan", kind: "promise", status: "now", createdBy: "ollie", projectId: hiring.id, createdAt: new Date("2026-11-15T12:00:00Z") },
      { title: "Send the pilot report", kind: "promise", status: "now", createdBy: "ollie", projectId: pilot.id, createdAt: new Date("2026-11-15T12:00:01Z") },
    ]);
    const d = await buildDigest("2026-11-16", new Date("2026-11-16T07:00:00Z"));
    const texts = (d.sections.moved?.items ?? []).map((i) => i.text);
    const pilotAt = texts.findIndex((t) => t.includes("pilot report"));
    const hiringAt = texts.findIndex((t) => t.includes("hiring plan"));
    expect(pilotAt).toBeGreaterThanOrEqual(0);
    expect(hiringAt).toBeGreaterThan(pilotAt);
  });
});
