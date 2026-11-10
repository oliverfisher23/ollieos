import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { activityTable, captureLogTable, db, noiseRulesTable, peopleTable, pool, tasksTable } from "@workspace/db";
import { londonRange, todayLondon } from "@workspace/shared";
import { createSession } from "../src/lib/auth";
import { SOURCE_OF_TRUTH } from "../src/mcp/server";
import { decision, fact, link, note, person, project, resetDb, task } from "./helpers";

const OLLIE = "ollie-test@example.com";
const KEY = "test-ingest-key-" + randomBytes(8).toString("hex");
process.env.ALLOWED_EMAIL = OLLIE;
process.env.INBOX_API_KEY = KEY;
process.env.SESSION_SECRET ??= "test-session-secret";

let server: Server;
let base = "";
let sid = "";

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

async function signIn() {
  sid = await createSession({
    user: { id: "ollie", email: OLLIE, firstName: "Ollie", lastName: null, profileImageUrl: null } as never,
    access_token: "x",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

/* ---------- OAuth helpers ---------- */

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(name = "Claude", redirect = REDIRECT) {
  const res = await fetch(`${base}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

async function authorize(clientId: string, challenge: string, redirect = REDIRECT, scopes = "read write") {
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

async function consent(location: string, decision: "approve" | "deny") {
  const req = new URL(location, base).searchParams.get("req")!;
  const res = await fetch(`${base}/api/oauth/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sid}` },
    body: JSON.stringify({ req, decision }),
  });
  return res;
}

async function token(body: Record<string, string>) {
  return fetch(`${base}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
}

/** Runs the whole flow Claude runs, and returns the tokens. */
async function connect(name = "Claude", scopes = "read write") {
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

async function mcp(accessToken: string) {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return c;
}

type ToolOut = { isError?: boolean; text: string; json: Record<string, unknown> };
async function call(c: Client, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content.map((x) => x.text).join("\n");
  return { isError: r.isError, text, json: JSON.parse(text) };
}

async function ingest(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(`${base}/api/ingest/${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${init.key ?? KEY}` },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

function item(ref: string, extra: Record<string, unknown> = {}) {
  return { source: "email", source_ref: ref, title: `Reply about ${ref}`, from_name: "Jo", from_address: "jo@example.com", ...extra };
}

beforeEach(async () => {
  await resetDb();
  await signIn();
});

/* ---------- OAuth ---------- */

describe("OAuth for Claude", () => {
  it("answers an unauthenticated MCP call with 401 and the metadata pointer, and serves both metadata documents", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate")!;
    const meta = /resource_metadata="([^"]+)"/.exec(header)![1];
    const pr = (await (await fetch(meta)).json()) as { resource: string; authorization_servers: string[] };
    expect(pr.resource).toBe(`${new URL(meta).origin}/mcp`);
    const as = (await (await fetch(`${pr.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(as.registration_endpoint).toMatch(/\/api\/oauth\/register$/);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
  });

  it("runs register, consent, token and refresh with rotation", async () => {
    const t = await connect();
    const c = await mcp(t.access_token);
    expect((await c.listTools()).tools.length).toBeGreaterThan(0);
    await c.close();

    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    expect(r1.status).toBe(200);
    const next = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(t.refresh_token);
    // The old refresh token is spent.
    const r2 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("read-only tokens cannot list or dispatch mutations, including after refresh", async () => {
    const t = await connect("Read-only connector", "read");
    const c = await mcp(t.access_token);
    expect((await c.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["get_context", "list_tasks", "search"]);
    expect((await c.readResource({ uri: "ollieos://today" })).contents).toHaveLength(1);
    for (const [name, args] of [
      ["create_task", { title: "Forbidden task" }],
      ["update_task", { ref: "task:1", title: "Forbidden update" }],
      ["upsert_calendar", { events: [] }],
    ] as const) {
      expect((await c.callTool({ name, arguments: args })).isError).toBe(true);
    }
    await c.close();
    const response = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    const refreshed = (await response.json()) as { access_token: string; scope: string };
    expect(refreshed.scope).toBe("read");
    const next = await mcp(refreshed.access_token);
    expect((await next.callTool({ name: "upsert_calendar", arguments: { events: [] } })).isError).toBe(true);
    await next.close();
    expect(await db.select().from(tasksTable)).toHaveLength(0);
  });

  it("refuses a wrong PKCE verifier, a reused code and an unregistered redirect, and ignores the loopback port", async () => {
    const { client_id } = await register();
    const { challenge, verifier } = pkce();
    const auth = await authorize(client_id, challenge);
    const { redirectTo } = (await (await consent(auth.headers.get("location")!, "approve")).json()) as { redirectTo: string };
    const code = new URL(redirectTo).searchParams.get("code")!;
    expect(new URL(redirectTo).searchParams.get("state")).toBe("st-1");
    const bad = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: pkce().verifier });
    expect(bad.status).toBe(400);
    // The failed attempt used the code up.
    const again = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: verifier });
    expect(again.status).toBe(400);

    const evil = await authorize(client_id, challenge, "https://evil.example.com/cb");
    expect(evil.status).toBe(400);

    const local = await register("Claude Code", "http://localhost/callback");
    const ok = await authorize(local.client_id, challenge, "http://localhost:53122/callback");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toMatch(/^\/oauth\/consent\?req=/);
  });

  it("needs Ollie for consent, and a denial sends access_denied back", async () => {
    const { client_id } = await register();
    const auth = await authorize(client_id, pkce().challenge);
    const req = new URL(auth.headers.get("location")!, base).searchParams.get("req")!;
    const anon = await fetch(`${base}/api/oauth/consent?req=${encodeURIComponent(req)}`);
    expect(anon.status).toBe(401);
    const info = await fetch(`${base}/api/oauth/consent?req=${encodeURIComponent(req)}`, { headers: { authorization: `Bearer ${sid}` } });
    expect(await info.json()).toMatchObject({ clientName: "Claude", redirectHost: "claude.ai" });
    const denied = (await (await consent(auth.headers.get("location")!, "deny")).json()) as { redirectTo: string };
    expect(new URL(denied.redirectTo).searchParams.get("error")).toBe("access_denied");
    // A tampered request is refused.
    const tampered = await fetch(`${base}/api/oauth/consent?req=${encodeURIComponent(req.slice(0, -2) + "xx")}`, { headers: { authorization: `Bearer ${sid}` } });
    expect(tampered.status).toBe(400);
  });

  it("Revoke cuts a connected tool off at once; Reconnect needs consent again", async () => {
    const t = await connect();
    const clients = (await (await fetch(`${base}/api/ai-clients`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { id: number; name: string }[];
    const claude = clients.find((c) => c.name === "Claude")!;
    const rv = await fetch(`${base}/api/ai-clients/${claude.id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${sid}` } });
    expect(rv.status).toBe(200);
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${t.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    const r = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id });
    expect(((await r.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

/* ---------- Criterion 7 ---------- */

describe("no delete tool (criterion 7)", () => {
  it("lists every PRD tool, none of which deletes or removes, each opening with the source-of-truth sentence", async () => {
    const c = await mcp((await connect()).access_token);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_fact",
        "add_note",
        "create_task",
        "get_context",
        "list_tasks",
        "log_activity",
        "log_decision",
        "log_promise",
        "request_access",
        "search",
        "update_task",
        "upsert_calendar",
        "upsert_person",
        "upsert_project",
      ].sort(),
    );
    for (const t of tools) {
      expect(`${t.name} ${t.description}`.toLowerCase()).not.toMatch(/delete|remove/);
      expect(t.description!.startsWith(SOURCE_OF_TRUTH)).toBe(true);
    }
    const templates = await c.listResourceTemplates();
    expect(templates.resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual(["ollieos://person/{slug}", "ollieos://project/{slug}"]);
    expect((await c.listResources()).resources.map((r) => r.uri)).toEqual(["ollieos://today"]);
    await c.close();
  });
});

/* ---------- Criterion 2 ---------- */

describe("a confidential project never reaches an AI tool (criterion 2)", () => {
  it("hides it and everything only under it from every MCP read, resource and ingest GET", async () => {
    const sale = await project("Sale process", { confidential: true, summary: "Selling Fisherco to Hendersons" });
    const shed = await project("Garden shed", { summary: "A shed for Fisherco tools" });
    const buyer = await person("Harriet Henderson", { role: "Buyer" });
    const visibleTask = await task("Order Fisherco shed timber", { projectId: shed.id });
    const t1 = await task("Send Fisherco valuation to Hendersons", { projectId: sale.id, personId: buyer.id });
    const linked = await task("Fisherco lawyer call");
    await link("task", linked.id, "project", sale.id);
    await link("person", buyer.id, "project", sale.id);
    await link("person", buyer.id, "project", shed.id);
    const d1 = await decision(sale.id, "Accept the Fisherco offer");
    const n1 = await note("project", sale.id, "Fisherco offer notes");
    const f1 = await fact("project", sale.id, "Fisherco asking price is 2 million");
    await db.insert(activityTable).values({ entityType: "project", entityId: sale.id, kind: "email", summary: "Fisherco heads of terms", occurredAt: new Date(), createdBy: "test" });
    // One confidential task done this week, for the done feed.
    const doneHidden = await task("Fisherco data room closed", { projectId: sale.id });
    await db.update(tasksTable).set({ status: "done", completedAt: new Date() }).where(eq(tasksTable.id, doneHidden.id));
    const now = new Date();
    const today = londonRange(todayLondon(now), 1);
    // A meeting about the sale: hidden from AI because its project is hidden.
    const { calendarEventsTable } = await import("@workspace/db");
    await db.insert(calendarEventsTable).values({
      sourceRef: "cal-1",
      title: "Fisherco board call",
      startsAt: new Date(today.start.getTime() + 10 * 3600_000),
      endsAt: new Date(today.start.getTime() + 11 * 3600_000),
      projectId: sale.id,
    });

    const hiddenRefs = [`project:${sale.id}`, `task:${t1.id}`, `task:${linked.id}`, `decision:${d1.id}`, `note:${n1.id}`, `fact:${f1.id}`, `task:${doneHidden.id}`];
    const hiddenWords = ["Sale process", "sale-process", "valuation", "lawyer", "offer", "asking price", "heads of terms", "data room", "board call"];
    const leaks = (text: string) => [...hiddenRefs.filter((r) => new RegExp(`"${r}"`).test(text)), ...hiddenWords.filter((w) => text.toLowerCase().includes(w.toLowerCase()))];

    const c = await mcp((await connect()).access_token);
    const outputs: string[] = [];
    for (const q of ["Fisherco", "sale", "Hendersons valuation", "offer"]) outputs.push((await call(c, "search", { query: q, limit: 50 })).text);
    for (const pick of [{ name: "Sale process" }, { slug: "sale-process" }, { ref: `project:${sale.id}` }, { name: "sale" }]) {
      const r = await call(c, "get_context", pick);
      expect(r.isError).toBe(true);
      expect(r.json.error).toBe("not_found");
      outputs.push(r.text);
    }
    outputs.push((await call(c, "get_context", { name: "Garden shed" })).text);
    outputs.push((await call(c, "get_context", { name: "Harriet Henderson" })).text);
    outputs.push((await call(c, "list_tasks", {})).text);
    outputs.push((await call(c, "list_tasks", { status: ["inbox", "now", "backlog", "waiting", "done", "noise"], limit: 200 })).text);
    const byProject = await call(c, "list_tasks", { project: { name: "Sale process" } });
    expect(byProject.json.error).toBe("not_found");
    outputs.push((await call(c, "list_tasks", { person: { name: "Harriet Henderson" } })).text);
    const today2 = await c.readResource({ uri: "ollieos://today" });
    outputs.push(JSON.stringify(today2));
    outputs.push(JSON.stringify(await c.readResource({ uri: "ollieos://project/garden-shed" })));
    outputs.push(JSON.stringify(await c.readResource({ uri: "ollieos://person/harriet-henderson" })));
    await expect(c.readResource({ uri: "ollieos://project/sale-process" })).rejects.toThrow();

    // Writes cannot reach it either, and say not_found rather than forbidden.
    expect((await call(c, "update_task", { ref: `task:${t1.id}`, status: "done" })).json.error).toBe("not_found");
    expect((await call(c, "add_fact", { entity: { name: "Sale process" }, text: "x" })).json.error).toBe("not_found");
    expect((await call(c, "log_decision", { project: { slug: "sale-process" }, text: "x" })).json.error).toBe("not_found");
    expect((await call(c, "add_note", { entity: { ref: `project:${sale.id}` }, body: "x" })).json.error).toBe("not_found");
    expect((await call(c, "create_task", { title: "x", project: { name: "Sale process" } })).json.error).toBe("not_found");
    const act = await call(c, "log_activity", { kind: "email", summary: "Chat", occurred_at: now.toISOString(), projects: ["Sale process"] });
    expect(act.json.unmatched).toEqual(["Sale process"]);
    await c.close();

    // Ingest GETs, read as the Capture sweep.
    outputs.push(JSON.stringify((await ingest("open-tasks")).body));
    outputs.push(JSON.stringify((await ingest(`done?since=${encodeURIComponent(new Date(now.getTime() - 86400_000).toISOString())}`)).body));
    outputs.push(JSON.stringify((await ingest("noise-rules")).body));
    outputs.push(JSON.stringify((await ingest("cursor")).body));

    for (const text of outputs) expect(leaks(text), text.slice(0, 300)).toEqual([]);
    // The visible project is really there, so the checks above are not passing on empty output.
    expect(outputs.join("\n")).toContain(`task:${visibleTask.id}`);
    expect(outputs.join("\n")).toContain("Garden shed");
  });
});

/* ---------- Criteria 5 and 12, noise and the rest of ingest ---------- */

describe("ingest", () => {
  it("refuses a missing or wrong key", async () => {
    expect((await ingest("cursor", { key: "nope" })).status).toBe(401);
  });

  it("creates one task from the same item sent twice, even at once (criterion 5)", async () => {
    const first = await ingest("tasks", { body: [item("msg-1")] });
    expect(first.body.results[0].outcome).toBe("created");
    const second = await ingest("tasks", { body: { items: [item("msg-1")] } });
    expect(second.body.results[0].outcome).toBe("duplicate");
    await Promise.all([ingest("tasks", { body: [item("msg-2")] }), ingest("tasks", { body: [item("msg-2")] }), ingest("tasks", { body: [item("msg-2")] })]);
    const rows = await db.select().from(tasksTable);
    expect(rows.filter((r) => r.sourceRef === "msg-1")).toHaveLength(1);
    expect(rows.filter((r) => r.sourceRef === "msg-2")).toHaveLength(1);
    // The MCP create_task path shares the same check.
    const c = await mcp((await connect()).access_token);
    const dup = await call(c, "create_task", { title: "Reply", source: "email", source_ref: "msg-1" });
    expect(dup.json.duplicate).toBe(true);
    await c.close();
    expect((await db.select().from(tasksTable)).filter((r) => r.sourceRef === "msg-1")).toHaveLength(1);
  });

  it("hides an item flagged confidential from the moment it lands (criterion 12)", async () => {
    const r = await ingest("tasks", { body: [item("secret-1", { title: "Fisherco buyer shortlist", confidential: true })] });
    expect(r.body.results[0]).toEqual({ source_ref: "secret-1", outcome: "created" });
    const [row] = await db.select().from(tasksTable).where(eq(tasksTable.sourceRef, "secret-1"));
    expect(row.confidential).toBe(true);
    expect(row.status).toBe("inbox");
    expect(JSON.stringify((await ingest("open-tasks")).body)).not.toContain("shortlist");
    const c = await mcp((await connect()).access_token);
    expect((await call(c, "search", { query: "shortlist" })).json.results).toEqual([]);
    expect((await call(c, "list_tasks", {})).text).not.toContain("shortlist");
    expect((await call(c, "update_task", { ref: `task:${row.id}`, title: "x" })).json.error).toBe("not_found");
    // A duplicate of it does not confirm the hidden task's id.
    const again = await ingest("tasks", { body: [item("secret-1", { confidential: true })] });
    expect(again.body.results[0]).toEqual({ source_ref: "secret-1", outcome: "duplicate" });
    // Created through MCP as confidential: saved, and the reply says only that.
    const viaMcp = await call(c, "create_task", { title: "Fisherco escrow", confidential: true });
    expect(viaMcp.json).toMatchObject({ saved: true, hidden: true });
    expect(viaMcp.text).not.toContain("escrow");
    await c.close();
  });

  it("applies noise rules on ingest, but never to meeting actions", async () => {
    const [rule] = await db.insert(noiseRulesTable).values({ matchType: "from_domain_equals", matchValue: "example.com" }).returning();
    const r = await ingest("tasks", {
      body: [item("n-1"), item("n-2", { source: "meeting", source_ref: "n-2" }), item("n-3", { from_address: "boss@other.org" }), { source: "email", title: "no ref" }],
    });
    expect(r.body.results.map((x: { outcome: string }) => x.outcome)).toEqual(["noise", "created", "created", "error"]);
    expect(r.body.results[0].noise_rule_id).toBe(rule.id);
    const [after] = await db.select().from(noiseRulesTable).where(eq(noiseRulesTable.id, rule.id));
    expect(after.hitCount).toBe(1);
    const logged = await db.select().from(captureLogTable);
    expect(logged.map((l) => l.outcome).sort()).toEqual(["created", "created", "noise"]);
  });

  it("resolves hints to visible people and projects only", async () => {
    await project("Sale process", { confidential: true });
    const shed = await project("Garden shed");
    const jo = await person("Jo Bloggs");
    const r = await ingest("tasks", { body: [item("h-1", { project_hint: "Sale process", person_hint: "Jo Bloggs" }), item("h-2", { project_hint: "garden-shed" })] });
    const rows = await db.select().from(tasksTable);
    const h1 = rows.find((x) => x.sourceRef === "h-1")!;
    expect(h1.projectId).toBeNull();
    expect(h1.personId).toBe(jo.id);
    expect(rows.find((x) => x.sourceRef === "h-2")!.projectId).toBe(shed.id);
    expect(r.status).toBe(200);
  });

  it("records sweep runs and moves the cursor only on a clean finish", async () => {
    expect((await ingest("cursor")).body.last_finished_at).toBeNull();
    const start = await ingest("sweep-run", { body: {} });
    expect(start.status).toBe(201);
    const finishedAt = new Date().toISOString();
    await ingest("sweep-run", { body: { id: start.body.id, finished_at: finishedAt, items_created: 3, errors: [] } });
    expect((await ingest("cursor")).body.last_finished_at).toBe(finishedAt);
    const bad = await ingest("sweep-run", { body: { finished_at: new Date(Date.now() + 1000).toISOString(), errors: ["Gmail timed out"] } });
    expect(bad.status).toBe(201);
    expect((await ingest("cursor")).body.last_finished_at).toBe(finishedAt);
    // Finishing twice is refused.
    expect((await ingest("sweep-run", { body: { id: start.body.id } })).status).toBe(409);
    const status = (await (await fetch(`${base}/api/sweep`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { runs: unknown[]; keyConfigured: boolean };
    expect(status.runs).toHaveLength(2);
    expect(status.keyConfigured).toBe(true);
  });

  it("replaces the calendar window and links Brief me on Home", async () => {
    const shed = await project("Garden shed");
    const jo = await person("Jo Bloggs");
    const day = londonRange(todayLondon(), 1).start.getTime();
    const ev = (ref: string, h: number, extra: Record<string, unknown> = {}) => ({
      source_ref: ref,
      title: `Meeting ${ref}`,
      starts_at: new Date(day + h * 3600_000).toISOString(),
      ends_at: new Date(day + (h + 1) * 3600_000).toISOString(),
      ...extra,
    });
    await ingest("calendar", { body: { events: [ev("a", 9), ev("b", 10)] } });
    const r = await ingest("calendar", { body: { events: [ev("c", 11, { project: "Garden shed" }), ev("d", 12, { people: ["Jo Bloggs"] })] } });
    expect(r.body).toMatchObject({ replaced: 2, unmatched: [] });
    const home = (await (await fetch(`${base}/api/home`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { today: { title: string; brief: unknown }[] };
    expect(home.today.map((e) => e.title)).toEqual(["Meeting c", "Meeting d"]);
    expect(home.today[0].brief).toEqual({ type: "project", slug: shed.slug, name: "Garden shed" });
    expect(home.today[1].brief).toEqual({ type: "person", slug: jo.slug, name: "Jo Bloggs" });
  });

  it("rejects unresolved calendar associations without replacing the existing window", async () => {
    const hidden = await project("Private acquisition", { confidential: true });
    await person("Private attendee", { aiAccess: false });
    const visible = await person("Visible attendee");
    const day = londonRange(todayLondon(), 1).start.getTime();
    const event = {
      source_ref: "private-event",
      title: "Acquisition meeting",
      starts_at: new Date(day + 10 * 3600_000).toISOString(),
      ends_at: new Date(day + 11 * 3600_000).toISOString(),
    };
    const { calendarEventsTable } = await import("@workspace/db");
    await db.insert(calendarEventsTable).values({
      sourceRef: "existing",
      title: "Existing meeting",
      startsAt: new Date(event.starts_at),
      endsAt: new Date(event.ends_at),
    });
    const c = await mcp((await connect()).access_token);
    for (const association of [
      { project: hidden.name },
      { project: `project:${hidden.id}` },
      { project: "Unknown project" },
      { people: [visible.name, "Private attendee"] },
      { people: ["Unknown person"] },
    ]) {
      const events = [{ ...event, ...association }];
      expect((await ingest("calendar", { body: { events } })).status).toBe(400);
      expect((await call(c, "upsert_calendar", { events })).isError).toBe(true);
      expect((await db.select().from(calendarEventsTable)).map((r) => r.sourceRef)).toEqual(["existing"]);
    }
    await c.close();
  });

  it("omits unstructured and mixed-attendee calendar disclosures of hidden entities", async () => {
    const hiddenProject = await project("Secret merger", { aiAccess: false });
    const hiddenPerson = await person("Hidden attendee", { confidential: true });
    await db.update(peopleTable).set({ email: "hidden@example.test" }).where(eq(peopleTable.id, hiddenPerson.id));
    const visible = await person("Public attendee");
    const { calendarEventsTable } = await import("@workspace/db");
    const day = londonRange(todayLondon(), 1).start.getTime();
    const baseEvent = { startsAt: new Date(day + 10 * 3600_000), endsAt: new Date(day + 11 * 3600_000) };
    await db.insert(calendarEventsTable).values([
      { ...baseEvent, sourceRef: "title", title: `Discuss ${hiddenProject.name}` },
      { ...baseEvent, sourceRef: "attendees", title: "Meeting", attendees: ["HIDDEN@example.test"] },
      { ...baseEvent, sourceRef: "location", title: "Meeting", location: hiddenProject.slug },
      { ...baseEvent, sourceRef: "mixed", title: "Meeting", personIds: [visible.id, hiddenPerson.id] },
      { ...baseEvent, sourceRef: "safe", title: "Public meeting", personIds: [visible.id] },
    ]);
    const c = await mcp((await connect()).access_token);
    const result = await c.readResource({ uri: "ollieos://today" });
    const today = JSON.parse((result.contents[0] as { text: string }).text);
    expect(today.calendar.map((r: { title: string }) => r.title)).toEqual(["Public meeting"]);
    await c.close();
  });

  it("logs activity once per source_ref and links it to people and projects", async () => {
    const jo = await person("Jo Bloggs");
    const shed = await project("Garden shed");
    const entry = { kind: "email", summary: "Agreed the shed quote", occurred_at: new Date().toISOString(), source_ref: "act-1", people: ["Jo Bloggs"], project_hint: "Garden shed" };
    const r1 = await ingest("activity", { body: [entry] });
    const r2 = await ingest("activity", { body: { entries: [entry] } });
    expect(r1.body.results[0].outcome).toBe("created");
    expect(r2.body.results[0].outcome).toBe("duplicate");
    const rows = await db.select().from(activityTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "project", entityId: shed.id, createdBy: "ingest" });
    const c = await mcp((await connect()).access_token);
    const ctx = await call(c, "get_context", { name: "Jo Bloggs" });
    expect((ctx.json.recent_activity as { summary: string }[]).map((a) => a.summary)).toEqual(["Agreed the shed quote"]);
    await c.close();
    const log = (await (await fetch(`${base}/api/ai-activity`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { actor: string; kind: string }[];
    expect(log.some((l) => l.actor === "Capture sweep" && l.kind === "write")).toBe(true);
    expect(log.some((l) => l.actor === "ingest")).toBe(false);
    void jo;
  });

  it("refuses the key after Revoke, until Reconnect", async () => {
    await ingest("cursor");
    const clients = (await (await fetch(`${base}/api/ai-clients`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { id: number; name: string }[];
    const sweep = clients.find((c) => c.name === "Capture sweep")!;
    await fetch(`${base}/api/ai-clients/${sweep.id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${sid}` } });
    expect((await ingest("cursor")).status).toBe(403);
    await fetch(`${base}/api/ai-clients/${sweep.id}/reconnect`, { method: "POST", headers: { authorization: `Bearer ${sid}` } });
    expect((await ingest("cursor")).status).toBe(200);
  });
});

/* ---------- MCP writes ---------- */

describe("MCP writes", () => {
  it("creates, updates and links through the tools, audited as the client", async () => {
    const c = await mcp((await connect()).access_token);
    const proj = await call(c, "upsert_project", { name: "Garden shed", area: "Home" });
    expect(proj.json.created).toBe(true);
    expect((await call(c, "upsert_project", { name: "garden shed", summary: "Timber shed" })).json.created).toBe(false);
    const jo = await call(c, "upsert_person", { name: "Jo Bloggs", email: "jo@example.com" });
    expect((await call(c, "upsert_person", { name: "Joanna", email: "JO@example.com", role: "Builder" })).json).toMatchObject({ created: false, person: { name: "Jo Bloggs" } });
    const created = await call(c, "create_task", { title: "Order timber", project: { name: "Garden shed" }, person: { name: "Bloggs" }, status: "now" });
    const ref = (created.json.task as { ref: string }).ref;
    expect(created.json.task).toMatchObject({ status: "now", project: { name: "Garden shed" }, person: { name: "Jo Bloggs" } });
    const updated = await call(c, "update_task", { ref, status: "waiting", waiting_on: { name: "Jo Bloggs" }, notes_append: "Quote due Friday" });
    expect(updated.json.task).toMatchObject({ status: "waiting", waiting_on: { name: "Jo Bloggs" }, notes: "Quote due Friday" });
    const f1 = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 2k" });
    const f2 = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 3k", supersedes: (f1.json.fact as { ref: string }).ref });
    expect(f2.json.superseded).toBe((f1.json.fact as { ref: string }).ref);
    const ctx = await call(c, "get_context", { slug: "garden-shed" });
    expect((ctx.json.facts as { text: string }[]).map((f) => f.text)).toEqual(["Budget is 3k"]);
    expect((ctx.json.waiting_on_them as unknown[]).length).toBe(1);
    const promise = await call(c, "log_promise", { title: "Send Jo the drawings", to_person: "Jo Bloggs", source: "meeting" });
    expect(promise.json.task).toMatchObject({ kind: "promise", person: { name: "Jo Bloggs" } });
    expect((await call(c, "request_access", { item: "Anything", reason: "Context" })).json).toEqual({ status: "pending", message: "Sent to Ollie for approval." });
    await c.close();

    const log = (await (await fetch(`${base}/api/ai-activity`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { actor: string; kind: string }[];
    expect(log.some((l) => l.actor === "Claude" && l.kind === "write")).toBe(true);
    expect(log.some((l) => l.actor === "Claude" && l.kind === "read")).toBe(true);
    void jo;
  });
});
