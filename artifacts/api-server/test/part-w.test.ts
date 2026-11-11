/**
 * Part W (build plan section 21): scorecards from Ollie's own decisions, and the round-up slip line.
 */
import { describe, expect, it } from "vitest";
import { db, suggestionsTable, taskEvidenceTable, tasksTable } from "@workspace/db";
import { buildRoundupContent } from "../src/services/roundup";
import { scorecards, slipped } from "../src/services/scorecards";
import { api, useServer } from "./harness";

useServer();

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

async function slackTasks(statuses: string[], createdAt: Date) {
  await db.insert(tasksTable).values(statuses.map((status, i) => ({ title: `Item ${i}`, status: status as never, source: "slack" as const, createdBy: "ollieos", createdAt })));
}

describe("scorecards", () => {
  it("counts kept, undone and waiting Inbox items for a sorter, this week against last", async () => {
    await slackTasks(["now", "done", "backlog", "noise", "inbox", "dropped"], ago(1));
    await slackTasks(["now", "now", "now", "done"], ago(9));
    // Made by hand, or caught by a noise rule: not the agent's doing.
    await db.insert(tasksTable).values({ title: "Mine", status: "noise", source: "slack", createdBy: "ollie", createdAt: ago(1) });
    const m = (await scorecards()).find((x) => x.key === "slack_tasks")!;
    expect(m).toMatchObject({ agent: "slack_sorter", kept: 3, undone: 2, waiting: 1, rate: 60, lastRate: 100, lastDecided: 4 });
  });

  it("counts Knowledge Inbox cards by proposer, and Part U evidence that was undone", async () => {
    const card = (status: "approved" | "rejected" | "merged" | "pending") => ({ kind: "fact" as const, payload: {}, normalisedText: "x" + Math.random(), proposedBy: "Gmail check", status, createdAt: ago(2) });
    await db.insert(suggestionsTable).values([card("approved"), card("merged"), card("rejected"), card("pending")]);
    const [closed, reopened, looks] = await db
      .insert(tasksTable)
      .values([
        { title: "Closed and stayed closed", status: "done", source: "slack", createdBy: "ollieos" },
        { title: "Closed then reopened", status: "now", source: "slack", createdBy: "ollieos" },
        { title: "Looks done, Not done", status: "now", source: "slack", createdBy: "ollieos" },
      ])
      .returning();
    const ev = (taskId: number, o: Partial<typeof taskEvidenceTable.$inferInsert>) => ({ taskId, source: "slack", sourceRef: "slack:D:" + Math.random(), saidAt: ago(1), quote: "Done", shows: "done", strength: "same", ...o });
    await db.insert(taskEvidenceTable).values([ev(closed.id, { applied: true }), ev(reopened.id, { applied: true }), ev(looks.id, { strength: "other", dismissedAt: new Date() })]);
    const all = await scorecards();
    expect(all.find((x) => x.key === "gmail_cards")).toMatchObject({ kept: 2, undone: 1, waiting: 1, rate: 67 });
    expect(all.find((x) => x.key === "slack_closed")).toMatchObject({ kept: 1, undone: 1, rate: 50 });
    expect(all.find((x) => x.key === "slack_looks")).toMatchObject({ kept: 0, undone: 1, rate: 0 });
  });

  it("shows on the Agents page and names a slipping agent in the weekly round-up", async () => {
    // Last week 5 of 5 kept; this week 2 of 6.
    await slackTasks(["now", "now", "now", "now", "now"], ago(10));
    await slackTasks(["now", "now", "noise", "noise", "noise", "dropped"], ago(2));
    const measures = await scorecards();
    expect(slipped(measures).map((m) => m.key)).toEqual(["slack_tasks"]);

    const agents = (await api("agents")).body;
    const slack = agents.agents.find((a: { key: string }) => a.key === "slack_sorter");
    expect(slack.measures.find((m: { key: string }) => m.key === "slack_tasks")).toMatchObject({ rate: 33, lastRate: 100 });

    const content = await buildRoundupContent(ago(7), new Date());
    expect(content.agents).toEqual([{ text: "Slack sorter: inbox items kept fell from 100% to 33%", detail: "2 kept and 4 undone this week. See Settings, Agents.", private: false }]);
  });

  it("does not call a small sample a slip", async () => {
    await slackTasks(["now", "now"], ago(10));
    await slackTasks(["noise", "noise"], ago(2));
    expect(slipped(await scorecards())).toEqual([]);
  });
});
