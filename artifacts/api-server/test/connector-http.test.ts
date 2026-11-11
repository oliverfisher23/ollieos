/**
 * A dropped connection to a service is retried before a check fails, and a check cut off by a
 * restart is closed rather than left looking as if it is still running.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { connectorRunsTable, db } from "@workspace/db";
import { useServer } from "./harness";

let failures = 0;
let calls = 0;

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {
    async proxy() {
      calls++;
      if (calls <= failures) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  },
}));

const { proxyJson, proxyWriteJson } = await import("../src/services/connectors/http");
const { closeUnfinishedRuns, STOPPED_BY_RESTART } = await import("../src/services/connectors");

useServer();

describe("reaching a service", () => {
  it("tries a read twice more when the connection drops, then gives up", async () => {
    calls = 0;
    failures = 2;
    expect(await proxyJson("slack", "Slack", "/api/auth.test")).toEqual({ ok: true });
    expect(calls).toBe(3);

    calls = 0;
    failures = 3;
    await expect(proxyJson("slack", "Slack", "/api/auth.test")).rejects.toThrow("Could not reach Slack: fetch failed");
    expect(calls).toBe(3);
  });

  it("never repeats a write", async () => {
    calls = 0;
    failures = 1;
    await expect(proxyWriteJson("google-mail", "Gmail", "POST", "/gmail/v1/users/me/drafts", {})).rejects.toThrow("Could not reach Gmail");
    expect(calls).toBe(1);
  });
});

describe("checks cut off by a restart", () => {
  it("are closed with a message saying so; finished checks are left alone", async () => {
    const [open] = await db.insert(connectorRunsTable).values({ connector: "slack", trigger: "manual", startedAt: new Date() }).returning();
    const [done] = await db.insert(connectorRunsTable).values({ connector: "gmail", trigger: "timer", startedAt: new Date(), finishedAt: new Date(), ok: true, found: 2 }).returning();
    expect(await closeUnfinishedRuns()).toBe(1);
    const [o] = await db.select().from(connectorRunsTable).where(eq(connectorRunsTable.id, open.id));
    expect(o).toMatchObject({ ok: false, error: STOPPED_BY_RESTART });
    expect(o.finishedAt).not.toBeNull();
    const [d] = await db.select().from(connectorRunsTable).where(eq(connectorRunsTable.id, done.id));
    expect(d).toMatchObject({ ok: true, error: null });
  });
});
