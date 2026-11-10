import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityTable, captureLogTable, db, noiseRulesTable, peopleTable, tasksTable } from "@workspace/db";
import { londonRange, todayLondon } from "@workspace/shared";
import { SOURCE_OF_TRUTH } from "../src/mcp/server";
import { decision, fact, link, note, person, project, task } from "./helpers";
import { authorize, base, call, connect, consent, ingest, mcp, pkce, register, sid, token, useServer, REDIRECT } from "./harness";

// Finishing a sweep writes briefs and the digest summary; keep the model out of these tests.
vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  writeBriefFromDocs: async () => ({ why: [], questions: [], questionsNote: "" }),
  digestSummaryFromLines: async () => "Summary.",
}));

function item(ref: string, extra: Record<string, unknown> = {}) {
  return { source: "email", source_ref: ref, title: `Reply about ${ref}`, from_name: "Jo", from_address: "jo@example.com", ...extra };
}

useServer();

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
    expect((await c.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["find_documents", "get_context", "get_meeting_brief", "get_playbooks", "list_goals", "list_overdue_contacts", "list_tasks", "search"]);
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
        "find_documents",
        "get_context",
        "get_meeting_brief",
        "get_playbooks",
        "list_goals",
        "list_my_suggestions",
        "list_overdue_contacts",
        "list_tasks",
        "log_activity",
        "log_decision",
        "log_promise",
        "request_access",
        "save_document",
        "save_session",
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
    expect((await c.listResources()).resources.map((r) => r.uri)).toEqual(["ollieos://today", "ollieos://brief/next"]);
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
    const { calendarEventsTable } = await import("@workspace/db");
    // Minutes from now, so every event is still to come whatever time the test runs.
    const ev = (ref: string, m: number, extra: Record<string, unknown> = {}) => ({
      source_ref: ref,
      title: `Meeting ${ref}`,
      starts_at: new Date(Date.now() + m * 60_000).toISOString(),
      ends_at: new Date(Date.now() + (m + 5) * 60_000).toISOString(),
      ...extra,
    });
    await ingest("calendar", { body: { events: [ev("a", 10), ev("b", 20)] } });
    const r = await ingest("calendar", { body: { events: [ev("c", 30, { project: "Garden shed" }), ev("d", 40, { people: ["Jo Bloggs"] })] } });
    expect(r.body).toMatchObject({ replaced: 2, removed: 2, unmatched: [] });
    const rows = await db.select().from(calendarEventsTable).orderBy(calendarEventsTable.startsAt);
    expect(rows.map((e) => e.sourceRef)).toEqual(["c", "d"]);
    const home = (await (await fetch(`${base}/api/home`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { today: { id: number; hasBrief: boolean }[] };
    // Linked to a project or a known person: Brief me opens the brief (build plan 28).
    for (const e of home.today) expect(e.hasBrief).toBe(true);
    void shed;
    void jo;
  });

  it("keeps events that have started when they drop out of the feed (build plan 29)", async () => {
    const { calendarEventsTable } = await import("@workspace/db");
    const ev = (ref: string, m: number) => ({
      source_ref: ref,
      title: `Meeting ${ref}`,
      starts_at: new Date(Date.now() + m * 60_000).toISOString(),
      ends_at: new Date(Date.now() + (m + 60) * 60_000).toISOString(),
    });
    await ingest("calendar", { body: { events: [ev("started", -5), ev("later", 30)] } });
    const [before] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.sourceRef, "later"));
    await ingest("calendar", { body: { events: [{ ...ev("later", 30), title: "Renamed" }] } });
    const rows = await db.select().from(calendarEventsTable).orderBy(calendarEventsTable.startsAt);
    expect(rows.map((e) => [e.sourceRef, e.title])).toEqual([["started", "Meeting started"], ["later", "Renamed"]]);
    // Matched on source_ref, so the id (and any brief) stays.
    expect(rows[1].id).toBe(before.id);
  });

  it("stores events whose names do not match and reports them, the same for hidden and unknown (build plan 30)", async () => {
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
    const c = await mcp((await connect()).access_token);
    for (const [association, unmatched] of [
      [{ project: hidden.name }, [hidden.name]],
      [{ project: "Unknown project" }, ["Unknown project"]],
      [{ people: [visible.name, "Private attendee"] }, ["Private attendee"]],
      [{ people: ["Unknown person"] }, ["Unknown person"]],
    ] as const) {
      const events = [{ ...event, ...association }];
      const viaIngest = await ingest("calendar", { body: { events } });
      expect(viaIngest.status).toBe(200);
      expect(viaIngest.body).toMatchObject({ replaced: 1, unmatched });
      const viaMcp = await call(c, "upsert_calendar", { events });
      expect(viaMcp.isError).toBeFalsy();
      expect(viaMcp.json).toMatchObject({ unmatched });
      const rows = await db.select().from(calendarEventsTable);
      expect(rows.map((r) => r.sourceRef)).toEqual(["private-event"]);
      expect(rows[0].projectId).toBeNull();
      expect(rows[0].personIds).toEqual("people" in association && association.people.includes(visible.name) ? [visible.id] : []);
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
      { ...baseEvent, sourceRef: "location", title: "Meeting", location: `${hiddenProject.name.toUpperCase()} war room` },
      // Whole names only: part of a hidden name, or a slug, does not hide an event.
      { ...baseEvent, sourceRef: "partial", title: "Merger talk", location: hiddenProject.slug },
      { ...baseEvent, sourceRef: "longer", title: "Hidden attendees list" },
      { ...baseEvent, sourceRef: "mixed", title: "Meeting", personIds: [visible.id, hiddenPerson.id] },
      { ...baseEvent, sourceRef: "safe", title: "Public meeting", personIds: [visible.id] },
    ]);
    const c = await mcp((await connect()).access_token);
    const result = await c.readResource({ uri: "ollieos://today" });
    const today = JSON.parse((result.contents[0] as { text: string }).text);
    expect(today.calendar.map((r: { title: string }) => r.title).sort()).toEqual(["Hidden attendees list", "Merger talk", "Public meeting"]);
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
  it("writes tasks and promises directly, and proposes knowledge for Ollie to approve", async () => {
    const shed = await project("Garden shed", { summary: "Timber shed" });
    await person("Jo Bloggs");
    const c = await mcp((await connect()).access_token);
    const proj = await call(c, "upsert_project", { name: "Garden shed", area: "Home" });
    expect(proj.json).toMatchObject({ status: "suggested", project: { ref: `project:${shed.id}` } });
    expect((await call(c, "upsert_project", { name: "garden shed", summary: "Timber shed" })).json.status).toBe("unchanged");
    expect((await call(c, "upsert_project", { name: "Greenhouse" })).json.status).toBe("suggested");
    expect((await call(c, "upsert_person", { name: "Jo Bloggs", role: "Builder" })).json).toMatchObject({ status: "suggested", person: { name: "Jo Bloggs" } });
    const created = await call(c, "create_task", { title: "Order timber", project: { name: "Garden shed" }, person: { name: "Bloggs" }, status: "now" });
    const ref = (created.json.task as { ref: string }).ref;
    expect(created.json.task).toMatchObject({ status: "now", project: { name: "Garden shed" }, person: { name: "Jo Bloggs" } });
    const updated = await call(c, "update_task", { ref, status: "waiting", waiting_on: { name: "Jo Bloggs" }, notes_append: "Quote due Friday" });
    expect(updated.json.task).toMatchObject({ status: "waiting", waiting_on: { name: "Jo Bloggs" }, notes: "Quote due Friday" });
    const f1 = await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "Budget is 2k", source: "Email from Jo" });
    expect(f1.json).toMatchObject({ status: "suggested", suggestion_id: expect.any(Number) });
    expect((await call(c, "add_fact", { entity: { name: "Garden shed" }, text: "budget is 2k." })).json.status).toBe("duplicate");
    const d = await call(c, "log_decision", { project: { name: "Garden shed" }, text: "Go with timber" });
    expect(d.json.status).toBe("suggested");
    const secret = await call(c, "log_decision", { project: { name: "Garden shed" }, text: "Budget cap is private", confidential: true });
    expect(secret.json).toEqual({ status: "suggested", message: expect.stringContaining("confidential") });
    const ctx = await call(c, "get_context", { slug: "garden-shed" });
    expect(ctx.json.facts).toEqual([]);
    expect((ctx.json.waiting_on_them as unknown[]).length).toBe(1);
    const mine = await call(c, "list_my_suggestions", {});
    const listed = (mine.json.suggestions as { kind: string; text: string }[]).map((x) => x.text).sort();
    expect(listed).toEqual(["Budget is 2k", "Go with timber", "Greenhouse", "area: Home", "role: Builder"].sort());
    const promise = await call(c, "log_promise", { title: "Send Jo the drawings", to_person: "Jo Bloggs", source: "meeting" });
    expect(promise.json.task).toMatchObject({ kind: "promise", person: { name: "Jo Bloggs" } });
    expect((await call(c, "request_access", { item: "Anything", reason: "Context" })).json).toEqual({ status: "pending", message: "Sent to Ollie for approval." });
    await c.close();

    const log = (await (await fetch(`${base}/api/ai-activity`, { headers: { authorization: `Bearer ${sid}` } })).json()) as { actor: string; kind: string }[];
    expect(log.some((l) => l.actor === "Claude" && l.kind === "write")).toBe(true);
    expect(log.some((l) => l.actor === "Claude" && l.kind === "read")).toBe(true);
  });
});
