/**
 * Shared test harness: boots the app on a random port, signs Ollie in, and wraps the OAuth flow,
 * MCP calls, ingest calls and app API calls. Call useServer() once at the top of a test file.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pool } from "@workspace/db";
import { createSession } from "../src/lib/auth";
import { resetDb } from "./helpers";

export const OLLIE = "ollie-test@example.com";
export const KEY = "test-ingest-key-" + randomBytes(8).toString("hex");
process.env.ALLOWED_EMAIL = OLLIE;
process.env.INBOX_API_KEY = KEY;
process.env.SESSION_SECRET ??= "test-session-secret";

let server: Server;
export let base = "";
export let sid = "";

export function useServer() {
beforeAll(async () => {
  const { default: app } = await import("../src/app");
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  await signIn();
});
}

export async function signIn() {
  sid = await createSession({
    user: { id: "ollie", email: OLLIE, firstName: "Ollie", lastName: null, profileImageUrl: null } as never,
    access_token: "x",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

/* ---------- OAuth helpers ---------- */

export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function register(name = "Claude", redirect = REDIRECT) {
  const res = await fetch(`${base}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

export async function authorize(clientId: string, challenge: string, redirect = REDIRECT, scopes = "read write") {
  const u = new URL(`${base}/api/oauth/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-1",
    scope: scopes,
    resource: `${base}/mcp`,
  }).toString();
  const res = await fetch(u, { redirect: "manual" });
  return res;
}

export async function consent(location: string, decision: "approve" | "deny") {
  const req = new URL(location, base).searchParams.get("req")!;
  const res = await fetch(`${base}/api/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sid}` },
    body: JSON.stringify({ req, decision }),
  });
  return res;
}

export async function token(body: Record<string, string>) {
  return fetch(`${base}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

/** Runs the whole flow Claude runs, and returns the tokens. */
export async function connect(name = "Claude", scopes = "read write") {
  const { client_id } = await register(name);
  const { verifier, challenge } = pkce();
  const auth = await authorize(client_id, challenge, REDIRECT, scopes);
  expect(auth.status).toBe(302);
  const approved = await consent(auth.headers.get("location")!, "approve");
  const { redirectTo } = (await approved.json()) as { redirectTo: string };
  const code = new URL(redirectTo).searchParams.get("code")!;
  const res = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: verifier });
  expect(res.status).toBe(200);
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  return { client_id, ...tokens };
}

export async function mcp(accessToken: string) {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return c;
}

export type ToolOut = { isError?: boolean; text: string; json: Record<string, unknown> };
export async function call(c: Client, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content.map((x) => x.text).join("\n");
  return { isError: r.isError, text, json: JSON.parse(text) };
}

export async function ingest(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(`${base}/api/ingest/${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${init.key ?? KEY}` },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}


/** Calls the app API as Ollie. */
export async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}/api/${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${sid}` },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const raw = await res.text();
  return { status: res.status, body: (raw ? JSON.parse(raw) : null) as Record<string, any> };
}
