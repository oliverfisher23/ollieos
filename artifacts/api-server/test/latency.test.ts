import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appSettingsTable, connectorRunsTable, db, pool } from "@workspace/db";
import { api, useServer } from "./harness";
import { drainScheduledWorkQueue, enqueueScheduledWork } from "../src/services/scheduledWorkQueue";
import { scheduledWork } from "../src/services/scheduledWork";
import { connectorsView } from "../src/services/connectors/status";
import { SERVICE_KEYS } from "../src/services/connectors";
import { task } from "./helpers";

vi.mock("../src/services/scheduledWork", () => ({ scheduledWork: vi.fn(async () => ({})) }));
vi.mock("../src/services/connectors/googleCalendar", async (original) => ({
  ...await original<typeof import("../src/services/connectors/googleCalendar")>(),
  readGoogleCalendar: vi.fn(async () => ({ account: "test@example.test", events: [], found: 0, skipped: 0 })),
}));

useServer();
beforeEach(() => { vi.mocked(scheduledWork).mockReset().mockResolvedValue({}); });
afterEach(async () => { vi.restoreAllMocks(); await drainScheduledWorkQueue(); });

const pending = () => db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "scheduled_work_pending"));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("manual check preparation queue", () => {
  it("returns the connector result while preparation is still pending", async () => {
    const blocked = gate();
    vi.mocked(scheduledWork).mockImplementation(async () => { await blocked.promise; return {}; });
    const response = await api("connectors/calendar/check", { method: "POST" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, found: 0 });
    expect(await pending()).toHaveLength(1);
    const drained = drainScheduledWorkQueue();
    try {
      await vi.waitFor(() => expect(scheduledWork).toHaveBeenCalledOnce());
      expect(await pending()).toHaveLength(1);
    } finally {
      blocked.release();
      await drained;
    }
    expect(await pending()).toHaveLength(0);
  });

  it("coalesces queued checks and retains one follow-up for checks during a pass", async () => {
    await Promise.all(Array.from({ length: 6 }, () => enqueueScheduledWork()));
    const blocked = gate();
    vi.mocked(scheduledWork).mockImplementationOnce(async () => { await blocked.promise; return {}; });
    const first = drainScheduledWorkQueue();
    try {
      await vi.waitFor(() => expect(scheduledWork).toHaveBeenCalledOnce());
      expect(drainScheduledWorkQueue()).toBe(first);
      await Promise.all(Array.from({ length: 6 }, () => enqueueScheduledWork()));
    } finally {
      blocked.release();
      await first;
    }
    expect(scheduledWork).toHaveBeenCalledTimes(2);
    expect(await pending()).toHaveLength(0);
  });

  it("keeps durable work on failure and retries it later", async () => {
    await enqueueScheduledWork();
    vi.mocked(scheduledWork).mockRejectedValueOnce(new Error("worker stopped"));
    await drainScheduledWorkQueue();
    expect(await pending()).toHaveLength(1);
    await drainScheduledWorkQueue();
    expect(scheduledWork).toHaveBeenCalledOnce();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    await drainScheduledWorkQueue();
    expect(scheduledWork).toHaveBeenCalledTimes(2);
    expect(await pending()).toHaveLength(0);
  });

  it.each([
    { briefs: { error: "Temporary model failure" }, digest: { built: true } },
    { briefs: { built: 1, unchanged: 0, failed: 1 } },
  ])("retains part-level failures and retries later without an immediate loop: %j", async (outcome) => {
    await enqueueScheduledWork();
    vi.mocked(scheduledWork).mockResolvedValueOnce(outcome);
    await drainScheduledWorkQueue();
    expect(scheduledWork).toHaveBeenCalledOnce();
    const [saved] = await pending();
    expect(saved.value).toMatchObject({ retryAt: expect.any(Number) });
    // Further checks cannot defeat the backoff, and a fresh worker reads it from the DB.
    await enqueueScheduledWork();
    await drainScheduledWorkQueue();
    expect(scheduledWork).toHaveBeenCalledOnce();
    expect(await pending()).toHaveLength(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    await drainScheduledWorkQueue();
    expect(scheduledWork).toHaveBeenCalledTimes(2);
    expect(await pending()).toHaveLength(0);
  });

  it("resumes persisted work and respects another server's worker lock", async () => {
    await db.insert(appSettingsTable).values({ key: "scheduled_work_pending", value: { token: "saved-before-restart" } });
    const other = await pool.connect();
    try {
      await other.query("select pg_advisory_lock(472091, 2)");
      await drainScheduledWorkQueue();
      expect(scheduledWork).not.toHaveBeenCalled();
      expect(await pending()).toHaveLength(1);
    } finally {
      await other.query("select pg_advisory_unlock(472091, 2)");
      other.release();
    }
    await drainScheduledWorkQueue();
    expect(scheduledWork).toHaveBeenCalledOnce();
    expect(await pending()).toHaveLength(0);
  });

  it("does not enqueue failed connector checks", async () => {
    const { readGoogleCalendar } = await import("../src/services/connectors/googleCalendar");
    vi.mocked(readGoogleCalendar).mockRejectedValueOnce(new Error("unavailable"));
    expect((await api("connectors/calendar/check", { method: "POST" })).body.ok).toBe(false);
    expect(await pending()).toHaveLength(0);
  });
});

it("keeps six ordered runs per card and Granola's historical takeover proof", async () => {
  const start = Date.now();
  await db.insert(connectorRunsTable).values(SERVICE_KEYS.flatMap((connector) =>
    Array.from({ length: 8 }, (_, n) => ({
      connector, trigger: "manual", ok: n !== 7,
      startedAt: new Date(start + n * 1000), finishedAt: new Date(start + n * 1000 + 1),
      counts: connector === "granola" && n === 0 ? { meetings: 1 } : {},
    })),
  ));
  const view = await connectorsView();
  expect(view.services.map((s) => s.key)).toEqual([...SERVICE_KEYS]);
  for (const service of view.services) {
    expect(service.runs).toHaveLength(6);
    expect(service.runs[0].ok).toBe(false);
    expect(service.readBy).toBe("ollieos");
    expect(service.lastGoodAt).toEqual(new Date(start + 6001));
  }
});

it("measures the warm Home critical path against the reported 306–426 ms baseline", async () => {
  await task("Home timing fixture");
  expect((await api("home")).status).toBe(200);
  const samples: number[] = [];
  for (let n = 0; n < 10; n++) {
    const start = performance.now();
    const response = await api("home");
    samples.push(performance.now() - start);
    expect(response.status).toBe(200);
    expect(response.body.doNext).toHaveLength(1);
  }
  samples.sort((a, b) => a - b);
  // Local isolated data, not a like-for-like production benchmark.
  process.stdout.write(`Home warm test DB: median ${samples[5].toFixed(1)} ms, range ${samples[0].toFixed(1)}–${samples[9].toFixed(1)} ms; production reference 306–426 ms.\n`);
});
