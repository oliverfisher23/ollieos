# OllieOS: Build plan (milestone 0)

| | |
|---|---|
| Based on | `docs/PRD.md` v2.1, `docs/DESIGN.md`, all nine files in `design/screens/` (markup and script blocks) |
| Written | Monday 9th November 2026 |
| Status | Waiting for Ollie's approval. No app code has been written |

Section 9 at the end lists everything I found unclear or conflicting, each with a proposed answer. If you are happy with a proposal you can just say "agree with 3, 7, 12" (or "agree with all"), and correct the rest.

---

## 1. How this fits the Repl

The Repl is already set up as a small monorepo (one folder per app or shared library). That changes nothing about the product, but it decides where things live:

- **Frontend:** a new React + Vite app, `artifacts/ollieos`, served at the root of the domain (`/`).
- **Backend:** the existing Express server, `artifacts/api-server`. It serves the app API (`/api/...`), the ingest API (`/api/ingest/...`), the MCP server (`/mcp`) and the OAuth endpoints (`/oauth/...` and `/.well-known/...`). Its routing will be extended so `/mcp`, `/oauth` and `/.well-known` reach it as well as `/api`.
- **Database:** Replit Postgres through the existing `lib/db` package (Drizzle).
- **API contract:** the app API is written once in OpenAPI (`lib/api-spec/openapi.yaml`); typed React hooks and Zod validators are generated from it. The ingest API and MCP tools validate with Zod schemas kept next to their handlers.
- **Shared code:** a new `lib/shared` package for things both sides need: ordinal date formatting in Europe/London time, the quick-add parser, and the status, priority and source constants.
- The existing design canvas (`artifacts/mockup-sandbox`) is left alone.

---

## 2. File and folder structure

```
docs/
  PRD.md, DESIGN.md, build-plan.md
  APP_GUIDE.md                       (milestone 6)
design/screens/*.dc.html             (reference only, never imported)

lib/
  db/src/schema/
    tasks.ts          tasks, capture_log, noise_rules
    knowledge.ts      projects, people, organisations, facts, decisions, notes, activity, links
    calendar.ts       calendar_events, sweep_runs
    access.ts         access_requests, ai_clients, oauth_codes, oauth_tokens
    ask.ts            ask_threads
    audit.ts          audit_events, import_runs
    auth.ts           users, sessions (Replit Auth)
    search.ts         tsvector column helper
    enums.ts          all pgEnums
    index.ts          barrel
  api-spec/openapi.yaml               app API contract (session-authenticated routes)
  api-client-react/, api-zod/         generated from the spec, never hand-edited
  shared/src/
    dates.ts          formatOrdinal ("Friday 13th November"), formatShort ("Fri 13th Nov"),
                      formatTime (24-hour), London week boundaries, "due:fri" resolution
    quickAdd.ts       parser for !high !low due:… #backlog @slug, used by client preview and server
    constants.ts      statuses, priorities, sources, entity types, labels in British English

artifacts/api-server/src/
  app.ts, index.ts
  middlewares/
    session.ts        Replit Auth session loader
    requireOllie.ts   allowlist check against ALLOWED_EMAIL, otherwise 403 "Not authorised"
    ingestAuth.ts     Bearer INBOX_API_KEY, resolves the "Capture sweep" ai_client, rejects if revoked
    mcpAuth.ts        Bearer OAuth access token, resolves ai_client, rejects if revoked
  routes/             app API (all behind requireOllie)
    auth.ts home.ts tasks.ts search.ts ask.ts access.ts aiClients.ts audit.ts
    noiseRules.ts sweep.ts export.ts calendar.ts
    knowledge/ projects.ts people.ts organisations.ts decisions.ts notes.ts facts.ts links.ts
    ingest/   tasks.ts cursor.ts sweepRun.ts calendar.ts activity.ts reads.ts import.ts
  oauth/      metadata.ts register.ts authorize.ts consent.ts token.ts revoke.ts store.ts
  mcp/        server.ts (Streamable HTTP, stateless) tools/*.ts resources.ts descriptions.ts
  ask/        answer.ts (retrieval, Anthropic call, citation parsing) prompts.ts
  lib/
    ai-data/          THE ONLY database access for AI-facing code (section 6)
      scope.ts        builds a VisibilityScope for one client
      predicates.ts   SQL WHERE fragments per table
      search.ts context.ts tasks.ts writes.ts audit.ts
    services/         shared business logic used by both app routes and ai-data writes
      tasks.ts        transitions, triage, undo, snooze, Do next ranking
      ingest.ts       dedupe, noise matching, hint resolution
      resolve.ts      name, slug and email matching for people and projects
      weekly.ts       weekly update text grouped by project
      chase.ts        chase line text
      audit.ts        writeAudit(actor, action, entity, payload)
      noiseCleanup.ts 90-day Noise purge
    logger.ts
  test/               vitest: one file per PRD acceptance criterion that can be automated

artifacts/ollieos/
  index.html          DM Sans 400/500/600 and Instrument Serif from Google Fonts
  src/
    theme/tokens.css  THE theme file (section 7)
    main.tsx, App.tsx, routes.tsx
    layouts/
      DarkShell.tsx   gradient + grain, icon rail (desktop) or bottom tab bar (phone)
      LightShell.tsx  OllieOS mark + pill nav, page panel
    pages/
      home/ HomePage.tsx AskAddBox.tsx TodayStrip.tsx DoNextCard.tsx InboxCard.tsx
            WaitingCard.tsx PromisesCard.tsx DoneCard.tsx StatusLine.tsx
      triage/ TriageOverlay.tsx (desktop) TriageScreen.tsx (phone)
      ask/ AskPage.tsx AnswerCard.tsx
      tasks/ TasksPage.tsx TaskTable.tsx TaskDetailPanel.tsx StatCards.tsx
      knowledge/ KnowledgeLayout.tsx ProjectPage.tsx PersonPage.tsx OrganisationPage.tsx
                 DecisionPage.tsx NotePage.tsx ListPages.tsx AccessPanel.tsx
      settings/ AiAccessPage.tsx SweepPage.tsx NoiseRulesPage.tsx ImportsPage.tsx ExportPage.tsx
      auth/ SignInPage.tsx NotAuthorisedPage.tsx
      oauth/ ConsentPage.tsx
    components/       Pill, SourceMark, Avatar, Switch, Segmented, GlassCard, StatCard,
                      DataTable, Toast (with Undo), Lock, InlineEdit, IconButton, icons/
    hooks/            useShortcuts, useSwipe, useReducedMotion, useUndo, useClipboard
    lib/format.ts     thin wrappers over lib/shared dates

scripts/src/
  check-ui-text.ts    fails if any frontend source has an em dash in UI text,
                      or a hex/rgb colour outside theme/tokens.css
```

---

## 3. Database schema (Drizzle)

Conventions:

- Integer identity primary keys. Everything AI-facing refers to items as typed refs, for example `task:42`, `project:7`, which are short and easy for Claude to cite.
- All timestamps are `timestamptz` stored in UTC; `date` columns (due dates, decided_at) are plain calendar dates.
- Searchable tables have a generated `search tsvector` column (English config) with a GIN index.
- `confidential` on tasks, decisions and notes is nullable: `null` means "inherit", `true`/`false` is Ollie's override (PRD 10, rule 1). Projects, people and organisations have a plain boolean.
- Additions beyond PRD section 9 are marked **(added)** with the reason.

```ts
// enums.ts
export const taskKind      = pgEnum("task_kind", ["task", "promise"]);
export const taskStatus    = pgEnum("task_status", ["inbox", "now", "backlog", "waiting", "done", "noise"]);
export const priority      = pgEnum("priority", ["high", "medium", "low"]);
export const taskSource    = pgEnum("task_source", ["email", "slack", "meeting", "quarterly", "manual"]);
export const entityType    = pgEnum("entity_type", ["task", "project", "person", "organisation",
                               "decision", "note", "fact", "activity", "calendar_event"]);
export const activityKind  = pgEnum("activity_kind", ["email", "meeting", "slack", "note", "task"]);
export const captureOutcome= pgEnum("capture_outcome", ["created", "duplicate", "noise", "error"]);
export const noiseMatch    = pgEnum("noise_match", ["from_address_equals", "from_domain_equals",
                               "slack_channel_equals", "title_contains"]);
export const requestStatus = pgEnum("request_status", ["pending", "approved", "declined", "expired"]);
export const clientKind    = pgEnum("client_kind", ["connector", "scheduled_task", "other"]);
export const clientAuth    = pgEnum("client_auth", ["oauth", "api_key", "internal"]);   // (added)
```

```ts
// tasks.ts
export const tasks = pgTable("tasks", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  title: text().notNull(),
  kind: taskKind().notNull().default("task"),
  status: taskStatus().notNull().default("inbox"),
  priority: priority().notNull().default("medium"),
  dueDate: date("due_date"),
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
  source: taskSource().notNull().default("manual"),
  sourceRef: text("source_ref"),
  sourceUrl: text("source_url"),
  sourceQuote: text("source_quote"),
  sourceSubject: text("source_subject"),          // (added) "Base quote" line on the Source card
  sourceChannel: text("source_channel"),          // (added) needed for slack_channel_equals rules
  fromName: text("from_name"),
  fromAddress: text("from_address"),
  snippet: text(),
  suggestedAction: text("suggested_action"),
  notes: text(),
  waitingOnPersonId: integer("waiting_on_person_id").references(() => people.id),
  waitingSince: timestamp("waiting_since", { withTimezone: true }),   // (added) "4 days" on Waiting on
  personId: integer("person_id").references(() => people.id),
  projectId: integer("project_id").references(() => projects.id),
  noiseRuleId: integer("noise_rule_id").references(() => noiseRules.id),
  confidential: boolean(),                         // null = inherit
  capturedAt: timestamp("captured_at", { withTimezone: true }),     // (added) when the source item happened
  createdBy: text("created_by").notNull(),         // (added) actor, mirrors audit
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  triagedAt: timestamp("triaged_at", { withTimezone: true }),
  search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english',
    coalesce(title,'')||' '||coalesce(snippet,'')||' '||coalesce(notes,'')||' '||
    coalesce(source_quote,'')||' '||coalesce(from_name,''))`),
}, (t) => [
  index().on(t.status), index().on(t.dueDate), index().on(t.projectId),
  index().on(t.personId), index().on(t.waitingOnPersonId), index().on(t.completedAt),
  uniqueIndex().on(t.source, t.sourceRef).where(sql`source_ref is not null`),
  index("tasks_search_idx").using("gin", t.search),
]);

export const captureLog = pgTable("capture_log", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  source: taskSource().notNull(),
  sourceRef: text("source_ref").notNull(),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
  outcome: captureOutcome().notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex().on(t.source, t.sourceRef)]);

export const noiseRules = pgTable("noise_rules", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  matchType: noiseMatch("match_type").notNull(),
  matchValue: text("match_value").notNull(),       // stored lower-case
  source: taskSource(),                             // null = any source (never meeting, see section 4.4)
  enabled: boolean().notNull().default(true),
  hitCount: integer("hit_count").notNull().default(0),
  lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
  createdFromTaskId: integer("created_from_task_id"),   // (added) "the rule that caught each item"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

```ts
// knowledge.ts
export const projects = pgTable("projects", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  area: text(),                                    // "Defence" in the eyebrow
  status: text(),                                  // free text pill, e.g. "Proposal sent"
  summary: text(),
  confidential: boolean().notNull().default(false),
  aiAccess: boolean("ai_access").notNull().default(true),
  archived: boolean().notNull().default(false),    // (added) instead of deleting
  createdAt: …, updatedAt: …, search: tsvector(name, area, summary),
});

export const people = pgTable("people", {
  id, name: text().notNull(), slug: text().notNull().unique(),
  organisationId: integer("organisation_id").references(() => organisations.id),
  role: text(), email: text(),                     // unique where not null
  relationshipSummary: text("relationship_summary"),
  confidential: boolean().notNull().default(false),
  aiAccess: boolean("ai_access").notNull().default(true),
  lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
  createdAt: …, updatedAt: …,                      // (added) for "Updated 9th November"
  search: tsvector(name, role, email, relationship_summary),
});

export const organisations = pgTable("organisations", {
  id, name, slug (unique), type: text(), summary: text(),
  confidential: boolean().notNull().default(false),
  aiAccess: boolean("ai_access").notNull().default(true),
  createdAt: …, updatedAt: …, search: tsvector(name, type, summary),
});

export const facts = pgTable("facts", {
  id, entityType: entityType("entity_type").notNull(), entityId: integer("entity_id").notNull(),
  text: text().notNull(), source: text(),          // "claude-memory", "email", "ollie"…
  createdBy: text("created_by").notNull(),
  createdAt: timestamp(...).notNull().defaultNow(),   // import keeps the original date
  supersededBy: integer("superseded_by"),          // self reference; null = current
  search: tsvector(text),
}, (t) => [index().on(t.entityType, t.entityId)]);
// Facts are never updated in place: a change inserts a new row and sets superseded_by on the old one.

export const decisions = pgTable("decisions", {
  id, projectId: integer("project_id").notNull().references(() => projects.id),
  text: text().notNull(), decidedAt: date("decided_at").notNull(),
  decidedBy: text("decided_by"), source: text(),
  confidential: boolean(),                         // null = inherit from project
  createdBy: text("created_by").notNull(), createdAt: …, search: tsvector(text),
});

export const notes = pgTable("notes", {
  id, entityType: entityType("entity_type").notNull(), entityId: integer("entity_id").notNull(),
  title: text(),                                   // (added) notes need a name in the Library list
  body: text().notNull(), createdBy: text("created_by").notNull(), createdAt: …,
  updatedAt: …, confidential: boolean(),           // null = inherit from the entity
  search: tsvector(title, body),
});

export const activity = pgTable("activity", {
  id, entityType: entityType("entity_type"), entityId: integer("entity_id"),   // primary entity
  kind: activityKind().notNull(), summary: text().notNull(),
  sourceUrl: text("source_url"), sourceRef: text("source_ref"),   // (added) dedupe on re-sweep
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdBy: text("created_by").notNull(), createdAt: …,
});
// Extra people and projects for the same touchpoint go in `links` (activity → person/project).

export const links = pgTable("links", {
  fromType: entityType("from_type").notNull(), fromId: integer("from_id").notNull(),
  toType: entityType("to_type").notNull(), toId: integer("to_id").notNull(),
  createdBy: text("created_by").notNull(), createdAt: …,
}, (t) => [primaryKey({ columns: [t.fromType, t.fromId, t.toType, t.toId] }),
           index().on(t.toType, t.toId)]);
```

```ts
// calendar.ts
export const calendarEvents = pgTable("calendar_events", {
  id, sourceRef: text("source_ref").notNull().unique(), title: text().notNull(),
  startsAt: timestamp(...).notNull(), endsAt: timestamp(...).notNull(),
  attendees: text().array().notNull().default(sql`'{}'`),
  personal: boolean().notNull().default(false),
  personIds: integer("person_ids").array().notNull().default(sql`'{}'`),
  projectId: integer("project_id").references(() => projects.id),
  location: text(),                                // (added) "MOD" on the Today card
  updatedAt: …,
});

export const sweepRuns = pgTable("sweep_runs", {
  id, startedAt: timestamp(...).notNull(), finishedAt: timestamp(...),
  itemsCreated: integer().default(0), itemsNoise: integer().default(0),
  itemsDuplicate: integer().default(0), activityLogged: integer().default(0),
  errors: jsonb().$type<string[]>().default([]),
  clientId: integer("client_id").references(() => aiClients.id),
});
```

```ts
// access.ts
export const aiClients = pgTable("ai_clients", {
  id, name: text().notNull(), kind: clientKind().notNull(),
  auth: clientAuth().notNull(),                    // (added) oauth | api_key | internal (Ask OllieOS)
  oauthClientId: text("oauth_client_id").unique(), // (added) from dynamic client registration
  redirectUris: text("redirect_uris").array(),     // (added)
  scopes: text().array().notNull().default(sql`'{read,write}'`),
  connectedAt: timestamp(...), lastUsedAt: timestamp(...), revokedAt: timestamp(...),
});

export const accessRequests = pgTable("access_requests", {
  id, clientId: integer("client_id").notNull().references(() => aiClients.id),   // PRD "client"
  entityType: entityType("entity_type"), entityId: integer("entity_id"),   // null until matched
  requestedName: text("requested_name").notNull(),   // (added) what the AI asked for, as written
  reason: text(), status: requestStatus().notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),             // set to now + 1 hour on approve
  decidedAt: timestamp("decided_at", { withTimezone: true }),             // (added)
  createdAt: …,
});

// (added) OAuth 2.1 storage for the MCP connector, tokens stored as SHA-256 hashes only
export const oauthCodes  = pgTable("oauth_codes",  { codeHash (pk), clientId, redirectUri,
  codeChallenge, scopes, expiresAt, usedAt });
export const oauthTokens = pgTable("oauth_tokens", { id, tokenHash (unique), kind: "access" | "refresh",
  clientId, scopes, expiresAt, revokedAt, createdAt });
```

```ts
// ask.ts
export const askThreads = pgTable("ask_threads", {
  id, parentId: integer("parent_id"),              // (added) follow-ups chain to the first question
  question: text().notNull(),
  answer: jsonb().$type<AskAnswer>().notNull(),    // { summary, items[{text, citedRefs[]}], related[] }
  citedIds: text("cited_ids").array().notNull(),   // ["task:42", "activity:9"]
  usedConfidential: boolean("used_confidential").notNull().default(false),
  model: text(), createdAt: …,
});

// audit.ts
export const auditEvents = pgTable("audit_events", {
  id: bigint(...).primaryKey().generatedAlwaysAsIdentity(),
  actor: text().notNull(),                         // "ollie", "ingest", "claude", client name
  clientId: integer("client_id"),                  // (added) for per-client reporting
  action: text().notNull(),                        // create, update, status, read, search,
                                                   // request_access, approve, decline, revoke…
  entityType: entityType("entity_type"), entityId: integer("entity_id"),
  payload: jsonb(),                                // diff for writes, query for searches
  createdAt: …,
}, (t) => [index().on(t.entityType, t.entityId), index().on(t.createdAt), index().on(t.action)]);

export const importRuns = pgTable("import_runs", {   // (added) enforces "disabled after first use"
  id, kind: text().notNull().unique(),             // "tasks" | "knowledge"
  ranAt: …, counts: jsonb(), actor: text().notNull(),
});

// auth.ts: users and sessions tables from the Replit Auth template, unchanged.
```

Migrations: `drizzle-kit push` in development; the same schema is applied to production when publishing.

---

## 4. Pages and routes

### 4.1 Frontend pages (`artifacts/ollieos`)

Phone layout is the same route with a different layout below 640px wide, not a separate page.

| Route | Page | Screen file | Milestone |
|---|---|---|---|
| `/` | Home: greeting, status line with access request, Ask/Add box, Today strip, Do next, Inbox, Waiting on, Promises, Done this week | `Main.dc.html`; phone `PhoneHome.dc.html` | 1 (cards), 5 (Today strip, status line) |
| `/triage` | Triage: overlay on Home (desktop), full screen (phone) | Triage block in `Main.dc.html`; `PhoneTriage.dc.html` | 2, phone polish 6 |
| `/ask`, `/ask/:threadId` | Ask OllieOS answer and follow-ups | `Ask.dc.html` | 3 |
| `/tasks?tab=&source=&week=&q=&task=` | Tasks list with tabs, toolbar, stat cards, table. `task=` opens the detail panel (full-screen sheet on phone) | `Tasks.dc.html`, `TaskDetail.dc.html` | 1 |
| `/knowledge` | Knowledge layout; lands on the most recently updated project | `Knowledge.dc.html` | 3 |
| `/knowledge/projects/:slug` | Project page with AI access panel | `Knowledge.dc.html` | 3, panel live in 4 |
| `/knowledge/people`, `/knowledge/people/:slug` | People list, Person page | `Person.dc.html` | 3 |
| `/knowledge/organisations[/:slug]` | Organisation list and page | Derived from Knowledge and Person patterns | 3 |
| `/knowledge/decisions[/:id]` | Decisions list and page | Derived | 3 |
| `/knowledge/notes[/:id]` | Notes list and page | Derived | 3 |
| `/settings/ai-access` | Counts, access requests, connected tools, AI read log | `Settings.dc.html` | 4, tools table live in 5 |
| `/settings/sweep` | Sweep runs list, cursor, ingest key status | Derived from Settings | 5 |
| `/settings/noise-rules` | Rules with hit counts, enable/disable | Derived | 2 |
| `/settings/imports` | Import status per kind | Derived | 6 |
| `/settings/export` | CSV downloads | Derived | 6 |
| `/sign-in` | Sign in with Replit | Dark surface, derived | 1 |
| `/not-authorised` | "Not authorised" for any other login | Dark surface, derived | 1 |
| `/oauth/consent` | Approve a new AI tool connecting (behind Replit Auth) | Light surface, derived | 5 |

Navigation: icon rail (desktop Home and Ask) and light-page top nav link to Home, Tasks, Knowledge, People, Settings (see question 4). Phone tab bar per `PhoneHome.dc.html`.

### 4.2 App API (`/api`, session + allowlist on every route except sign-in)

| Method and path | Purpose |
|---|---|
| `GET /api/login`, `GET /api/callback`, `GET /api/logout`, `GET /api/auth/user` | Replit Auth |
| `GET /api/home` | Everything Home needs in one call: last sweep, inbox count and breakdown by source, pending access requests, Do next queue (ranked), Waiting on with days, Promises, Done this week (count and latest), today's calendar |
| `GET /api/tasks` | List with `tab`, `source`, `weekStart`, `q`, `project`, `person` |
| `GET /api/tasks/summary` | Tab counts and the four stat cards |
| `POST /api/tasks/quick-add` | Raw text in, parsed by `lib/shared/quickAdd`, task out |
| `GET /api/tasks/:id` | Task with links, source card and history from `audit_events` |
| `PATCH /api/tasks/:id` | Any field; status changes set `completed_at`, `triaged_at`, `waiting_since` |
| `POST /api/tasks/:id/triage` | `{ action: now/backlog/waiting/noise, waitingOnPersonId?, noiseRule? }`, returns the previous state for undo |
| `POST /api/tasks/:id/restore` | Undo or restore from Noise to the previous state |
| `POST /api/tasks/:id/snooze` | Sets `snoozed_until` to tomorrow 06:00 London |
| `GET /api/tasks/:id/chase-line`, `GET /api/tasks/:id/draft-prompt` | Text for the clipboard |
| `GET /api/tasks/weekly-update?weekStart=` | Done items grouped by project as plain text |
| `GET /api/search?q=&types=` | Ollie's search across everything, confidential shown with a lock |
| `GET /api/knowledge/sidebar` | Projects with open task counts and lock state, library counts |
| `GET/POST/PATCH /api/projects[/:slug]` | Project page payload; PATCH covers in-place edits and access switches |
| `GET/POST/PATCH /api/people[/:slug]` | Person page payload incl. "I owe them" and "They owe me" |
| `GET/POST/PATCH /api/organisations[/:slug]` | Organisation page payload |
| `GET/POST/PATCH /api/decisions[/:id]`, `GET/POST/PATCH /api/notes[/:id]` | Decisions and notes |
| `POST /api/facts`, `POST /api/facts/:id/supersede` | Facts as separate rows, supersede rather than edit |
| `POST /api/links`, `DELETE /api/links` | Link and unlink (Ollie only, never exposed to AI) |
| `POST /api/ask`, `GET /api/ask/:threadId` | Ask OllieOS; follow-ups pass `parentId` |
| `POST /api/ask/:threadId/draft`, `POST /api/ask/:threadId/bundle` | Draft a reply (shown, never sent), bundle cited tasks into one |
| `GET /api/access-requests`, `POST /api/access-requests/:id/approve`, `POST /api/access-requests/:id/decline` | Approval queue |
| `GET /api/ai-clients`, `POST /api/ai-clients/:id/revoke`, `POST /api/ai-clients/:id/reconnect` | Connected tools |
| `GET /api/ai-activity?limit=100`, `GET /api/ai-access/summary` | Read log and the four counts on Settings |
| `GET /api/sweep-runs` | Sweep history and last successful finish |
| `GET/POST/PATCH /api/noise-rules[/:id]` | Noise rules |
| `GET /api/export/:kind.csv` | CSV export (tasks, projects, people, decisions, notes, facts) |

### 4.3 Ingest API (`/api/ingest`, `Authorization: Bearer <INBOX_API_KEY>`)

Exactly as PRD section 12. Every response passes through the confidentiality filter (section 6) as the "Capture sweep" client, every write is audited with actor `ingest`.

| Route | Notes |
|---|---|
| `POST /api/ingest/tasks` | Max 100 items. Order per item: duplicate check on `capture_log (source, source_ref)`, then noise rules (never for `meeting`), then insert to Inbox. Hints resolved to ids by `services/resolve.ts`. Returns `[{ source_ref, outcome, task_id? , noise_rule_id? }]` |
| `GET /api/ingest/cursor` | `{ last_finished_at }` from the latest successful `sweep_runs` row |
| `POST /api/ingest/sweep-run` | Start (returns id) and finish (counts, errors). Finishing also runs the 90-day Noise clean-up |
| `POST /api/ingest/calendar` | Replaces events in [today 00:00, today + 8 days) London |
| `POST /api/ingest/activity` | Entries with person and project hints; dedupe on `source_ref` |
| `GET /api/ingest/noise-rules`, `GET /api/ingest/open-tasks`, `GET /api/ingest/done?since=` | Read through the filter |
| `POST /api/import` | One-off import, once per kind (question 15) |

### 4.4 MCP and OAuth (same Express server)

| Path | Purpose |
|---|---|
| `POST/GET/DELETE /mcp` | Streamable HTTP transport, stateless mode so it works on Autoscale |
| `GET /.well-known/oauth-protected-resource` | Points Claude at the authorisation server |
| `GET /.well-known/oauth-authorization-server` | Server metadata |
| `POST /oauth/register` | Dynamic client registration, creates an `ai_clients` row |
| `GET /oauth/authorize` | Redirects to `/oauth/consent` (requires Replit Auth + allowlist) |
| `POST /oauth/token` | Code exchange with PKCE, refresh tokens |
| `POST /oauth/revoke` | Token revocation |

The exact requirements will be checked against Anthropic's current custom connector docs at the start of milestone 5, as the PRD says.

---

## 5. MCP tools

Common types:

```ts
type Ref = `${"task"|"project"|"person"|"organisation"|"decision"|"note"|"fact"|"activity"}:${number}`;
type EntityPick = { ref?: Ref; slug?: string; name?: string; type?: "project"|"person"|"organisation" };
type TaskOut = { ref: Ref; title: string; kind: "task"|"promise"; status: Status; priority: Priority;
  due_date: string|null; source: Source; from_name: string|null; project: {ref, name}|null;
  person: {ref, name}|null; waiting_on: {ref, name, since}|null; source_url: string|null;
  snoozed_until: string|null; created_at: string; completed_at: string|null };
type Err = { error: "not_found" | "invalid_input" | "forbidden", message: string };
```

`not_found` is returned for hidden items as well as missing ones, so the response never confirms that a hidden item exists.

| Tool | Input | Output |
|---|---|---|
| `search` | `{ query: string; types?: EntityType[]; limit?: number (default 20, max 50) }` | `{ results: { type, ref, title, snippet, updated_at }[] }` |
| `get_context` | `EntityPick` (project, person or organisation) | `{ entity: { ref, type, name, slug, area?, status?, role?, organisation? }, summary, facts: { ref, text, source, created_at }[], decisions: { ref, text, decided_at, decided_by }[], open_tasks: TaskOut[], promises: TaskOut[], waiting_on_them: TaskOut[], people: { ref, name, role, organisation }[], projects: { ref, name }[], notes: { ref, title, body, created_at }[], recent_activity: { ref, kind, summary, occurred_at, source_url }[] }` (last 20 activity items) |
| `list_tasks` | `{ status?: Status[] (default open: inbox, now, backlog, waiting); kind?: "task"|"promise"; project?: EntityPick; person?: EntityPick; due_before?: string; limit?: number (default 50) }` | `{ tasks: TaskOut[] }` |
| `create_task` | `{ title; kind?; status? (default "inbox"); priority?; due_date?; project?; person?; waiting_on?; notes?; source?; source_ref?; source_url?; source_quote?; confidential? }` | `{ task: TaskOut, duplicate: boolean }` |
| `update_task` | `{ ref; title?; status?; priority?; due_date?: string|null; project?: EntityPick|null; person?: EntityPick|null; waiting_on?: EntityPick|null; notes_append?: string }` | `{ task: TaskOut }`. Status `noise` and `done` allowed, no delete |
| `add_fact` | `{ entity: EntityPick; text; source?; supersedes?: Ref }` | `{ fact: { ref, text, source, created_at }, superseded?: Ref }` |
| `log_decision` | `{ project: EntityPick; text; decided_at?: string (default today); decided_by?; source?; confidential? }` | `{ decision }` |
| `add_note` | `{ entity: EntityPick; title?; body; confidential? }` | `{ note }` |
| `log_activity` | `{ kind; summary; occurred_at; source_url?; source_ref?; people?: string[] (names, slugs or emails); projects?: string[] }` | `{ activity: { ref }, linked: { people: Ref[], projects: Ref[] }, unmatched: string[] }` |
| `upsert_person` | `{ name; slug?; email?; organisation?: string; role?; relationship_summary? }` | `{ person: { ref, name, slug }, created: boolean }`. Matches slug, then email, then exact name |
| `upsert_project` | `{ name; slug?; area?; status?; summary? }` | `{ project: { ref, name, slug }, created: boolean }` |
| `request_access` | `{ item: string (name or ref the AI was told about); reason: string }` | `{ status: "pending", message: "Sent to Ollie for approval." }`. Same response whether or not the item exists |
| `log_promise` | `{ title; to_person?: string; project?: string; due_date?; source; source_ref?; source_url?; source_quote? }` | `{ task: TaskOut, duplicate: boolean }` |
| `upsert_calendar` | `{ events: { source_ref; title; starts_at; ends_at; attendees?: string[]; personal?: boolean; people?: string[]; project?: string; location? }[] }` | `{ replaced: number, unmatched_people: string[] }` |

Resources: `ollieos://today` (same data as `GET /api/home`, filtered), `ollieos://project/{slug}` and `ollieos://person/{slug}` (same as `get_context`).

There is deliberately no delete tool. A test lists the registered tools and fails if any name or description contains "delete" or "remove" (acceptance criterion 7).

Tool descriptions open with: "OllieOS is the source of truth for Ollie's work: tasks, projects, people and decisions. Check it before asking Ollie for context."

---

## 6. The confidentiality filter

**Where it sits.** `artifacts/api-server/src/lib/ai-data/` is the only code allowed to read the database for AI-facing routes. MCP tools, MCP resources, ingest `GET` routes, ingest write responses and Ask OllieOS retrieval all call into it. An ESLint `no-restricted-imports` rule forbids importing `@workspace/db` from `src/mcp/**`, `src/routes/ingest/**` and `src/ask/**`, so "no AI route reads the database directly" (PRD 4, rule 3) is enforced by the build, not by convention.

**How it works.**

1. `buildScope(client)` returns a `VisibilityScope` for one client: the client id plus the set of approved, unexpired grants from `access_requests`.
2. Visibility is computed in SQL, in the `WHERE` clause of every query, so hidden rows are never fetched and never counted (PRD 10, rule 2):
   - A **project, person or organisation** is hidden if `confidential` is true or `ai_access` is false, unless the client has a live grant for it.
   - A **decision** is hidden if its `confidential` is true, or it is `null` and its project is hidden.
   - A **note, fact or activity** is hidden if its own `confidential` is true, or it is `null` (facts and activity have no flag) and its entity is hidden.
   - A **task** is hidden if `confidential` is true, or it is `null` and the inheritance rule in question 9 says so.
   - A grant on a project also unlocks items that are hidden only because of that project (question 10).
3. Inheritance is evaluated at read time, not copied into rows, so switching a project to confidential hides everything under it immediately, and switching it back restores it.
4. After the query, `sanitise(output, scope)` walks every `Ref` in the response (including nested `project`, `person`, `waiting_on` objects) and drops any that are not visible. This is a second check in case a join is wrong.
5. `recordReads(scope, refs, action)` writes one `audit_events` row per item returned (action `read`), and one row per search (action `search`, with the query and result refs in `payload`) (PRD 10, rule 4).
6. `confidential: true` on ingest or `create_task` is stored on insert in the same transaction, so the item is hidden from the moment it exists (acceptance criterion 12).

Ollie's own app routes do not go through the filter; he sees everything, with locks on confidential items.

**Tests** (vitest, run before every milestone sign-off): a confidential project with linked tasks, decisions, notes, facts and activity never appears in any MCP tool, resource, ingest `GET` or Ask retrieval, and search counts are the same as if it did not exist; a grant unlocks it for one client only and expires after one hour; an ingest item flagged confidential is invisible on the next call.

---

## 7. Theme file

`artifacts/ollieos/src/theme/tokens.css` is the only place colours, gradients, radii and font stacks are written. It declares every DESIGN.md token as a CSS custom property and maps them into Tailwind so components use class names, never values.

```css
@theme inline {
  /* shared */
  --color-ink: #1b1d22;        --color-ink-muted: #55524c;   --color-ink-soft: #3d3a35;
  --color-accent: #f4c542;     --color-page: #f4f1ea;        --color-panel: #ffffff;
  --color-line: #e8e5de;       --color-line-soft: #f0ede6;   --color-field: #f1efea;
  --color-control-border: #e3dfd6;  --color-row-hover: #faf8f3;  --color-switch-off: #d6d2c8;
  /* dark surfaces */
  --color-glass: rgba(30,30,32,.66);  --color-glass-quiet: rgba(30,30,32,.5);
  --color-glass-input: rgba(12,12,14,.55);  --color-ok: #8fd18a;
  /* pills: now, backlog, waiting, done, high, neutral, confidential, request banner */
  --color-pill-now-bg: #eef3c7;  --color-pill-now-fg: #4a5410;  … (every row of DESIGN.md 4)
  /* source marks: email, slack, meeting, quarterly, manual */
  --color-src-email-bg: #d9e2f1; --color-src-email-fg: #233455; …
  /* type and shape */
  --font-sans: 'Google Sans', 'DM Sans', system-ui, sans-serif;
  --font-serif: 'Instrument Serif', Georgia, serif;
  --radius-panel: 22px; --radius-card-dark: 20px; --radius-ask: 24px; --radius-card: 16px;
  --radius-button: 10px; --radius-input: 10px; --radius-pill: 6px;
}
:root { --bg-gradient: radial-gradient(…), …; --grain-opacity: .22; --glass-blur: 22px; }
```

Status, priority and source styling is a lookup inside `Pill` and `SourceMark` keyed by value, pointing at these variables. `scripts/src/check-ui-text.ts` fails the check if a hex or `rgb()` colour appears in any other frontend file, or if an em dash appears in UI text.

Dates and times always go through `lib/shared/dates.ts`: long form "Friday 13th November" in prose and headings, short form "Fri 13th Nov" in tables (as the screens do), 24-hour times, Europe/London.

---

## 8. Milestones and how each will be checked

| # | Built | Checked against |
|---|---|---|
| 1 | Database provisioned, full schema, Replit Auth + allowlist, both shells, Home cards with real data, Tasks screen, task detail panel, quick add, `lib/shared`, the 10 seed tasks (question 14) | Criteria 1, 6 (writes), 8 (Home and Tasks at desktop and 375px), 9, 11 |
| 2 | Triage overlay with N/B/W/X and U, undo toast, Waiting on with Chase, Done with weekly copy, Noise tab with restore and rule, "Always ignore items like this", snooze, Stale marker | Criterion 11, keyboard and screen reader pass |
| 3 | Knowledge pages, linking, in-place editing, facts as rows, search, Ask OllieOS with citations, draft and bundle | Criterion 10 (citations, answers only from OllieOS) |
| 4 | Access switches live, inheritance, approval queue and Home banner, AI read log, `ai-data` layer and its tests | Criteria 2, 3, 6 (reads), 10 (confidential), 12 |
| 5 | OAuth, MCP server, all tools and resources, ingest API, cursor, sweep runs, calendar, Today strip and status line, noise rules on ingest | Criteria 2, 4, 5, 7, 12, tested by connecting Claude |
| 6 | Phone Home and Triage, swipe, home screen install (web manifest and icons), Noise clean-up, CSV export, imports, `APP_GUIDE.md` | Criterion 8 on phone, full acceptance run |

At each sign-off I will list every relevant criterion as met or not met, with how it was checked.

Secrets needed: `ALLOWED_EMAIL` at milestone 1, `INBOX_API_KEY` at milestone 5, `ANTHROPIC_API_KEY` at milestone 3 only if you choose your own key (question 2).

---

## 9. Questions

Each has a proposal. Unless you say otherwise I will go with the proposals.

**Stack and setup**

1. **Font conflict.** PRD section 4 says Inter for the interface; PRD section 5 and DESIGN.md say Google Sans with DM Sans as the loaded fallback. *Proposal:* follow DESIGN.md (DM Sans loaded, Google Sans first in the stack), and drop Inter.
2. **Anthropic key.** Replit has a built-in Anthropic connection that needs no API key and is billed to your Replit credits. *Proposal:* use that for Ask OllieOS, so `ANTHROPIC_API_KEY` is not needed. The alternative is your own key, billed to your Anthropic account. Which do you prefer? Model to confirm at milestone 3 (the current Sonnet is the likely choice: fast, good at citing).
3. **Login.** Replit Auth means signing in with your Replit account, and the allowlist checks that account's email. *Proposal:* `ALLOWED_EMAIL` is the email on your personal Replit account. Please confirm that is the address you want.

**Navigation and screens**

4. **People in navigation.** The Home icon rail and PRD 6 include People; the light-page top nav in the screens has only Home, Tasks, Knowledge, Settings; the phone tab bar has Home, Tasks, add, Knowledge, Settings. *Proposal:* add People to the desktop top nav (goes to the People list), keep the phone tab bar exactly as `PhoneHome.dc.html` (People is reached through Knowledge).
5. **Inbox tab.** PRD 7.2 lists tabs All open, Now, Backlog, Waiting on, Done, Noise, but PRD 7.3 says "Inbox tab adds the triage buttons". *Proposal:* add an Inbox tab first, before All open; All open includes Inbox items.
6. **Phone add button.** The centre button links to the Ask screen in the prototype. *Proposal:* it opens a bottom sheet with the same Add a task / Ask OllieOS box as desktop Home, defaulting to Add.

**Tasks behaviour**

7. **Do next ranking.** PRD gives overdue, then High by due date, then Medium by due date. Not covered: which statuses, tasks with no due date, Low, promises. *Proposal:* candidates are `now` tasks and promises that are not snoozed; order is overdue (any priority, oldest first), then High by due date with undated High last, then Medium the same way. Low and `backlog` never appear. The "reason" line is generated from the facts (overdue by N days, due date, linked meeting today, promise date), not by AI, in milestones 1 to 2.
8. **Waiting on age and Promises date.** The data model has no "waiting since" or "date of the source email". *Proposal:* add `waiting_since` (set when a task moves to Waiting) and `captured_at` (from ingest) to `tasks`, as marked in section 3.

**Confidentiality**

9. **What "linked only to a confidential project" means for tasks.** Read literally, a task linked to the Sale process project and also to a visible person stays visible, which could expose, for example, "Send the CIP to [buyer]". *Proposal (stricter):* a task, decision or note inherits confidential if it is linked to any confidential project; it inherits hidden from people and organisations only when every linked entity is hidden. Your per-item override still wins either way.
10. **What an approved request unlocks.** *Proposal:* approving "Sale process" for one hour unlocks the project and everything hidden only because of it (its tasks, decisions, notes, facts, activity), for that client only. Items you marked confidential themselves stay hidden.
11. **ai_access off versus confidential on children.** PRD only describes inheritance for confidential. *Proposal:* children of an entity with AI access off are also hidden, using the same rules as question 9.
12. **Ask OllieOS and confidential items.** Ask is you asking, but it sends data to a model, and criterion 10 says no confidential items without an approved request. *Proposal:* Ask is its own client ("Ask OllieOS"). When a question would have matched hidden items, the answer says "Some confidential items were not used" and offers "Allow for this question", which approves a one-hour grant for Ask only and re-runs. This message is shown only to you in the app, never to external AI tools.
13. **Unmatched access requests.** An AI may ask for an item by a name that does not match exactly. *Proposal:* the request is stored with the name as written; the Home banner lets you pick the matching item or decline. The AI gets the same "sent to Ollie" reply in every case.

**Imports and data**

14. **Seed tasks timing.** Milestone 1 needs real data on Home, but imports are milestone 6. *Proposal:* load the 10 tasks from the Tasks screen at milestone 1 (with their statuses, sources, priorities and due dates as shown), so every review uses real data. At milestone 6 you check them against Notion and I correct any changes. People named on them (Paul Buxton, Emma Duck, Veronica Wilkinson, Kurt Skillen, Ahlam Bennajem) are created as bare people records so Waiting on and For links work; everything else about them comes from the memory import. No projects are created until you approve.
15. **"Import disabled after first use" with two imports.** Tasks (14.1) and knowledge (14.2) are separate imports at different times. *Proposal:* each kind can run once, tracked in `import_runs`; Settings > Imports can re-enable one deliberately.
16. **Activity linked to several people and projects.** `activity` has one `entity_type`/`entity_id`, but `log_activity` records a touchpoint "against people and projects". *Proposal:* one activity row, primary entity in its own columns, the rest in `links`. The Person timeline and Project recent activity read both.
17. **Example content.** The Promises, Waiting on, Today strip, Inbox and Knowledge content in the screens will not be added to the database, as the kickoff prompt says. Until the sweep and memory import run, those cards will show empty states ("No promises logged yet"). Confirm that is what you want during review, rather than temporary sample data.

**Operations**

18. **Scheduled jobs on Autoscale.** Autoscale has no built-in timer for the 90-day Noise clean-up or expiring access grants. *Proposal:* grants expire by checking `expires_at` at read time (nothing to schedule), and the Noise clean-up runs whenever a sweep finishes (twice each weekday).
19. **Revoking the Capture sweep.** It authenticates with `INBOX_API_KEY`, not OAuth. *Proposal:* Revoke makes the ingest API refuse that key until you press Reconnect; to truly replace the key you change the secret.
20. **Quick add details.** *Proposal:* `due:fri` means the next Friday, or today if today is Friday; `@slug` that matches no project shows a warning chip and the task is created without a project (projects are never created from quick add); tasks added by you go to Now unless `#backlog` is used, and tasks with no `!` marker are Medium.
21. **Week picker on Tasks.** *Proposal:* weeks run Monday to Sunday in London time. In open tabs it filters by due date (with a "No date" toggle so undated tasks are not lost); in Done by completion date.
22. **"Bundle into one task" in Ask.** *Proposal:* creates one new task titled from the answer, linked to the same person and project, with the cited tasks listed in its notes; the original tasks move to Done with the note "Bundled into …". Undo is offered in the toast.
