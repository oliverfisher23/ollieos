import { describe, expect, it } from "vitest";
import { loadVisibleDocs } from "../src/lib/ai-data/retrieve";
import { api, useServer } from "./harness";
import { client, scopeFor } from "./helpers";

useServer();

describe("internal and external organisations", () => {
  it("lists external organisations first, then internal ones, and lets people join either", async () => {
    const springpod = await api("organisations", { body: { name: "Springpod", internal: true } });
    expect(springpod.status).toBe(201);
    expect(springpod.body).toMatchObject({ name: "Springpod", internal: true });
    const raf = await api("organisations", { body: { name: "Royal Air Force", type: "Client" } });
    expect(raf.body).toMatchObject({ internal: false });
    await api("organisations", { body: { name: "AMS" } });

    const list = await api("organisations");
    expect(list.body.map((o: { name: string; internal: boolean }) => [o.name, o.internal])).toEqual([
      ["AMS", false],
      ["Royal Air Force", false],
      ["Springpod", true],
    ]);

    // A colleague joins Springpod, then moves to the RAF and back.
    const darren = await api("people", { body: { name: "Darren Holmes", organisationId: springpod.body.id } });
    expect(darren.status).toBe(201);
    const page = await api("organisations/springpod");
    expect(page.body.organisation.internal).toBe(true);
    expect(page.body.people.map((p: { name: string }) => p.name)).toEqual(["Darren Holmes"]);
    await api(`people/${darren.body.slug}`, { method: "PATCH", body: { organisationId: raf.body.id } });
    expect((await api("organisations/springpod")).body.people).toEqual([]);

    // Switching an organisation between external and internal.
    const flipped = await api("organisations/royal-air-force", { method: "PATCH", body: { internal: true } });
    expect(flipped.body.internal).toBe(true);
    expect((await api("organisations/royal-air-force", { method: "PATCH", body: { internal: "yes" } })).status).toBe(400);
  });

  it("tells the AI which organisation is Ollie's own company", async () => {
    const sp = await api("organisations", { body: { name: "Springpod", internal: true } });
    const ams = await api("organisations", { body: { name: "AMS" } });
    const scope = await scopeFor(await client("Claude"));
    const docs = await loadVisibleDocs(scope, [`organisation:${sp.body.id}`, `organisation:${ams.body.id}`]);
    const text = (id: number) => docs.find((d) => d.ref === `organisation:${id}`)!.text;
    expect(text(sp.body.id)).toContain("Internal: Ollie's own company");
    expect(text(ams.body.id)).toContain("External");
  });
});
