/** Home still loads when one of its non-essential parts fails. */
import { expect, it, vi } from "vitest";
import { db, tasksTable } from "@workspace/db";
import { api, useServer } from "./harness";

vi.mock("../src/services/connectorHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectorHealth")>()),
  connectorWarnings: async () => {
    throw new Error("Connection terminated unexpectedly");
  },
}));
vi.mock("../src/services/slackToAnswer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/slackToAnswer")>()),
  slackRepliesOverdue: async () => {
    throw new Error("timeout");
  },
}));

useServer();

it("loads Home without a part that failed, instead of failing the whole page", async () => {
  await db.insert(tasksTable).values({ title: "Call Sam", status: "now", createdBy: "ollie" });
  const res = await api("home");
  expect(res.status).toBe(200);
  expect(res.body.doNext.map((d: { task: { title: string } }) => d.task.title)).toContain("Call Sam");
  expect(res.body.connectorWarnings).toEqual([]);
  expect(res.body.slackToAnswer).toBe(0);
});
