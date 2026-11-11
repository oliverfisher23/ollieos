import { expect, it, vi } from "vitest";
import type { ServiceKey } from "../src/services/connectors";

const reads = vi.hoisted(() => ({
  calls: [] as string[],
  releaseDropbox: undefined as (() => void) | undefined,
}));
vi.mock("../src/services/connectors", async (original) => {
  const real = await original<typeof import("../src/services/connectors")>();
  const good = Object.fromEntries(real.SERVICE_KEYS.map((key) => [key, { connector: key }]));
  return {
    ...real,
    getConnectorSettings: vi.fn(async () => { reads.calls.push("settings"); return { schedule: real.DEFAULT_SCHEDULE, readBy: {} }; }),
    lastTimerRunAt: vi.fn(async () => { reads.calls.push("timer"); return null; }),
    getDropboxSetup: vi.fn(() => {
      reads.calls.push("dropbox");
      return new Promise((resolve) => { reads.releaseDropbox = () => resolve({}); });
    }),
    recentRuns: vi.fn(async (key: ServiceKey, limit: number) => { reads.calls.push(`runs:${key}:${limit}`); return []; }),
    lastGoodRun: vi.fn(async (key: ServiceKey) => { reads.calls.push(`good:${key}`); return good[key]; }),
    readByNow: vi.fn(async (key: ServiceKey, _settings: unknown, fetched?: unknown) => {
      reads.calls.push(`reader:${key}`);
      if (key !== "granola") expect(fetched).toBe(good[key]);
      return "ollieos";
    }),
  };
});
vi.mock("@workspace/db", async (original) => {
  const real = await original<typeof import("@workspace/db")>();
  return {
    ...real,
    db: {
      select: () => {
        const builder: Record<string, unknown> = {};
        for (const key of ["from", "where", "orderBy", "limit"]) builder[key] = () => builder;
        builder.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
        return builder;
      },
    },
  };
});
const { connectorsView } = await import("../src/services/connectors/status");

it("starts every card without waiting for Dropbox progress and reuses successful reads", async () => {
  const result = connectorsView();
  try {
    await vi.waitFor(() => expect(reads.calls.filter((call) => call.startsWith("reader:"))).toHaveLength(6));
    expect(reads.calls.slice(0, 3)).toEqual(["settings", "timer", "dropbox"]);
    expect(reads.calls.filter((call) => call.startsWith("runs:"))).toHaveLength(6);
    expect(reads.calls.filter((call) => call.startsWith("good:"))).toHaveLength(6);
    expect(reads.calls.filter((call) => call.startsWith("runs:")).every((call) => call.endsWith(":6"))).toBe(true);
  } finally {
    reads.releaseDropbox!();
  }
  expect((await result).services).toHaveLength(6);
});
