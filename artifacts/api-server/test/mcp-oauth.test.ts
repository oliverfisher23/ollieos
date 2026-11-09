import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auditEventsTable, db, pool, tasksTable } from "@workspace/db";
import { createSession } from "../src/lib/auth";
import { decision, fact, link, note, person, project, resetDb, task } from "./helpers";

process.env.ALLOWED_EMAIL = "ollie@example.test";
process.env.SESSION_SECRET ??= "test-secret";

const { default: app } = await import("../src/app");
const { DESCRIPTION_LEAD } = await import("../src/mcp/server");

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

async function ollieSession(): Promise<string> {
  return createSession({
    user: { id: "ollie", email: "ollie@example.test", firstName: "Ollie", lastName: "Fisher", profileImageUrl: null },
    access_token: "x",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });
}

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Runs the whole connector flow the way Claude does: discovery, DCR, authorise, consent, token. */
async function connect(name = "Claude") {
  const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(unauth.status).toBe(401);
  const wwwAuth = unauth.headers.get("www-authenticate") ?? "";
  const prmUrl = /resource_metadata="([^"]+)"/.exec(wwwAuth)?.[1];
  expect(prmUrl).toBe(`${base}/.well-known/oauth-protected-resource/mcp`);

  const prm = await (await fetch(prmUrl!)).json();
  expect(prm.resource).toBe(`${base}/mcp`);
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
  expect(as.client_id_metadata_document_supported).toBeUndefined();

  const reg = await fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = await reg.json();

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st8",
    scope: "read write offline_access",
    resource: prm.resource,
  }))
    authUrl.searchParams.set(k, v);
  const authRes = await fetch(authUrl, { redirect: "manual" });
  expect(authRes.status).toBe(302);
  const consentUrl = new URL(authRes.headers.get("location")!);
  expect(consentUrl.pathname).toBe("/oauth/consent");
  const request = consentUrl.searchParams.get("request")!;

  // The consent screen is Ollie-only.
  const anon = await fetch(`${base}/api/oauth/consent?request=${encodeURIComponent(request)}`);
  expect(anon.status).toBe(401);
  const sid = await ollieSession();
  const info = await (await fetch(`${base}/api/oauth/consent?request=${encodeURIComponent(request)}`, { headers: { authorization: `Bearer ${sid}` } })).json();
  expect(info).toMatchObject({ clientName: name, redirectHost: "claude.ai", loopbackOnly: false });

  const approved = await (
    await fetch(`${base}/api/oauth/consent`, {
      method: "POST",
      headers: { authorization: `Bearer ${sid}`, "content-type": "application/json" },
      body: JSON.stringify({ request, approve: true }),
    })
  ).json();
  const back = new URL(approved.redirectTo);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("st8");
  const code = back.searchParams.get("code")!;

  const tokenRes = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }),
  });
  expect(tokenRes.status).toBe(200);
  const tokens = await tokenRes.json();
  expect(tokens.token_type).toBe("Bearer");

  // A code works once.
  const again = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }),
  });
  expect((await again.json()).error).toBe("invalid_grant");

  return { client_id, tokens, tokenEndpoint: as.token_endpoint as string };
}

async function mcpClient(accessToken: string) {
  const c = new Client({ name: "test", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } }));
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const r = (await c.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
}

describe("OAuth and the MCP server", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("connects like Claude, rotates refresh tokens, and lists tools with no way to delete anything (criterion 7)", async () => {
    const { client_id, tokens, tokenEndpoint } = await connect();

    const refreshed = await (
      await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }),
      })
    ).json();
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    const reused = await (
      await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id }),
      })
    ).json();
    expect(reused.error).toBe("invalid_grant");

    const c = await mcpClient(refreshed.access_token);
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
      expect(t.description?.startsWith(DESCRIPTION_LEAD)).toBe(true);
      const text = `${t.name} ${t.description} ${JSON.stringify(t.inputSchema)}`.toLowerCase();
      expect(text, t.name).not.toMatch(/delete|remove/);
    }
    const { resources } = await c.listResources();
    expect(resources.map((r) => r.uri)).toContain("ollieos://today");
    const { resourceTemplates } = await c.listResourceTemplates();
    expect(resourceTemplates.map((r) => r.uriTemplate).sort()).toEqual(["ollieos://person/{slug}", "ollieos://project/{slug}"]);
    await c.close();
  });

  it("gives Claude a project's facts through get_context (criterion 4, server side)", async () => {
    const p = await project("Bakery refit", { summary: "New ovens for the Leeds bakery" });
    const pe = await person("Sam Hart", { role: "Site manager" });
    await link("person", pe.id, "project", p.id);
    await fact("project", p.id, "Budget is £40,000");
    await decision(p.id, "Go with the Rational ovens");
    await task("Chase oven quote", { projectId: p.id, personId: pe.id });

    const { tokens } = await connect();
    const c = await mcpClient(tokens.access_token);
    const { body } = await call(c, "get_context", { name: "Bakery refit" });
    expect(body.entity).toMatchObject({ type: "project", name: "Bakery refit", slug: "bakery-refit" });
    expect(body.summary).toBe("New ovens for the Leeds bakery");
    expect(body.facts.map((f: { text: string }) => f.text)).toEqual(["Budget is £40,000"]);
    expect(body.decisions[0].text).toBe("Go with the Rational ovens");
    expect(body.open_tasks[0]).toMatchObject({ title: "Chase oven quote", person: { name: "Sam Hart" } });
    expect(body.people[0]).toMatchObject({ name: "Sam Hart", role: "Site manager" });

    const reads = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.action, "read"), eq(auditEventsTable.actor, "Claude")));
    expect(reads.length).toBeGreaterThan(3);
    await c.close();
  });

  it("never shows a confidential project or anything linked only to it (criterion 2)", async () => {
    const open = await project("Garden", { summary: "Planting plan" });
    const sale = await project("Sale process", { confidential: true, summary: "Selling to Hendersons" });
    const buyer = await person("Hendersons buyer", { confidential: true });
    await link("person", buyer.id, "project", sale.id);
    await task("Send Hendersons the accounts", { projectId: sale.id });
    await task("Plant the Hendersons roses", { projectId: open.id });
    await decision(sale.id, "Accept the Hendersons offer");
    await note("project", sale.id, "Hendersons want the vans included");
    await fact("project", sale.id, "Hendersons offer is £2m");

    const { tokens } = await connect();
    const c = await mcpClient(tokens.access_token);

    const search = await call(c, "search", { query: "Hendersons" });
    expect(search.body.results.map((r: { title: string }) => r.title)).toEqual(["Plant the Hendersons roses"]);
    expect(JSON.stringify(search.body)).not.toMatch(/Sale process|accounts|offer|vans/);

    for (const pick of [{ name: "Sale process" }, { slug: "sale-process" }, { ref: `project:${sale.id}` }]) {
      const r = await call(c, "get_context", pick);
      expect(r.isError).toBe(true);
      expect(r.body.error).toBe("not_found");
    }
    const missing = await call(c, "get_context", { name: "No such project" });
    // Hidden and missing give the same reply, so the error confirms nothing.
    expect((await call(c, "get_context", { name: "Sale process" })).body).toEqual(missing.body);

    const list = await call(c, "list_tasks", {});
    expect(list.body.tasks.map((t: { title: string }) => t.title)).toEqual(["Plant the Hendersons roses"]);
    const byProject = await call(c, "list_tasks", { project: { name: "Sale process" } });
    expect(byProject.body.error).toBe("not_found");

    const today = await c.readResource({ uri: "ollieos://today" });
    expect(today.contents[0].text).not.toMatch(/Hendersons the accounts|Sale process/);
    await expect(c.readResource({ uri: "ollieos://project/sale-process" })).rejects.toThrow();

    // Writes cannot be aimed at it either, and upserts that match it change nothing.
    const add = await call(c, "add_fact", { entity: { name: "Sale process" }, text: "x" });
    expect(add.body.error).toBe("not_found");
    const up = await call(c, "upsert_project", { name: "Sale process", summary: "overwritten" });
    expect(up.body.error).toBe("forbidden");
    const [row] = await db.execute(`select summary from projects where id = ${sale.id}`).then((r) => r.rows as { summary: string }[]);
    expect(row.summary).toBe("Selling to Hendersons");
    await c.close();
  });

  it("creates, updates and dedupes tasks, and a confidential create_task is never shown back (criterion 12)", async () => {
    await project("Garden");
    const { tokens } = await connect();
    const c = await mcpClient(tokens.access_token);

    const a = await call(c, "create_task", { title: "Order compost", project: { name: "Garden" }, source: "email", source_ref: "m-1" });
    expect(a.body.task).toMatchObject({ title: "Order compost", status: "inbox", project: { name: "Garden" } });
    const b = await call(c, "create_task", { title: "Order compost again", source: "email", source_ref: "m-1" });
    expect(b.body.duplicate).toBe(true);

    const u = await call(c, "update_task", { ref: a.body.task.ref, status: "done", notes_append: "Ordered 10 bags" });
    expect(u.body.task.status).toBe("done");
    expect(u.body.task.notes).toMatch(/Ordered 10 bags/);

    const secret = await call(c, "create_task", { title: "Secret task", confidential: true });
    expect(secret.body.task).toBeNull();
    const [row] = await db.select().from(tasksTable).where(eq(tasksTable.title, "Secret task"));
    expect(row.confidential).toBe(true);
    const upd = await call(c, "update_task", { ref: `task:${row.id}`, title: "x" });
    expect(upd.body.error).toBe("not_found");
    const list = await call(c, "list_tasks", { status: ["inbox", "done"] });
    expect(list.body.tasks.map((t: { title: string }) => t.title)).toEqual(["Order compost"]);
    await c.close();
  });

  it("stops working as soon as Ollie revokes the tool", async () => {
    const { tokens } = await connect();
    const sid = await ollieSession();
    const clients = await (await fetch(`${base}/api/ai-clients`, { headers: { authorization: `Bearer ${sid}` } })).json();
    const claude = clients.find((x: { name: string }) => x.name === "Claude");
    expect(claude.connectedAt).toBeTruthy();
    const r = await fetch(`${base}/api/ai-clients/${claude.id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${sid}` } });
    expect(r.status).toBe(200);
    await expect(mcpClient(tokens.access_token)).rejects.toThrow();
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/invalid_token/);
  });

  it("hides registrations nobody approved from Settings", async () => {
    await fetch(`${base}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Drive-by", redirect_uris: ["https://evil.example/cb"] }),
    });
    const sid = await ollieSession();
    const clients = await (await fetch(`${base}/api/ai-clients`, { headers: { authorization: `Bearer ${sid}` } })).json();
    expect(clients.map((x: { name: string }) => x.name)).not.toContain("Drive-by");
  });
});
