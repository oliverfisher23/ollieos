import { afterEach, beforeEach, expect, it, vi } from "vitest";

const timing = vi.hoisted(() => ({
  seedMs: 40,
  calls: [] as { name: string; at: number }[],
}));
async function delayed<T>(name: string, ms: number, value: T): Promise<T> {
  timing.calls.push({ name, at: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
}

vi.mock("@workspace/db", async (original) => {
  const real = await original<typeof import("@workspace/db")>();
  return {
    ...real,
    db: {
      select: () => {
        const builder: Record<string, unknown> = {};
        for (const key of ["from", "where", "groupBy", "orderBy", "limit"]) builder[key] = () => builder;
        builder.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
          delayed("query", 80, []).then(resolve, reject);
        return builder;
      },
    },
  };
});
vi.mock("../src/services/taskView", () => ({ toTaskViews: () => delayed("enrich", 50, []) }));
vi.mock("../src/services/access", () => ({ listAccessRequests: () => delayed("access", 40, { pending: [], open: [] }) }));
vi.mock("../src/services/briefs", () => ({ briefableIds: () => delayed("briefs", 60, new Set()), notPreppedIds: () => delayed("unprepped", 20, new Set()) }));
vi.mock("../src/services/slackToAnswer", () => ({ slackRepliesOverdue: () => delayed("slack", 30, []) }));
vi.mock("../src/services/messages", () => ({ emailRepliesOverdue: () => delayed("emails", 30, 0) }));
vi.mock("../src/services/connectorHealth", () => ({ connectorWarnings: () => delayed("warnings", 30, []) }));
vi.mock("../src/services/digest", () => ({ todaysDigestDate: () => delayed("digest", 70, null) }));
vi.mock("../src/services/seeds", () => ({ ensureSeeds: () => delayed("seeds", timing.seedMs, undefined) }));
vi.mock("../src/services/knowledgeInbox", () => ({
  ensureSelfPerson: () => delayed("self", 30, undefined),
  inboxCounts: () => delayed("counts", 30, {}),
}));
vi.mock("../src/services/strategy", () => ({ dueIdeas: () => delayed("ideas", 20, []) }));

const { getHome } = await import("../src/services/home");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  timing.calls = [];
  timing.seedMs = 40;
});
afterEach(() => { vi.useRealTimers(); });

it("starts independent reads immediately and enriches tasks without waiting for brief matching", async () => {
  let finished = false;
  const home = getHome().then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(0);
  for (const name of ["digest", "access", "counts", "ideas", "seeds", "self", "slack", "emails", "warnings"]) {
    expect(timing.calls.find((call) => call.name === name)?.at).toBe(0);
  }
  expect(timing.calls.filter((call) => call.name === "query")).toHaveLength(8);
  await vi.advanceTimersByTimeAsync(80);
  expect(timing.calls.filter((call) => call.name === "enrich").map((call) => call.at)).toEqual([80, 80, 80, 80]);
  expect(timing.calls.find((call) => call.name === "briefs")?.at).toBe(80);
  await vi.advanceTimersByTimeAsync(59);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await home;
  expect(finished).toBe(true);
  // Same controlled branch delays: old stages totalled 80 + 70 + 30 + 40 + 50 = 270 ms.
  expect(Date.now()).toBe(140);
});

it("waits for seeded goals before task enrichment, without delaying unrelated reads", async () => {
  timing.seedMs = 200;
  const home = getHome();
  await vi.advanceTimersByTimeAsync(199);
  expect(timing.calls.some((call) => call.name === "enrich")).toBe(false);
  expect(timing.calls.find((call) => call.name === "briefs")?.at).toBe(80);
  expect(timing.calls.find((call) => call.name === "access")?.at).toBe(0);
  await vi.advanceTimersByTimeAsync(51);
  await home;
  expect(timing.calls.filter((call) => call.name === "enrich").map((call) => call.at)).toEqual([200, 200, 200, 200]);
});
