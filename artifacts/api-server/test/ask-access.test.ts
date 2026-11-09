import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { aiClientsTable, auditEventsTable, db, pool } from "@workspace/db";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import { client, project, resetDb, scopeFor, task } from "./helpers";

/** Every batch of items handed to the model, so the test can check nothing hidden got through. */
const seenByModel: AiDoc[][] = [];

vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  // Cites every item it was given, which is the worst case for leaks.
  answerFromDocs: async (_q: string, docs: AiDoc[]) => {
    seenByModel.push(docs);
    return {
      found: true,
      summary: "Here is what OllieOS has.",
      items: docs.map((d) => ({ text: d.text.split("\n")[0], refs: [d.ref] })),
      related: [],
      bundleTitle: "",
    };
  },
  draftReplyFromDocs: async () => "Draft",
}));

const { ask, allowForTurn } = await import("../src/services/ask/ask");
const { visibleRefs } = await import("../src/lib/ai-data/scope");

afterAll(async () => {
  await pool.end();
});

describe("Ask OllieOS with confidential items (criterion 12)", () => {
  beforeEach(async () => {
    await resetDb();
    seenByModel.length = 0;
  });

  it("leaves hidden items out, lets Ollie allow them for the question, and logs every read", async () => {
    const sale = await project("Sale process", { confidential: true, summary: "Selling the bakery to Hendersons" });
    const hiddenTask = await task("Send bakery valuation", { projectId: sale.id });
    const openTask = await task("Fix the bakery sign");

    const first = await ask("What is going on with the bakery?");
    const turn = first.turns[0];
    const firstRefs = seenByModel[0].map((d) => d.ref);
    expect(firstRefs).toContain(`task:${openTask.id}`);
    expect(firstRefs).not.toContain(`project:${sale.id}`);
    expect(firstRefs).not.toContain(`task:${hiddenTask.id}`);
    expect(seenByModel[0].map((d) => d.text).join("\n")).not.toMatch(/Hendersons|Sale process|valuation/);
    expect(turn.hiddenMatches).toBe(true);
    expect(turn.canAllow).toBe(true);
    expect(turn.hiddenItems.map((c) => c.ref)).toEqual(expect.arrayContaining([`project:${sale.id}`]));
    expect(turn.usedConfidential).toBe(false);

    const allowed = await allowForTurn(turn.id);
    const again = allowed.turns.find((t) => t.id === turn.id)!;
    const secondRefs = seenByModel[1].map((d) => d.ref);
    expect(secondRefs).toEqual(expect.arrayContaining([`project:${sale.id}`, `task:${hiddenTask.id}`]));
    expect(again.usedConfidential).toBe(true);
    expect(again.canAllow).toBe(false);

    // The approval belongs to Ask OllieOS only: another tool still sees nothing.
    const claude = await scopeFor(await client("Claude"));
    expect((await visibleRefs(claude, [`project:${sale.id}`, `task:${hiddenTask.id}`])).size).toBe(0);

    // One read row per item given to the model, under the Ask OllieOS client.
    const [askClient] = await db.select().from(aiClientsTable).where(eq(aiClientsTable.name, "Ask OllieOS"));
    const reads = await db
      .select()
      .from(auditEventsTable)
      .where(and(eq(auditEventsTable.action, "read"), eq(auditEventsTable.clientId, askClient.id)));
    expect(reads).toHaveLength(seenByModel[0].length + seenByModel[1].length);
    expect(reads.every((r) => r.actor === "Ask OllieOS")).toBe(true);
    expect(reads.some((r) => r.entityType === "project" && r.entityId === sale.id)).toBe(true);
  });

  it("does not offer to allow anything when nothing was held back", async () => {
    await task("Fix the bakery sign");
    const res = await ask("bakery sign");
    expect(res.turns[0].hiddenMatches).toBe(false);
    expect(res.turns[0].canAllow).toBe(false);
    await expect(allowForTurn(res.id)).rejects.toThrow(/Nothing was held back/);
  });
});
