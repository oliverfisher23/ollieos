/** Signing in stays put: an expired Replit token or a failed refresh must not sign Ollie out. */
import { expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, sessionsTable } from "@workspace/db";
import { createSession } from "../src/lib/auth";
import { base, OLLIE, useServer } from "./harness";

let refreshCalls = 0;
vi.mock("openid-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openid-client")>()),
  discovery: async () => ({}) as never,
  refreshTokenGrant: async () => {
    refreshCalls++;
    await new Promise((r) => setTimeout(r, 50));
    // The refresh token was already used: Replit refuses it.
    throw new Error("invalid_grant");
  },
}));

useServer();

const user = { id: "ollie", email: OLLIE, firstName: "Ollie", lastName: null, profileImageUrl: null } as never;
const get = (sid: string, path = "home") => fetch(`${base}/api/${path}`, { headers: { authorization: `Bearer ${sid}` } });

it("keeps Ollie signed in when his token has expired and the refresh fails, refreshing once for many requests", async () => {
  const sid = await createSession({ user, access_token: "x", refresh_token: "r1", expires_at: Math.floor(Date.now() / 1000) - 60 });
  refreshCalls = 0;
  const res = await Promise.all([get(sid), get(sid, "tasks?tab=open"), get(sid, "people"), get(sid, "organisations"), get(sid, "auth/user")]);
  expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  expect(refreshCalls).toBe(1);
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
  expect(row).toBeTruthy();
  // It does not try again on every request after a failure.
  await get(sid);
  expect(refreshCalls).toBe(1);
});

it("still signs out a session that is gone or past its date", async () => {
  const sid = await createSession({ user, access_token: "x", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  await db.update(sessionsTable).set({ expire: new Date(Date.now() - 1000) }).where(eq(sessionsTable.sid, sid));
  expect((await get(sid)).status).toBe(401);
  expect((await get("no-such-session")).status).toBe(401);
});

it("keeps a session going while it is in use", async () => {
  const sid = await createSession({ user, access_token: "x", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const soon = new Date(Date.now() + 2 * 24 * 3600_000);
  await db.update(sessionsTable).set({ expire: soon }).where(eq(sessionsTable.sid, sid));
  expect((await get(sid)).status).toBe(200);
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
  expect(row.expire.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
});
