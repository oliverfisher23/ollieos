# OllieOS: Build plan (milestone 0)

| | |
|---|---|
| Based on | `docs/PRD.md` v2.2 (including section 14a), `docs/DESIGN.md`, the nine feature PRDs in `docs/features/`, all sixteen files in `design/screens/` (markup and script blocks) |
| Written | Monday 9th November 2026; updated Tuesday 10th November 2026 for PRD v2.2 |
| Status | Milestones 1 to 5 built. The v2.2 additions (sections 10 and 11) approved by Ollie on Tuesday 10th November 2026 ("agree with all"); milestone 6 in progress |

Sections 1 to 9 are the original plan for PRD v2.1 and describe what is built. **Section 10** adds everything new in PRD v2.2 and the feature PRDs: schema, pages, API routes, MCP tools and which milestone each feature lands in. **Section 11** lists the conflicts with what is already built, and the unclear points, as questions 23 to 50, each with a proposal. If you are happy with a proposal you can just say "agree with 23, 27, 31" (or "agree with all"), and correct the rest.

Where a feature PRD and the main PRD disagree, the feature PRD wins for that feature (PRD 14a).

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
| ~~6~~ | Moved to milestone 9 (see section 10.1) | |
| 6 | **Trust:** Knowledge Inbox, stale and conflicting facts (features 01, 02) | Feature 01 criteria 1 to 5, feature 02 criteria 1 to 5 |
| 7 | **Direction:** goals, relationship cadence, document index, playbooks (features 04 to 07) | Feature 04 to 07 criteria |
| 8 | **Preparation:** meeting briefs, daily digest (features 03, 08) | Feature 03 and 08 criteria |
| 8 follow-on | **Connectors** (section 12), then **Assist** parts A to F (section 13), each signed off on its own | Section 12 and 13 checks |
| 9 | Original milestone 6 (phone Home and Triage, swipe, home screen install, CSV export, imports, `APP_GUIDE.md`) plus voice capture (feature 09) | Criterion 8 on phone, feature 09 criteria, full acceptance run of PRD and all feature PRDs |

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

---

## 10. PRD v2.2 additions

### 10.1 Which milestone each feature lands in

The feature PRDs place features in milestones 3, 4 and 5, which are already built. Rather than reopen those, I propose four new milestones, in the order that respects their dependencies (question 23):

| Milestone | Features | Why this order |
|---|---|---|
| 6 Trust | 01 Knowledge Inbox, 02 Stale and conflicting facts | Claude can already write facts and decisions straight in (built in milestone 5). This changes that to suggestions before Claude is used day to day, which is what PRD 14a intended by placing 01 before the MCP milestone |
| 7 Direction | 04 Goals, 05 Relationship cadence, 06 Document index, 07 Playbooks | All four are knowledge-side and independent of each other. Briefs and the digest need all of them |
| 8 Preparation | 03 Meeting briefs, 08 Daily digest | Both read goals, cadence, documents, playbooks and the Knowledge Inbox count |
| 9 Phone, imports and voice | Original milestone 6, plus 09 Voice capture and the seed playbooks if not seeded earlier (question 45) | Voice needs suggestions (01) and is phone first |

Suggestion kinds for documents, playbooks and cadence (question 25) are added in milestone 7 when those features exist; milestone 6 ships the kinds fact, decision, person, organisation, project and summary_change.

### 10.2 Database schema

New enums and enum values:

```ts
export const suggestionKind   = pgEnum("suggestion_kind", ["fact", "decision", "person", "organisation",
                                  "summary_change",
                                  "project", "document", "playbook", "cadence"]);   // last four: question 25
export const suggestionStatus = pgEnum("suggestion_status", ["pending", "approved", "rejected"]);
export const reviewKind       = pgEnum("review_kind", ["stale", "conflict"]);
export const reviewStatus     = pgEnum("review_status", ["pending", "resolved"]);
export const cadence          = pgEnum("cadence", ["weekly", "fortnightly", "monthly", "two_monthly",
                                  "quarterly", "none"]);
export const projectLifecycle = pgEnum("project_lifecycle", ["active", "paused", "complete"]); // question 38
export const docLocation      = pgEnum("doc_location", ["dropbox", "gdrive", "claude_project", "other"]);
export const factAttribute    = pgEnum("fact_attribute", ["job_title", "organisation", "status",
                                  "next_step", "decision_date"]);                    // question 42
// task_source gains "voice"
// entity_type gains "goal", "document", "playbook", "suggestion", "fact_review", "meeting_brief", "digest"
```

New tables:

```ts
// knowledge.ts (milestone 6)
export const suggestions = pgTable("suggestions", {
  id, kind: suggestionKind().notNull(),
  entityType: entityType("entity_type"), entityId: integer("entity_id"),   // null for a new person or project
  payload: jsonb().notNull(),                      // the proposed record, same shape as the MCP input
  normalisedText: text("normalised_text").notNull(),   // (added) lower-case, trimmed; 30-day duplicate check
  sourceType: text("source_type"),                 // email, meeting, chat, recording, voice
  sourceRef: text("source_ref"), sourceUrl: text("source_url"), sourceQuote: text("source_quote"),
  proposedBy: text("proposed_by").notNull(),       // client name: "Capture sweep", "Claude", "Voice capture"
  clientId: integer("client_id").references(() => aiClients.id),   // (added) for list_my_suggestions
  status: suggestionStatus().notNull().default("pending"),
  resultType: entityType("result_type"), resultId: integer("result_id"),   // (added) what approval created
  decidedAt: timestamp(...), createdAt: …,
}, (t) => [index().on(t.status), index().on(t.entityType, t.entityId), index().on(t.normalisedText)]);

export const factReviews = pgTable("fact_reviews", {
  id, kind: reviewKind().notNull(), factIds: integer("fact_ids").array().notNull(),
  suggestionId: integer("suggestion_id").references(() => suggestions.id),  // (added) conflict raised by a suggestion
  status: reviewStatus().notNull().default("pending"),
  resolution: jsonb(),                             // { action, kept_fact_id?, new_fact_id? }
  createdAt: …, resolvedAt: timestamp(...),
});

// goals.ts (milestone 7)
export const goals = pgTable("goals", {
  id, parentId: integer("parent_id"),              // sub-goals, one level deep
  name: text().notNull(), statement: text(), targetText: text("target_text"),
  periodStart: date("period_start"), periodEnd: date("period_end"),
  confidential: boolean().notNull().default(false),   // hides target_text from AI (question 36)
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: …, updatedAt: …,
});

// library.ts (milestone 7)
export const documents = pgTable("documents", {
  id, title: text().notNull(), url: text().notNull().unique(), location: docLocation().notNull(),
  summary: text(),
  confidential: boolean(),                         // null = inherit from linked projects (question 44)
  lastConfirmedAt: timestamp(...).notNull().defaultNow(),
  createdBy: text("created_by").notNull(), createdAt: …, search: tsvector(title, summary),
});
// Linked to projects through `links` (document to project).

export const playbooks = pgTable("playbooks", {
  id, title: text().notNull(), appliesWhen: text("applies_when").notNull(),
  rule: text().notNull(),                          // check constraint: 400 characters or fewer
  enabled: boolean().notNull().default(true),
  createdAt: …, updatedAt: …,
});
// Linked to projects and organisations through `links`; no links = global.

// briefs.ts (milestone 8)
export const meetingBriefs = pgTable("meeting_briefs", {
  id, calendarEventId: integer("calendar_event_id").notNull().unique()
        .references(() => calendarEvents.id, { onDelete: "cascade" }),
  generatedAt: timestamp(...).notNull(),
  why: jsonb().$type<{ text: string; cited: Ref[] }[]>(),   // null = "Not much on file"
  questions: jsonb().$type<{ text: string; cited: Ref[] }[]>(),
  attendeeIds: integer("attendee_ids").array(), projectIds: integer("project_ids").array(),
  goalIds: integer("goal_ids").array(),             // (added) "Related projects and goals"
  promiseIds: integer("promise_ids").array(), documentIds: integer("document_ids").array(),
  playbookIds: integer("playbook_ids").array(), citedIds: text("cited_ids").array(),
  inputsHash: text("inputs_hash"),                  // (added) skip regeneration when nothing changed
  usedConfidential: boolean("used_confidential").notNull().default(false),
  notes: text(), granolaRef: text("granola_ref"), granolaNotes: text("granola_notes"),
  model: text(),
});

export const digests = pgTable("digests", {
  id, forDate: date("for_date").notNull().unique(), windowStart: timestamp(...).notNull(),
  summary: text(), sections: jsonb().notNull(), emailedAt: timestamp(...), createdAt: …,
});

// settings.ts (milestone 6) (added) one row per setting, there is no settings table today
export const appSettings = pgTable("app_settings", {
  key: text().primaryKey(), value: jsonb().notNull(), updatedAt: …,
});
// Keys: shelf_life_days ({ status: 30, next_step: 30, general: 90, job_title: 365, organisation: 365 }),
// last_stale_check_at, digest_email_enabled, digest_email_time.
```

Changes to existing tables:

| Table | Change | Milestone |
|---|---|---|
| `facts` | `attribute` (fact_attribute, nullable), `last_confirmed_at` (not null, backfilled from `created_at`), `needs_check` (boolean, default false), `approved_at` (backfilled from `created_at`, question 43), `suggestion_id` | 6 |
| `decisions` | `approved_at` (backfilled), `suggestion_id` | 6 |
| `people` | `is_self` boolean (question 41), `cadence` (default `none`), `cadence_paused` boolean. `last_contact_at` becomes a cache kept up to date on every activity insert of kind email, meeting or slack | 6 (`is_self`), 7 |
| `projects` | `goal_id`, `lifecycle` (default `active`, question 38) | 7 |
| `tasks` | `goal_id` (override), `not_goal_work` boolean | 7 |
| `calendar_events` | `attendees` becomes `jsonb` of `{ name, email?, response? }` (accepted, tentative, declined, none), existing text values migrated as `{ name }`; `platform` text (Teams, Zoom, Meet, in person), question 29 | 8 |

### 10.3 Frontend pages

| Route | Page | Screen file | Milestone |
|---|---|---|---|
| `/knowledge/inbox?tab=suggested\|conflicts\|stale` | Knowledge Inbox | `KnowledgeInbox.dc.html` | 6 |
| `/settings/knowledge` | Shelf life per attribute (derived from Settings) | Derived | 6 |
| `/goals` | Goals, unlinked work | `Goals.dc.html` | 7 |
| `/people?tab=all\|overdue\|due-soon\|on-track` | Relationship cadence (question 39) | `People.dc.html` | 7 |
| `/knowledge/library?tab=documents\|playbooks` | Library: documents table, playbook cards, Add a link and New playbook forms | `Library.dc.html` | 7 |
| `/briefs/:eventId`, `/briefs/next` | Meeting brief | `MeetingBrief.dc.html` | 8 |
| `/digest`, `/digest/:date` | Daily digest (today, or a past day within 30 days) | `Digest.dc.html` | 8 |
| `/voice` | Voice capture (phone first; desktop opens the same screen centred) | `PhoneVoice.dc.html` | 9 |

Changes to existing pages:

- **Navigation (question 40):** the rail gets Home, Tasks, People, Goals, Knowledge, with Settings at the bottom; light-page top nav the same. Knowledge's sidebar gains Knowledge Inbox (with count) and Library (Documents, Playbooks).
- **Home:** status line adds "N to review" linking to the Knowledge Inbox (6) and "Today's digest" once it exists (8); "Brief me" goes to the brief (question 28, milestone 8); microphone button in the add box (9).
- **Project page:** goal picker and lifecycle control (7), Documents and Playbooks blocks (7), facts marked "Needs a check" (6).
- **Person page:** cadence and status in the details (7).
- **Tasks:** Do next tie-break by goal link (7); weekly update grouped by goal (question 34).
- **Ask:** includes enabled playbooks that apply, documents in retrieval, and says when it relied on a `needs_check` fact (6 and 7).

### 10.4 App API (session + allowlist)

| Method and path | Purpose | Milestone |
|---|---|---|
| `GET /api/suggestions?tab=` | Cards for one tab, plus the three tab counts | 6 |
| `POST /api/suggestions/:id/approve` | Optional `{ payload }` for "Edit, then approve"; writes the record, `approved_at`, `suggestion_id`, audit | 6 |
| `POST /api/suggestions/:id/reject` | Marks rejected, kept 30 days | 6 |
| `POST /api/fact-reviews/:id/resolve` | `{ action: still_true \| edit \| no_longer_true \| keep, keep_fact_id?, text? }` | 6 |
| `GET/PATCH /api/settings` | Shelf lives (6), digest email (8) | 6 |
| `GET /api/goals`, `POST /api/goals`, `PATCH /api/goals/:id` | Goals with counts, sub-goals, linked projects, unlinked work | 7 |
| `PATCH /api/tasks/:id` | Gains `goalId`, `notGoalWork` | 7 |
| `PATCH /api/projects/:slug` | Gains `goalId`, `lifecycle` | 7 |
| `GET /api/people/cadence?tab=` | Cadence table with counts | 7 |
| `PATCH /api/people/:slug` | Gains `cadence`, `cadencePaused` | 7 |
| `POST /api/people/:slug/check-in-draft` | Draft built from the person page and project, shown only (question 47) | 7 |
| `GET/POST /api/documents`, `PATCH /api/documents/:id` | Documents; POST takes a link and fills title and location | 7 |
| `GET/POST /api/playbooks`, `PATCH /api/playbooks/:id` | Playbooks, including the on/off switch and links | 7 |
| `GET /api/briefs/:eventId`, `GET /api/briefs/next` | Brief, generated on open if missing or more than 3 hours old | 8 |
| `PATCH /api/briefs/:id` | Notes for after | 8 |
| `GET /api/digests/today`, `GET /api/digests/:date` | Digest | 8 |
| `POST /api/voice/transcribe` | Audio in, transcript out; only used when the browser cannot transcribe (question 46). Audio is held in memory for the request and never written to disk | 9 |
| `POST /api/voice/parse` | Transcript in, proposed tasks, promises and facts out | 9 |
| `POST /api/voice/save` | Confirmed items: tasks to Inbox, facts to the Knowledge Inbox | 9 |
| `GET /api/home` | Gains Knowledge Inbox count, digest link and brief ids for today's events | 6, 8 |

### 10.5 Ingest API

| Route | Notes | Milestone |
|---|---|---|
| `POST /api/ingest/suggestions` | Same payload shapes as the MCP writes; max 100. Returns `[{ outcome: "suggested" \| "duplicate" \| "previously_rejected" \| "conflict", suggestion_id? }]`. The 30-day rejected check is done here, server side | 6 |
| `POST /api/ingest/calendar` | Upsert by `source_ref` instead of delete and reinsert; attendees as objects; unmatched names accepted again (questions 29 and 30) | 8 |
| `POST /api/ingest/meeting-notes` | `{ calendar_source_ref, granola_ref, notes, decisions?: [...] }`: attaches Granola notes to the brief, decisions become suggestions (question 31) | 8 |
| `POST /api/ingest/sweep-run` (finish) | Also runs: weekly stale check if due, brief generation, digest build, 30-day clean-ups (question 32) | 6, 8 |

### 10.6 MCP tools and resources

New tools (14 today, 20 after):

| Tool | Input | Output | Milestone |
|---|---|---|---|
| `list_my_suggestions` | `{ status?: "pending" \| "rejected" (default pending); limit? }` | `{ suggestions: { id, kind, entity: {ref, name} \| null, text, status, created_at }[] }`, only this client's, only on visible items | 6 |
| `list_goals` | `{}` | `{ goals: { ref, name, statement, target_text?, sub_goals, projects: {ref, name}[], open_tasks, due_this_week }[] }`. `target_text` omitted when the goal is confidential | 7 |
| `list_overdue_contacts` | `{ include_due_soon?: boolean; limit? }` | `{ people: { ref, name, organisation, cadence, last_contact_at, days_overdue }[] }` | 7 |
| `find_documents` | `{ query: string; project?: EntityPick; limit? }` | `{ documents: { ref, title, url, location, summary, projects, updated_at }[] }` | 7 |
| `get_playbooks` | `{ context?: EntityPick \| "general" }` | `{ playbooks: { ref, title, applies_when, rule }[] }`, enabled only | 7 |
| `get_meeting_brief` | `{ event: string (calendar event ref) \| "next" }` | `{ event: { title, starts_at, platform }, why, attendees, questions, promises, projects, goals, documents, playbooks }`, filtered for the caller (question 48) | 8 |

Changed tools:

| Tool | Change | Milestone |
|---|---|---|
| `add_fact`, `log_decision`, `upsert_person`, `upsert_project` | Return `{ status: "suggested", suggestion_id }` (or `"duplicate"`, `"previously_rejected"`). `add_fact` gains `attribute?`; a clash with a current fact returns `{ status: "conflict", review_id }` (question 24) | 6 |
| `get_context`, `search` | Each fact carries `needs_check`. `get_context` gains `goal` (projects), `cadence` and `cadence_status` (people), `documents` and `playbooks` | 6, 7 |
| `search` | `types` gains `document` | 7 |
| `upsert_calendar` | Same changes as the calendar ingest | 8 |

New resource `ollieos://brief/next` (milestone 8). The server instructions gain: "Before drafting anything on Ollie's behalf, call get_playbooks for the project or person concerned. If a fact is marked needs_check, say so when you rely on it." The no-delete test still runs against the full list.

### 10.7 Confidentiality additions

- **Suggestions:** a suggestion on a hidden item is never returned to any AI client, including the one that proposed it.
- **Goals:** a goal is always visible as a name, statement and linked visible projects; `target_text` is never sent to AI when the goal is confidential.
- **Documents:** hidden if `confidential` is true, or null and any linked project is hidden (same as tasks, question 9).
- **Playbooks:** hidden when every linked item is hidden; global playbooks are always visible when enabled. Paused playbooks are never sent.
- **Briefs, digest summary, check-in drafts and voice parsing** call the Anthropic API, so they run through `ai-data` as the internal "Ask OllieOS" client and share its grants and "Allow for this question" flow (question 47).
- New tests per feature: confidential document absent from `find_documents` and `get_context`; confidential goal target absent from `list_goals`; paused playbook absent everywhere; suggestion on a hidden project absent from `list_my_suggestions`.

### 10.8 Theme

Every colour used in the seven new screens is already in `tokens.css` (the purple, red, amber, grey, green and brown pill pairs), except the phone voice screen's dark base `#16171b`, which is added as a token in milestone 9. No new fonts.

---

## 11. Questions for PRD v2.2

Each has a proposal. Unless you say otherwise I will go with the proposals.

**Order and conflicts with what is built**

23. **Milestone order.** The feature PRDs place features in milestones 3 to 5, which are done. *Proposal:* the four new milestones in section 10.1 (trust, direction, preparation, then phone, imports and voice). Your "start milestone 6" would then mean the Knowledge Inbox and stale facts. The alternative is the feature PRDs' order (goals, cadence, documents and playbooks first, then the Knowledge Inbox), which means Claude keeps writing facts straight in for longer.
24. **MCP writes change behaviour.** In milestone 5, `add_fact`, `log_decision`, `upsert_person` and `upsert_project` write directly, and the milestone 5 tests check that. *Proposal:* they return `{ status: "suggested" }` from milestone 6 and I rewrite those tests; tasks, promises, activity and calendar still go straight in, as feature 01 says.
25. **Suggestion kinds.** Feature 01 lists fact, decision, person, organisation, summary_change, but `upsert_project`, document proposals (06), playbook proposals (07) and suggested cadence (05) also need kinds. *Proposal:* add project, document, playbook and cadence.
26. **Notes and edits to existing records.** Feature 01 doesn't mention `add_note`, or an AI changing an existing person's role or a project's status. *Proposal:* notes stay direct (like activity, they are clearly labelled as written by the AI); any AI change to an existing project, person or organisation becomes a "Changed summary" suggestion (shown as "Changed details" when it isn't the summary).
27. **Who is "Your profile"?** The conflict example is about your own job title, but there is no person record for you. *Proposal:* add `people.is_self`, create your record in milestone 6 (name and email only), and keep it out of the cadence page.
28. **"Brief me" link.** Milestone 5 made "Brief me" open the linked project or person page. *Proposal:* from milestone 8 it opens the brief; events with no brief (personal, or nobody known) keep no link.
29. **Calendar sync breaks briefs.** Each calendar post deletes every event in the 8-day window and reinserts, so event ids change twice a day and past events vanish, which would orphan briefs and Granola notes. Attendees are plain names, but briefs need email and accepted status. *Proposal:* upsert by `source_ref` (ids stay stable), remove only future events no longer in the feed, keep past events for 30 days, and store attendees as `{ name, email, response }` while still accepting plain names.
30. **Calendar rule added by the security fix.** The dependency-fix task (merged this morning) also changed calendar handling in two ways I didn't plan: (a) if any `people` or `project` hint on any event doesn't match a visible record, the whole calendar post is rejected, and (b) AI tools no longer see any event whose title, location or attendees contains the name, slug or email of any hidden item, matched as a substring. (a) will make the sweep fail whenever a new contact is invited, and briefs need unknown attendees ("No previous contact"). (b) can hide unrelated events (a hidden person called "Sam" hides "Samsung review"). *Proposal:* revert (a) to "store the event, report unmatched names", and change (b) to whole-word matches on full names and emails only, keeping the protection it was meant to add. Tests updated to match.
31. **Granola actions.** Feature 03 says the brief "offers" Granola actions as Inbox items, but the sweep already turns Granola actions into Inbox tasks (PRD 18). Doing both would create duplicates. *Proposal:* the sweep keeps sending actions to Inbox as now; the brief shows "3 actions went to your Inbox" with links, and decisions become Knowledge Inbox suggestions.
32. **Scheduled jobs on Autoscale.** *Replaced on 10th November 2026 by the connector timer (section 12): scheduled work now also runs after each OllieOS check, and the app moves to an always-on Reserved VM.* There is no timer for the Sunday stale check, the 30-minute brief, the 07:45 email or the 30-day clean-ups. *Proposal:* all run when a sweep finishes (07:40 and 13:40 weekdays): the stale check runs on the first sweep finish after Sunday 18:00; briefs for today's and tomorrow's work meetings are built at each sweep (so a 9:00 meeting has its brief by 07:45) and refreshed on open after 3 hours; the digest is built on the first sweep of the day; clean-ups run every time.
33. **Digest email.** Sending needs an email service, a key and a timer. *Proposal:* no email in phase 1 (the feature PRD allows this). The footer switch is left out until email is added, rather than shown and not working.
34. **Weekly update grouping.** Built in milestone 2 grouped by project; feature 04 says by goal. *Proposal:* group by goal, with projects as sub-headings, then "Not linked to a goal" last.
35. **Digest window.** "Since 18:00 yesterday" doesn't fit Mondays. *Proposal:* since 18:00 on the previous working day (Friday for Monday), weekdays only.

**Goals and cadence**

36. **Goal data and confidentiality.** *Proposal:* create the three goals named in feature 04 (Growth, Efficiency, Product and market expansion) with blank targets for you to fill in, and no project links until you add them. The statement is visible to AI; the target text is not when the goal is confidential, so numbers belong in the target, not the statement.
37. **Editing goals.** The screen shows goals but no way to add or edit them, or to link a project. *Proposal:* in-place editing on the Goals page (like knowledge pages), a goal picker on each project page, and projects can link to a goal or a sub-goal (counts roll up to the parent).
38. **Paused and complete projects.** Cadence pauses when a project is paused or complete, but `projects.status` is free text ("Proposal sent"). *Proposal:* add a separate `lifecycle` (active, paused, complete) set on the project page; the status pill is unchanged. A person's cadence is paused when all their linked projects are paused or complete, or when you pause it yourself.
39. **Two People lists.** `/people` currently redirects to the full list at `/knowledge/people`; the new People page shows only people with a cadence. *Proposal:* `/people` becomes the cadence page; the full list stays at `/knowledge/people`, reached from Knowledge; person pages keep their addresses.
40. **Navigation on phone.** The nav now has six items, but the phone tab bar has four slots around the add button. *Proposal:* phone bar is Home, Tasks, add, People, Knowledge; Goals and Settings are links at the top of Knowledge on phone. Long press on add opens voice capture.
41. **"N of M open tasks support a goal this week".** *Proposal:* M is open tasks in Now plus any open task due this week; N is those with a goal, directly or through their project.

**Knowledge, documents and playbooks**

42. **Fact attributes.** *Proposal:* a fixed list (job_title, organisation, status, next_step, decision_date), blank for general facts. When you add a fact in the app with the same attribute as a current one, yours supersedes it straight away (your edits apply immediately) instead of raising a conflict.
43. **Existing facts and decisions.** *Proposal:* rows already in the database are treated as approved (`approved_at` = when they were created) and their `last_confirmed_at` is their creation date.
44. **Document confidentiality.** Feature 06 has a plain flag but also says a document linked to a confidential project is confidential. *Proposal:* nullable like tasks: blank inherits from linked projects, on is always hidden. Title from a pasted link uses the file name in the URL, since OllieOS can't open private Dropbox or Drive files; you can edit it.
45. **Seed playbooks.** Feature 07 names six seed playbooks, and the Library screen has wording for each. *Proposal:* create those six with the screen's wording in milestone 7, so they are useful straight away, and you edit them. If you'd rather write them from your Claude memory export, they move to the milestone 9 import.
46. **Voice transcription.** *Proposal:* the browser's own speech recognition where it exists (Safari on iPhone, Chrome), falling back to OpenAI speech-to-text through Replit's built-in connection (no key of your own, billed to Replit credits). Parsing sends only your transcript to Anthropic; matching names to projects and people happens in OllieOS afterwards, so no OllieOS data goes to the model.
47. **Which AI client runs briefs, the digest summary and check-in drafts.** *Proposal:* all run as "Ask OllieOS", so they share one set of grants and the same "Allow for this question" button when confidential items would help.
48. **Claude reading a brief.** A brief built with an approved grant may mention items Claude can't see. *Proposal:* `get_meeting_brief` drops any sentence or question whose citations include an item hidden from the caller, and any hidden attendee, promise, project or document.
49. **Cadence suggestions from the sweep.** *Proposal:* the sweep may suggest a cadence only for people it has just suggested or who have no cadence; it never changes one you set.
50. **30-day retention.** Rejected suggestions and digests are kept 30 days. *Proposal:* both are cleaned up when a sweep finishes, alongside the Noise clean-up. Briefs are kept as long as their calendar event (30 days, question 29).

## 12. Connectors (milestone 8 follow-on, agreed 10th November 2026)

Goal: OllieOS reads Ollie's services itself and stops relying on the Claude sweep. Each part is its own milestone with sign-off.

| Part | Services | How |
|---|---|---|
| A (built) | Google Calendar | Replit Google Calendar integration, read with `@replit/connectors-sdk`. No AI |
| B (built) | Gmail, Slack | Replit Gmail and Slack integrations, read-only; sorted by `claude-haiku-5-5` through Replit AI Integrations |
| C (built) | Google Drive, Granola | Replit Google Drive and Granola integrations, read-only; matched and sorted by `claude-haiku-5-5` |

- **Data:** `connector_runs` (one row per check, kept 30 days); app_settings `connectors` holds the schedule and who reads each service.
- **Who reads a service:** Ollie's choice wins. A service OllieOS can read moves to OllieOS automatically after its first good check. While OllieOS reads it, the matching ingest route and MCP tool answer `{ignored: true}`.
- **Timer:** checked every minute in the API server; runs at the chosen interval (30 or 60 minutes) on weekdays inside the window (default 07:00 to 19:00 London). Each run is claimed in the database first so two instances never double-run. After the checks, `scheduledWork` builds briefs, the digest (from 07:40) and clean-ups.
- **API:** `GET /api/connectors`, `PATCH /api/connectors/schedule`, `PATCH /api/connectors/:key` (`{readBy}`), `POST /api/connectors/:key/check`.
- **Part B details:** cursors live in app_settings `connector_state_gmail` (`{after}`, the newest message read) and `connector_state_slack` (`{since, convs: {id: {ts, active, checked}}}`), saved only after everything read has been captured, so a failed check is read again. Gmail messages in the same thread form one exchange. Slack has no search for this connection (`search:read` is not granted, and `assistant.search.context` results may not be stored), so it reads `conversations.history`: conversations with a message in the last 14 days every check, quiet DMs every 2 hours (30 a check), quiet group DMs and channels 40 a check, at about one call a second with a 90-second budget. Channels only keep messages that @mention Ollie. Items go through `captureTask` (source_ref `gmail:<id>` or `slack:<channel>:<ts>`, `#2` for a second item from the same message) with actor `ollieos`; `/api/ingest/tasks` and `/api/ingest/activity` answer `ignored` for email or Slack while OllieOS reads that service. Confidential projects are never sent to the sorter.
- **Part C details (Drive):** state in `connector_state_drive` (`{since, judged}`). Each check (a) re-reads the text of Library documents whose link is a Drive file, only when the file's `modifiedTime` is newer than the last read (up to 40 a check, oldest read first): Docs and Slides exported as text, Sheets as CSV (first sheet), 60,000 characters kept in `document_contents`; a generic title from the link ("Google Doc") becomes the file's name, and `last_confirmed_at` moves to the file's modified time; and (b) lists files Ollie opened since `since` (`viewedByMeTime`, all drives, 60 newest; never more than 14 days back), leaves out pictures, video, folders and files already in the Library or judged before, and sends up to 25 (name, kind, folder, owner, first 2,500 characters) to Haiku with the active non-confidential project names. A file that clearly belongs to one becomes a `document` suggestion (proposed by "OllieOS", source_type `document`, payload `confidential: true` when Haiku flags it, which hides the suggestion from AI and makes the approved document confidential). With no projects, nothing is judged and the cursor stays put. Contents go to the AI with the document (first 4,000 characters, only when the document is visible), and Library and Ask search match words inside them.
- **Part C details (Granola):** Granola is read with a Personal API key saved as the `GRANOLA_API_KEY` secret, sent straight to `https://public-api.granola.ai` (the Replit Granola connector could not be set up as a personal connection); without the secret it falls back to the connector. state in `connector_state_granola` (`{after, done}`): notes updated after `after`, each read once (remembered 45 days). Only notes Ollie owns, or where his address (from the Calendar and Gmail accounts, and ALLOWED_EMAIL) is an attendee or invitee, are used. Haiku returns up to five items (task, promise, waiting), up to three decisions and a summary per note. Items go through `captureTask` (source `meeting`, source_ref `granola:<note id>`, `#n` for more, no noise rules), the project defaulting to the calendar event's; decisions become Knowledge Inbox suggestions on the named project, the summary's project or the event's; the notes are attached to the meeting's brief when Granola's `calendar_event_id` matches a calendar row's source_ref. Granola only moves to OllieOS automatically after a check that found one of Ollie's own meetings, so a key that only sees colleagues' notes never switches Claude off. While OllieOS reads it, `/api/ingest/meeting-notes` and meeting items in `/api/ingest/tasks` and `/api/ingest/activity` are ignored.
- **Page:** Settings → Connectors, first in the list. `/settings/ai-access` and `/settings/sweep` redirect there.
- **Publishing:** deployment must be a Reserved VM so the timer keeps running; connections must also be set for the published app in Publishing settings.


---

## 13. Assist (milestone 8 follow-on, agreed 10th November 2026)

Goal: OllieOS does more of the work around email, meetings and knowledge, and keeps a full record of Claude Cowork sessions. Comes before milestone 9. Each part is its own sign-off, in this order.

| Part | Features | Size |
|---|---|---|
| A | Dropped status; "Probably noise" in the Inbox; Draft reply saved as a Gmail draft | Medium |
| B | Meetings page in the navigation with all research and prep | Small to medium |
| C | Look back at Granola: decisions over 6 months, actions over the last month | Medium to large |
| C2 | Internal or external meetings, and the research agent on outside companies (added 10th November 2026) | Medium |
| D | No reply yet: sent emails from the last 6 months that got no answer | Medium |
| E | Build knowledge from Google documents, pasted text, uploads and Claude artifacts | Medium |
| F | Cowork sessions library and knowledge taken from it | Medium |

### Part A: Dropped, noise and email drafts

- **Dropped status.** New `dropped` task status: "this was real, but I've decided not to do it". Differs from Noise, which means it should never have come in and teaches rules. Dropped tab on Tasks, a Dropped button and the D key in triage and on Inbox rows, in the status dropdowns, with Undo and Restore. Left out of counts, Do next, Waiting on, the digest and stale checks. MCP and Ask treat it as closed (AI can set it through `update_task`).
- **Probably noise.** When the sorter is unsure, it marks an email or Slack item as likely noise with a short reason, rather than leaving it as a normal Inbox item. The Inbox shows these as a separate group, each with the reason. Ollie can move them all to Noise in one go, keep one, or make a rule from one.
- **Draft reply.** Email tasks get "Draft reply". It reads the whole Gmail thread, what OllieOS knows about the people and organisation, open promises, and playbooks. It writes a draft (Ask's model) that Ollie can edit, then "Save to Gmail" makes a draft in that thread (Gmail `drafts.create` with the thread id; the connection already has compose permission). OllieOS never sends. The draft opens in Gmail from a link. Writes go into the AI read log as usual; confidential items are held back the same way as Ask.
- **Checked by:** dropping and restoring a task by button, key and dropdown; counts and Do next leave it out; Claude sees it as closed; a known newsletter lands in Probably noise with a reason and "Move all to Noise" clears the group; a draft appears in the right Gmail thread and nothing is sent.

### Part B: Meetings page

- **Meetings** in the icon rail (desktop) between Tasks and People, at `/meetings`. On a phone it is reached from Home's Today strip and a link on the Tasks page, since the bottom bar is full.
- List of work meetings for today, tomorrow and the rest of the week, each showing who is coming and how ready it is (brief written, open promises, items waiting on them). Past meetings for the last 2 weeks underneath, with their Granola notes.
- Each meeting opens its prep page (the current brief, extended): why it matters, who is in the room with their facts and cadence, the last Granola notes with the same people, recent email and Slack threads with them, open tasks and promises both ways, documents, playbook watch-outs, a suggested agenda and questions, and the notes-for-after box.
- **Checked by:** Meetings visible in the navigation on every page; every work meeting this week listed with its prep; a meeting with a past Granola note shows it; phone layout at 375px.

### Part C: Look back at Granola

- A one-off **Look back** run, started from Settings → Connectors → Granola, choosing the range (defaults: decisions 6 months, actions 1 month). It runs in the background in batches with a progress bar and can be stopped and resumed. It reads only meetings Ollie was in.
- **Decisions** go to the Knowledge Inbox as suggestions, marked "From look back" with a filter, where Ollie approves or rejects them as today. Ones OllieOS already has are left out.
- **Actions** go to a new **Review** page, not the Inbox, so 4 weeks of actions do not flood it. Each one shows the meeting, date, who owns it and the line it came from. Buttons: Now, Backlog, Waiting on (with the person), Already done, Dropped. Bulk select for each. Actions that already match a task are left out.
- **Data:** `review_items` (kind, source ref, meeting, text, owner, suggested project and person, state pending, accepted, done or dropped, the task it became). The dedupe uses source refs and a close-title check against open tasks.
- **Checked by:** a look back over a real month finds the meetings, puts decisions in the Knowledge Inbox with no duplicates, actions on Review; each button does what it says; running it again adds nothing new.
- **Built (10th November 2026):** state in app_settings `granola_look_back` (range, the list of note ids to read and how far through, counts, a heartbeat); every note read is remembered in `granola_look_back_seen`, so a rerun reads nothing twice. The run lists notes with `created_after` (newest first, 30 a page), then reads and sorts one note at a time with the same Haiku prompt as the regular check, saving after each. Stop takes effect after the note in hand; a run cut short by a restart shows as stopped (no heartbeat for 3 minutes) and is resumed by hand. Five notes in a row that cannot be sorted stop it as failed. Decisions are proposed by "Granola look back"; actions only from meetings inside the actions range, skipped when the regular check already captured that meeting, when a review item has the same ref, or when the title closely matches a task from the last 400 days or a review item (`services/similar.ts`). Now, Backlog and Waiting on make the task through `captureTask` with the item's source ref; Already done and Dropped make no task.
- **Change agreed while building:** a decision no longer has to belong to a project (Ollie: "this might not always be the case"). `decisions.project_id` is optional; a decision with no project is readable by AI unless marked confidential or linked to a hidden project. In the Knowledge Inbox a decision that matched no project shows what it looks to be about and can be filed under a project, a new project, or none. New decision and the decision page allow No project.

### Part C2: Internal or external, and the research agent (asked for 10th November 2026)

- **Internal or External** on every meeting (Meetings list and prep page). Ollie's company is the domain of his own addresses plus the email domains of people at an organisation marked internal. An attendee is external when at a non-internal organisation or on any other domain; personal addresses (Gmail and the like, `FREE_MAIL`) count as external but are not a company. Attendees with no address and no organisation do not count. The pill names the outside companies (organisation name when known, else the email domain). A stranger from a company domain is now enough for a prep page; a personal address alone is not.
- **Research agent** (`company_research`, one row per company email domain). Web research with `claude-sonnet-5-5` and Claude's web search (up to 10 searches): what they do, facts with sources, news from the last 12 months, the people coming, angles worth raising given what Ollie's company does. It also reads his Gmail threads with anyone at that domain from the last 6 months (up to 12 threads, last 6 messages each, 30k characters) for where things stand and open asks both ways. Shown on the prep page ("Research on the company") and on the organisation's page, with sources, the date, searches and threads, and Research again. It never writes knowledge.
- **When it runs:** automatically after each check for external meetings in the next 7 days, up to 3 companies a time, one after another; research is reused for 30 days; a failure waits 6 hours before an automatic retry. Companies where the organisation or anyone there is confidential are only researched when Ollie asks. On demand from the button, or on an organisation page with nobody's email on file by typing the website or domain. Personal email providers and Ollie's own company are refused.
- **Cost (measured 10th November 2026):** one company took 5 searches, about 87,000 input tokens and 3,000 output tokens, roughly 25p to 45p a company depending on how many searches it makes. Reused for 30 days.
- **Checked by:** tests for scope, on-demand and automatic research, confidential skipping, 30-day reuse, failures and retries; a real run on a real external meeting; screenshots of Meetings, prep page and organisation page.

### Part D: No reply yet

- Reads Gmail sent mail for the last 6 months: threads where Ollie wrote last and nobody has answered since. Leaves out automated and bulk mail, replies to newsletters, and threads he closed himself ("thanks", "no need to reply"). AI then checks each one for whether he asked for something or expected an answer, and why.
- Shows on the Review page under a **No reply yet** tab, newest first, grouped by person, with the ask in one line. Buttons: **Chase** (makes a Waiting on task with the person, with the chase line, and optionally a Gmail draft in the thread from Part A), **Already handled**, **Dropped**.
- Refreshed on each Gmail check after the first run, so new unanswered emails older than 3 working days appear without another full run.
- **Checked by:** a known unanswered email appears with the right ask; one that was answered does not; Chase makes a Waiting on task and an optional draft; Dropped and Already handled keep it off the list.
- **Built (10th November 2026):** started once from the No reply yet tab ("Look through sent email"); runs in the background in chunks of 20 threads with a progress bar, Stop and Resume (state in app_settings `gmail_no_reply_scan`, the same pattern as the Granola look back). Each thread is first read as headers only. Left out before AI: someone else wrote last (out-of-office and automatic replies do not count as an answer), bulk or mailing list mail in the thread, every recipient an automated address, calendar replies, mail only to himself, and a last message that is a short thank-you. Emails younger than 3 working days (Monday to Friday) are watched and looked at once old enough. What is left is read in full (the last message and two before it) and checked by Haiku in batches: does it expect an answer, the ask, why, a chase line, the person, the line it came from. Found ones are `review_items` of kind `no_reply` (ref `gmail:<message id>`, with thread, email address and reason). A thread that is already a Waiting on task is left out, and every email checked is remembered (`gmail_no_reply_memory`), so a rerun checks nothing twice.
- **Keeping it up to date:** after the first run, each Gmail check reads only threads with new sent mail, threads on the list or being watched that changed, and watched threads now old enough. A reply closes the item as answered; a newer email from Ollie in the same thread replaces the older item. A problem there never fails the Gmail check.
- **Chase** makes a Waiting on task (source email, the chase line as the next step, linked to the thread, waiting on the person, who can be changed) with its own ref (`#chase`), so it never clashes with a task the regular Gmail check made from the same email. "Write a chase email" then drafts a follow-up straight away on the Review page with the Part A draft feature: when Ollie wrote last in a thread, the draft is a short nudge rather than a reply. Now and Backlog are refused for these items. Bulk select works for Chase, Already handled and Dropped.
- **Email page (added 10th November 2026, at Ollie's request):** one page at `/email` (in the desktop menu after Tasks; on phones a link by the Tasks heading) with three tabs. **To answer**: open email tasks still with Ollie (Inbox, Now, Backlog), newest first, with Draft reply or Edit draft in place, Done and Open task. **Drafts**: every reply and chase draft not yet gone (`GET /email/drafts`), with Edit, Open in Gmail, Done (takes it off the list, the draft stays on the task) and Open task. A draft leaves the list when its task closes, when Ollie marks it done, or when a Gmail check sees an email sent in its thread after the draft was written or last saved (`reply_drafts.sent_at`; writing a new draft puts it back). **No reply yet** moved here from Review unchanged. Review is now only actions from the Granola look back; `/review?tab=no-reply` redirects. Tasks stay the record; the page is a view of them. Nothing is sent.
- **Email page as a light email client (10th November 2026, at Ollie's request):** To answer and Drafts show a list of emails (sender or recipient, subject, first line, date, Now/Backlog/Draft labels) beside a reading pane; on phones the list and the email are shown one at a time. The pane reads the Gmail thread behind the task (`GET /tasks/{id}/thread`, read only, older messages folded) and shows what OllieOS made of it (the task, its next step). Actions: Reply (opens the draft below the thread), Done (then the next email), **Noise** (moves it to Noise; the pane then offers the usual "ignore emails like this" rules and Undo; Gmail itself cannot be marked as spam because OllieOS has no permission to change mail), Open in Gmail. Drafting takes Ollie's steer: "What should it say?" before the first draft, and "Ask for changes" afterwards, which revises the current wording rather than starting again (`instructions` and `current` on the write call).

### Part E: Knowledge from documents

- **Build knowledge from this** on any Library document, and from a pasted Google Doc link or Drive folder. OllieOS reads the text (Drive already can) and proposes facts, decisions, people, organisations and project links into the Knowledge Inbox, each citing the document.
- **Add to the Library** also takes pasted text and uploaded Markdown, Word and PDF files, stored with the document.
- **Claude artifacts:** they cannot be fetched from claude.ai, so Claude gets a new MCP tool `save_document` (title, content, kind, optional project). From any Claude chat or Cowork session: "save this to OllieOS". It lands in the Library as a document marked "From Claude" and goes through the same knowledge step. Approval-only like other AI proposals.
- **Claude's Dropbox folder (agreed 10th November 2026):** Ollie's Claude memory and context lives in a Dropbox folder holding instructions and preferences, notes Claude saves itself, project and people context, and session notes and artifacts. OllieOS connects to Dropbox (already authorised on Replit) and reads that folder **read-only** on each check, like Drive. New and changed files go through the same knowledge step: facts, decisions, people and project updates become Knowledge Inbox suggestions citing the file; standing rules become playbook suggestions; nothing is written without approval. OllieOS never writes into the folder, since Claude already gets OllieOS context live through `get_context`, which respects confidential and AI access settings. Session notes found there also feed Part F.
- **Checked by:** a Drive document and a pasted artifact each produce suggestions that cite them; approving writes facts; a folder adds each of its documents once; a changed file in the Dropbox folder produces suggestions for only what changed.
- **Built (10th November 2026):** every read waits in `knowledge_sources` (one row per Library document or Dropbox file) and is done in the background by two workers, Library documents first, claimed in the database so two instances never read the same thing; reads cut short by a restart are tried again. Each read goes to Claude Sonnet with what OllieOS already knows (projects, people, organisations), and what it finds goes through the usual approval-only proposals, proposed by "Document reader", citing the document (`document:<id>`) or Dropbox file (`dropbox:<path>`). A file read before only sends the lines that were added (with the line before each); nothing added means no AI call. A confidential document, or one about a company sale, the board, pay or HR, only brings decisions, marked confidential. Facts about someone not yet known wait until that person or organisation is approved; a known person only gets fields OllieOS does not have. Documents hidden from AI are never read.
- **Library:** "Add a document" has Link (a Drive folder link adds up to 100 readable files, not subfolders, once each), Paste text and Upload a file (Markdown, text, Word, PDF) tabs, with "Build knowledge from this" on by default. Pasted, uploaded and Claude-saved documents have no link and live "Kept in OllieOS". Each document shows its knowledge status (waiting, reading, what it found, or the problem) and the button.
- **Knowledge Inbox:** a "From documents" filter, a "From a document" label, and "Reject everything from this document" for a document that brought too much.
- **Claude:** MCP tool `save_document` proposes a document; approving adds it to the Library with its text and reads it.
- **Dropbox (Settings, Connectors):** Ollie chooses the folder (with a count of readable files first) and whether to read everything once or only new and changed files from now on. Files are never added to the Library. Progress, "Try the failed ones again", Check now and recent runs are on the card. Deleted files are forgotten; what was approved from them stays. Cost is roughly 2p a file read; Ollie's chosen folder (/Cowork/Springpod, 870 readable files) is about £16 to read once, and its Sale Process files come through as confidential decisions only. Checked in development on 3 real files from that folder. Approved by Ollie on 10th November 2026.

### Part F: Cowork sessions library

- **Sessions page** under Knowledge (`/knowledge/sessions`): every Cowork session with its date, title, summary, what was done, decisions, tasks created, documents produced and the projects and people it touched. Searchable, and part of Ask and search.
- **Going forward:** new MCP tool `save_session` (title, summary, transcript or key parts, outcomes, artifacts). The OllieOS server instructions and a ready-made block for Cowork's instructions tell Claude to call `get_context` at the start of a session and `save_session` at the end. Artifacts in it go through Part E.
- **Knowledge:** each saved session is read for facts, decisions, people and project updates, which go to the Knowledge Inbox citing the session; tasks and promises go to the Inbox. Kept relevant: facts from sessions use the existing stale and conflicting fact checks, and a session older than 90 days with nothing linked to it is marked archived (kept, but left out of briefs).
- **Earlier sessions:** imported from Claude's data export file (Settings → Privacy → Export data), uploaded in Settings. Whether Cowork sessions are in that export needs checking with a real export before this part starts; if they are not, only sessions from now on can be kept. Session notes already in Claude's Dropbox folder (Part E) are a second source for earlier sessions.
- **Checked by:** a Cowork session ends with `save_session` and shows on Sessions with its outcomes; its decisions reach the Knowledge Inbox; Ask can answer from it; an uploaded export adds past sessions once.
- **Built (10th November 2026), sessions from now on only:** importing earlier sessions from Claude's export is left for later. Claude's `save_session` (title, summary, outcomes, transcript, projects, people, actions, artifacts, confidential, and its own session id so saving again updates the same session) keeps the session straight away. Its actions go to the Inbox as tasks or promises marked Cowork, once each; its artifacts are proposed for the Library (Part E); and the session is read for knowledge in the background by the Part E reader, citing the session, so the "From documents" filter and "Reject everything from this session" work for it. The server instructions and a copyable "Instructions for Cowork" block (Settings, Connectors) tell Claude to call `get_context` at the start and `save_session` at the end.
- **Visibility:** a session is hidden from AI if it is marked confidential, or if any project or person it touched is hidden, unless Ollie sets it to Always readable. Hidden sessions are never read for knowledge.
- **Archived:** older than 90 days with no open task or promise from it. Archived sessions stay on Sessions (under "Show archived sessions") and in search, but are left out of `get_context` and meeting briefs.
- **Where they show:** Knowledge, Sessions (search, each session's summary, what was done, projects and people, tasks, approved decisions and documents, knowledge status, transcript, AI access, delete); knowledge search and Claude's `search`; Ask; `get_context` for a project or person (latest 5); briefs cite them. Checked in development with one real read, which proposed two decisions and a new person from a placeholder session. Approved by Ollie on 10th November 2026.

### Part G: Knowledge graph (asked for 10th November 2026, approved 10th November 2026)

Ollie asked for a graph of everything in OllieOS that Claude, ChatGPT and Gemini can all use, plus a visual map inside OllieOS. No export file.

- **What is in it:** people, organisations, projects, goals, decisions, documents, meetings, tasks and promises, and Cowork sessions are the points. Facts and notes are not separate points; they belong to the person, organisation or project they describe and come with it.
- **How things connect, two kinds:**
  - *Worked out from what OllieOS already holds*, always up to date, nothing to approve: works at (person to organisation), on (task or promise to project), about (task or promise to person), decided in (decision to project), met (meeting to person), touched (session to project or person), about (document to project), towards (project to goal).
  - *Stated relationships* (new): the existing links between items gain a label from a short list (reports to, works with, advises, introduced by, investor in, customer of, supplier to, partner of, competitor of, part of, depends on, blocked by, related to) and an optional note. Ollie can add, change or remove them on any person, organisation or project page. AI-proposed ones (from email, meetings, documents, sessions and Claude) go to the Knowledge Inbox like every other piece of knowledge and cite where they came from.
- **Live connection for AIs:** three new MCP tools on the existing OllieOS connector:
  - `explore` (an item, one or two steps out, optionally only some relationship types): what is connected to it and how, with the evidence for each link.
  - `find_connection` (two items): how they are connected, up to three steps.
  - `propose_relationship` (write permission): goes to the Knowledge Inbox.
  - Plus `fetch` (read one item in full), which ChatGPT expects next to `search`.
  - Confidential and hidden items are left out completely, and so are links that pass through them; the AI only learns that something is hidden, and can ask for access as now.
- **Connecting ChatGPT and Gemini:** the existing sign-in and approval screen works for any AI that supports MCP connectors, so each AI is its own connection with its own read or write permission, listed on Settings, AI access. Settings, Connectors gets short setup steps for each. ChatGPT needs Developer mode (writing needs a Business, Enterprise or Edu plan). Gemini needs Gemini Enterprise (custom MCP servers, pre-release) or Gemini CLI; the everyday Gemini app does not take custom connectors yet.
- **Visual map** (Knowledge, Map, `/knowledge/map`): choose a starting point by search, or open "See on map" from any person, organisation, project or session. It sits in the middle with what connects to it around it, coloured by type, with links labelled. Click a point to move to it, or open its page. Filters for types and relationships, one or two steps out, and a whole-picture view capped at the 300 most connected points. Hidden items show as hidden to Ollie, as elsewhere. On a phone it shows the connections as a grouped list instead, since a map is unreadable at that size. Drawn with d3-force in SVG so it uses the colour tokens and works with a keyboard.
- **Not included:** an export file; reading back over old email, meetings and documents to find relationships (only new reads propose them, and the "worked out" links cover what is already there).
- **Checked by:** a person shows "works at" their organisation on the map without any approval; a stated relationship added by Ollie and one approved from the Knowledge Inbox both show with their labels; ChatGPT and Claude can each connect and answer "how is X connected to Y"; a confidential project and anything only reachable through it never reach an AI.
- **Built (10th November 2026):**
  - *Stated relationships:* each pair of people, organisations or projects holds one relationship, read "from <relationship> to" with the other end showing the reverse ("reports to" and "manages"). Setting one replaces whatever link was there. Removing one from a project keeps the person or organisation on the project. A "Relationships" section with Add and Remove sits on every person, organisation and project page, with "See on map".
  - *Proposed relationships:* Claude's `propose_relationship`, the sweep (`/ingest/suggestions` kind "relationship") and the document and session reader (up to 4 a read, known items only) all send them to the Knowledge Inbox as "Relationship" cards with the evidence as an editable note. Approving sets it with its source. Proposing one that already exists answers "duplicate".
  - *MCP tools:* `explore`, `find_connection` and `fetch` for reading, and `propose_relationship` for writing. Every item returned is logged as read. Hidden items are never returned or followed, so nothing reachable only through them reaches an AI; `explore` says how many were left out.
  - *Map:* Knowledge, Map. Whole picture (people, organisations, projects and goals, up to 300) or centred on one item, one or two steps out, with type filters, "Only relationships you stated", a list view, zoom and pan, and "How is X connected to…" which picks out the path on the map. Hidden items show dashed and are not followed, so Ollie's map matches what AI can reach. Phones get the grouped list. "See on map" also on sessions.
  - *ChatGPT and Gemini:* steps on Settings, Connectors under "Connecting ChatGPT or Gemini". OpenAI's help lists custom connectors for Business, Enterprise and Edu, so the ChatGPT steps are written for "if your plan has Developer mode". The Gemini app cannot connect; Gemini CLI can.
  - *Left out:* filtering the map by single relationship types (AI tools can), and reading old email and meetings for relationships.
  - Checked with one real read, which proposed the three relationships a placeholder update stated plainly (supplier, investor, reports to) and nothing else.

### Part H: Strategy and ideas (asked for 10th November 2026)

Ollie asked for a Strategy page for context about his strategy, plus brainstorms and ideas to come back to. Choices made: strategy in sections he names, Claude reads both and can add ideas, ideas come back on Home and in the morning digest.

- **Where:** Strategy in the main menu between Goals and Knowledge (`/strategy`). The phone menu is full, so on a phone it opens from a link on Goals and from Home.
- **Strategy, in sections:** Ollie adds sections and names them himself (for example "Where we play", "How we win", "What we won't do"). Each holds text edited in place, shows when it was last changed, can be reordered, renamed or deleted (with Undo), and can link to the goals and projects it drives. Starts empty with a short prompt, no example sections.
- **Ideas and brainstorms:** a quick box to jot one down (a title, and notes that can hold a whole brainstorm). Each idea is:
  - *New*
  - *Come back to*, with a date
  - *Taken forward*, turned into a task or project in one click and linked to it
  - *Dropped*

  Tabs for each, newest first, searchable, with an optional link to a goal or project. Shows who added it (Ollie, Claude or a Cowork session).
- **Coming back:** on its date, a "come back to" idea shows on Home ("Ideas to come back to") and in that morning's digest, until Ollie moves it on, picks a new date or drops it.
- **Claude and other connected AIs:**
  - New read tool `get_strategy` returns the sections and open ideas. Strategy and ideas are also part of `search`, `fetch` and Ask.
  - New write tool `add_idea` puts an idea straight onto the list as New, marked "From Claude", like tasks. It is not knowledge, so it does not go through the Knowledge Inbox. Claude cannot edit or delete sections or ideas.
  - Each section and idea has the usual AI access and confidential switches. Hidden ones, and ideas linked to a hidden project or goal, never reach an AI.
  - The Cowork instructions mention `add_idea` for ideas that come up in a session.
- **Not included:** strategy and ideas on the knowledge map; version history of sections; reading email, meetings or documents for ideas.
- **Checked by:**
  - A section added, edited and reordered keeps its order and shows its last change.
  - An idea set to come back today shows on Home and in the digest.
  - Taking an idea forward creates the task or project and links back to it.
  - Claude's `add_idea` lands as New, marked From Claude.
  - A confidential section or idea never reaches Claude.
- **Built (10th November 2026):** a Strategy page at `/strategy`, in the rail between Goals and Knowledge; on phones it opens from Home (a "Strategy and ideas" card) and from Goals. Sections are added by name, edited in place, moved up and down, linked to goals and projects, and deleted with Undo (kept for a week, then gone). Each shows when it last changed. Ideas have a quick add box with optional notes, tabs for New, Come back to (with a due count), Taken forward and Dropped, and search. Come back to needs a day (quick picks for a week, a month or 3 months, or any date); from that day the idea shows on Home ("Ideas to come back to") and in the morning digest until it is moved, re-dated or dropped. Take forward makes a Backlog task (notes, project and goal carried over) or a project (notes as its summary, goal linked) and the idea links to it. Each idea shows who added it: Ollie, Claude or a Cowork session.
  - Claude: `get_strategy` (sections in order, plus new and come-back-to ideas with their dates) and `add_idea` (title, notes, goal, project, from_session; lands as New and is marked as Claude's, skipping the Knowledge Inbox). Strategy and ideas are in `search`, `fetch` and Ask. Claude cannot change or delete either. The Cowork instructions mention both tools, so the block needs pasting into Cowork again.
  - Who can read what: a section or idea is hidden from AI when it is confidential, has AI access off, or is linked to a hidden project (or, for an idea, became a hidden task or project). Goals never hide anything, because goal names are always readable by AI and only their targets are confidential. Neither has approvals of its own: approving a project opens what it hides.

## 14. Working better: tasks, email, meetings, documents and playbooks (asked for 10th November 2026)

Ollie chose these from a list of improvements. Agreed with Ollie on 10th November 2026: briefed drafts and meeting follow-ups are saved to Gmail automatically once written (never sent); follow-up drafts only for external meetings; Backlog tasks are never archived automatically, only by Ollie. Four parts, each its own sign-off, in this order. Email comes before Meetings because the meeting follow-up uses the writing style, and Playbooks comes last because it learns from changes to drafts.

| Part | Features | Size |
|---|---|---|
| I | Repeating tasks, checklists in a task, Archive and the Backlog clear-out, plan my day | Medium to large |
| J | Email in three tabs (To answer, Drafts from a brief, Waiting for a reply), drafts in your writing style, thread summaries, attachments into the Library | Large |
| K | "Next time I see…" points, follow-up draft after a meeting, prep reminder | Medium |
| L | Search all of Drive from the Library; rules learned from your edits, checking a draft, where each rule was used, Run this playbook (renamed by Part M, section 15) | Medium to large |

### Part I: Tasks

- **Repeating tasks.** Any task can repeat: every day, every weekday, every week (on a chosen day), every 2 weeks, every month (on a date, or for example the first Monday), every quarter or every year. When it is ticked off, the next one is made straight away in the Backlog with the next due date, keeping the project, person, goal, notes and checklist (unticked). If it was ticked off late, the next date is the first one still to come, so missed ones do not pile up. "Stop repeating" ends it. A small repeat mark shows on lists and cards. Dropping or archiving a repeating task asks whether to stop the repeats too. Claude sees "repeats monthly" on a task but cannot set repeats.
- **Checklists in a task.** Steps inside a task: add, tick, reorder, rename and delete. Lists and cards show "2 of 5". Ticking the last step asks "Mark the task done?" rather than doing it. Claude sees the steps and can include steps when it captures a task.
- **Archive.** A new Archived status meaning "keep, but not now", different from Dropped ("decided not to do it"). Archived tasks leave counts, Do next, Waiting on, the digest and stale checks, have their own Archive tab, stay searchable, and Restore puts them back in the Backlog. Available in the task panel, status dropdowns and the clear-out. Claude treats archived tasks as closed.
- **Backlog clear-out.** A task counts as untouched when nothing about it has changed for 30 days. Every other Monday, Home and the digest show "Clear out your Backlog: N untouched". It opens a one-at-a-time screen like triage with Keep (not asked again for 30 days), Do next, Archive, Drop and Done, each with a key. It can also be started any time from the Backlog tab. Nothing is archived without Ollie choosing it.
- **Plan my day.** On Home, "Plan today" suggests up to 5 tasks (overdue, due today, Now, high priority, promises due); Ollie picks 3 to 5 and can add others. Each gets a length (15 minutes, 30 minutes, 1 hour, 2 hours; 30 minutes unless changed) and OllieOS fits them into the gaps between today's meetings within working hours (9:00 to 18:00 by default, changeable in Settings). "Today's plan" on Home shows meetings and tasks in time order, with tasks ticked off in place. Anything not done is offered for tomorrow's plan the next morning. Nothing is written to Google Calendar. On a phone it is the same list.
- **Checked by:** a monthly task ticked off late makes one next task with the right date; a checklist shows its progress and asks before completing; an archived task disappears from counts and Do next and comes back with Restore; the clear-out offers only tasks untouched for 30 days and Keep resets them; a plan with three tasks fits around two meetings without overlapping.
- **Built (10th November 2026):** repeat rules are stored on the task (`repeat`), and ticking one off makes the next copy in the same step (`repeat_next_id` stops a second copy if it is ticked, unticked and ticked again). Dropping or archiving stops the repeats; the toast offers Keep repeating, and the rule stays on the closed task without making copies. Steps are stored on the task (`steps`), unticked on each new copy. Archived is a new status with its own tab; Restore puts it in the Backlog. The clear-out runs on alternate Mondays from 9th November 2026, Keep counts as touching the task, and Not this time hides it until the next clear-out Monday; it is also started from the Backlog tab at `/clear-out`. Plan my day saves one row a day in `day_plans` (task, length, start), fits tasks in pick order from the later of the start of working hours and now (rounded to the next quarter hour), skips events of 20 hours or more, keeps ticked tasks where they were, and Fit again refits the rest. Unfinished tasks from the last plan in the past week are offered first the next day. Working hours are in Settings, Planning.

### Part J: Email

- **Three tabs on the Email page:**
  - **To answer:** emails waiting on Ollie that have no brief yet, newest first. Each has **Brief a reply**: one line ("Say yes to Thursday, ask for the agenda first") and the email moves straight to Drafts while the draft is written in the background, so several can be briefed in a row. Reply (write it now), Done and Noise stay.
  - **Drafts:** emails Ollie has briefed, and meeting follow-ups (Part K). Each shows Writing, Ready to look at, or Saved to Gmail. Edit, Ask for changes, Save to Gmail, Open in Gmail, Done. When a Gmail check sees the email has been sent, it leaves Drafts, and if it asked for something it moves to Waiting for a reply.
  - **Waiting for a reply:** everything Ollie sent that expects an answer, in one list, newest sent first, each with the person's name (Ollie asked on 10th November 2026; it was grouped by person, oldest wait first): what No reply yet finds in sent mail, sent drafts that asked for something, and new sent emails as they go (see below). Each shows the ask in one line and a "reply expected by" date. Chase, Already handled, Dropped and Change date. A reply closes it on its own, as now.
- **Expect a reply.** Today a sent email only appears after 3 working days. Instead it appears as soon as a Gmail check sees it, with "reply expected by" set 3 working days later (changeable), and turns due on that day. Emails that need no answer are still left out by the same check as No reply yet.
- **Drafts that sound like you.** A one-off read of up to 200 of Ollie's sent emails from the last 6 months (no automatic, bulk or very short ones) writes a "How you write" note: greetings, sign-offs, length, tone, phrases he uses and ones he never uses. It is shown in Settings, Email, where he can edit it, and every draft OllieOS writes (replies, chases, follow-ups) uses it. "Read again" refreshes it. Cost under 50p a read.
- **Thread summaries.** When the reading pane opens a thread of 4 or more messages, a short summary at the top says where things stand and what is being asked of Ollie. Kept until a new message arrives. Under 1p each.
- **Attachments into the Library.** The reading pane lists a thread's attachments. PDF, Word and text files under 10 MB have "Save to Library": kept in OllieOS, read for knowledge as in Part E, citing the email. Confidential when the email's task is confidential.
- **Not included:** sending email; changing anything in Gmail apart from drafts.
- **Checked by:** briefing three emails in a row produces three drafts in Drafts; a sent draft that asked a question appears in Waiting for a reply and closes when answered; a new sent email appears straight away with its expected date; the "How you write" note is used in a draft; a long thread shows a summary; a PDF attachment lands in the Library and brings suggestions.
- **Built (10th November 2026):** Brief a reply keeps the line on the draft (`reply_drafts.brief`, `state` writing, ready or failed) and two in-process writers draft it with the usual reply prompt, then save it to the Gmail thread as a draft (never sent); a restart leaves a draft that never finished showing as failed after 10 minutes, with Try again. An email with a draft on Drafts leaves To answer. Drafts are grouped Writing (failed ones too), Ready to look at and Saved to Gmail; Done on a reply marks the email task done, a chase keeps Remove from Drafts. When a Gmail check sees a reply sent in the thread, the draft leaves Drafts and the email task is marked done. Every Gmail check now judges new sent email straight away (even before the one-off look through has been run, it reads the last day), and each found email gets `review_items.expected_by`, 3 working days after it was sent; the tab count is how many are due. "How you write" is kept in app_settings `writing_style` (Sonnet reads up to 200 sent emails of 25 words or more from the last 6 months, about 1,500 characters each, leaving out automatic, bulk, invite and forwarded ones) and goes to every reply, chase and check-in draft. Thread summaries are Haiku, kept in `thread_summaries` by thread with the last message id, reading at most 24,000 characters (newest messages first), and never for emails hidden from AI. Saved attachments are Library documents with no link and their text kept with origin `email` (`gmail:<thread>/<message>/<part>`), linked to the task's project and confidential when it is, and queued for the Part E reader, which cites the email thread.
- **To answer is the Gmail inbox (10th November 2026, at Ollie's request):** To answer lists every email in Ollie's Gmail inbox, read or unread, whose last message is not from him (`GET /email/inbox`, newest 200 inbox threads, thread details kept in memory until Gmail's history id changes). Emails he sent, emails he has replied to, and emails archived in Gmail or Superhuman are not on it. Newsletters, mailing lists, automatic emails and calendar invites are left out (Ollie chose this), with a count under the list. Reading an email adds nothing to Tasks: an email only becomes a task (status Now, "Reply to <sender>: <subject>") when Ollie briefs, replies or saves an attachment (`POST /email/inbox/{threadId}/task`); emails the Gmail check already made a task for are linked to it, and Noise shows only for those. Done (`POST /email/inbox/{threadId}/done`, kept in app_settings `email_inbox_done` by thread and newest message id) takes it off until a new message arrives, marks a linked task done, and has Undo; Gmail itself is untouched. Closing a linked task elsewhere also takes it off until a new message.
- **Email page improvements (10th November 2026, at Ollie's request):** To answer opens at once from the last look at Gmail (kept in memory and in app_settings `email_inbox_snapshot`); when that is over 45 seconds old the list is shown as it is and Gmail is looked at again in the background (the page asks every few seconds while `updating`, else every minute; a failed look keeps the old list and says so). Gmail "slow down" and 5xx answers are retried up to three times. Haiku reads each new inbox email once (up to 40 at a time, last 3 messages, 1,500 characters each) and sorts it into **Needs a reply** or **For your information**, with a one-line "what they want" shown in place of the first line (kept in app_settings `email_inbox_asks` by thread and newest message; read again when a new message arrives). Emails with anyone hidden from AI, or with no readable text, are not read and sit under Needs a reply. The tab count is Needs a reply only. The Gmail check no longer makes "waiting on" tasks from emails Ollie sends, since those are on Waiting for a reply (promises from his sent email still become tasks); the two such tasks already in his Inbox were dropped.

### Part K: Meetings

- **"Next time I see…" points.** On every person page, a list of points to raise next time. Points can also be added from a meeting's prep page and by Claude (new write tool `add_talking_point`). They appear at the top of the suggested agenda of the next meeting that person is in, and in the brief Claude can read. When the Granola notes for that meeting arrive, OllieOS marks each point Covered or Not covered; covered ones move to a "Raised" history with the date, the rest carry over to the next meeting. Ollie can tick or untick by hand.
- **Follow-up draft after a meeting.** When the Granola notes for a meeting arrive, OllieOS drafts a recap in Ollie's writing style: thanks, what was decided, who does what by when, and the next step, addressed to the people who were there. It lands in Email, Drafts as "Meeting follow-up" and on the meeting's page, ready to edit and save to Gmail. Never sent.
- **Prep reminder.** The 07:45 digest lists today's external meetings whose prep page Ollie has not opened yet, and the Today strip on Home marks them "Not prepped". Opening the prep page clears it.
- **Checked by:** a point added for a person shows on the next meeting's agenda and is marked covered from the notes; Granola notes for a meeting produce one follow-up draft; an unopened external meeting appears in the digest and clears once its prep page is opened.

### Part L: Documents and playbooks

- **Search all of Drive.** "Add a document" in the Library gets a Search Drive tab: search every Drive file Ollie can open, by name and contents, showing owner, type and last change, and add one with one click (read for knowledge as in Part E). Read only.
- **Playbooks learned from your edits.** OllieOS keeps what it drafted and what Ollie changed: when he edits a draft in OllieOS, and when a Gmail check finds the sent email differs from the saved draft (so edits made in Gmail or Superhuman count too). Once a week, AI looks for the same kind of change made 3 or more times and proposes a playbook rule in the Knowledge Inbox, showing the examples. Nothing becomes a rule without approval.
- **Check a draft against my playbooks.** A Check button on every draft lists the rules it breaks, with the line and a suggested fix, and "Fix these" rewrites only those lines. Claude gets a read tool `check_draft` to do the same for drafts written in a chat or Cowork.
- **Where each playbook was used.** Each playbook shows how often it was used and when last, across drafts, briefs, Ask and Claude, with the last 10 uses linked. Playbooks not used in 90 days are marked so they can be paused or deleted.
- **Playbooks that make tasks.** A playbook can hold a list of steps, each with an optional "days after starting" and Now or Backlog. "Run this playbook" on a person, organisation or project page (or on the playbook) makes the tasks, linked to that item, with their dates. Ollie chooses separate tasks or one task with a checklist (Part I).
- **Checked by:** a Drive search finds a file not in the Library and adds it; the same edit made three times produces one proposed rule with its examples; a draft breaking a rule is flagged and fixed; using a playbook in a draft shows on its usage; running a playbook on a project makes its tasks with the right dates.

## 15. Rules, playbooks and products (asked for 10th November 2026)

Ollie asked where information about products and processes lives. Today neither has a home: product information sits only in Library documents, the Knowledge Inbox can only attach facts to a person, project or organisation, and processes turn up as decisions or notes with the steps lost. The current "playbooks" are one-line "always or never" instructions, so they are really rules. Agreed with Ollie on 10th November 2026: today's playbooks become **Rules**, **Playbooks** become processes, and **Products** get their own section. One part, its own sign-off, built next (before Part K), since Part L builds on rules and playbooks.

| Part | Features | Size |
|---|---|---|
| M | Playbooks renamed Rules; Playbooks as processes with steps; Products section with facts, rules, documents and projects | Large |

### Part M: Rules, playbooks and products

- **Rules (today's playbooks, renamed).**
  - Works exactly as now: a title, when it applies, the rule (400 characters at most), on or off, and links to the projects, people and organisations it is for (and now products). No links means it applies everywhere. Every draft, brief, Ask answer and connected AI follows the rules that apply.
  - Renamed everywhere: the Library tab, project pages, "Rule watch-outs" on briefs, Knowledge Inbox cards, AI access settings. The six existing rules are kept as they are, with their links and on or off setting, in development and production.
  - Claude: a new tool `get_rules`. `get_playbooks` keeps answering with the same rules for now, so connected AIs that still use it do not break. The Cowork instructions change, so the block needs pasting into Cowork again.
  - The document and session reader, the sweep and Claude propose "Rule" cards as now.
- **Playbooks (new meaning: how something is done).**
  - Each playbook has a title, when to use it (for example "A new university partner signs"), what it is for in one line, an owner (a person), and steps in order. Each step has its text, an optional person who does it, and an optional "days after starting". It also has free notes, links to projects, organisations, products and documents, a state (Draft, In use, Retired) and when it was last checked.
  - Where: Library gets three tabs: Documents, Rules, Playbooks. Each playbook has its own page (`/knowledge/playbooks/:id`) with steps added, edited, reordered and removed in place, and shows on the pages of what it links to.
  - From AI: the document and session reader, the sweep and Claude (new write tool `propose_playbook`) can propose a new playbook, or a change to an existing one (a step added or changed, a new owner). Each proposal goes to the Knowledge Inbox as a "Playbook" card with where it came from, showing the change against the current steps. Nothing changes without approval.
  - For AI: playbooks that are In use are in `search`, `fetch` and Ask, and a new read tool `get_playbook` returns one in full. Meeting briefs list In use playbooks linked to the meeting's projects and organisations. Usual AI access and confidential switches.
- **Products (new section in Knowledge).**
  - Knowledge, Products (`/knowledge/products`), next to Projects, People and Organisations. Ollie adds products himself; it starts empty, with no examples.
  - Each product page has: name, a one-line description, state (Live, Pilot, In development, Retired), owner, and a summary edited in place. It also lists:
    - Facts, with the same "still true?" checks as other facts.
    - Rules linked to it, shown as "What to say and not say", with Add a rule from the page.
    - Linked documents, projects, organisations (for example the customers using it), playbooks and decisions.
    - Relationships, and "See on map".
  - Knowledge Inbox: facts can be about a product, and AI can propose a product it finds that OllieOS does not know yet, as a "Product" card. The reader, the sweep and Claude only attach facts to products that already exist or are proposed in the same read.
  - For AI: products are in `search`, `fetch`, `explore` and Ask, and are points on the knowledge map. A meeting brief includes products linked to the meeting's projects and organisations, with their rules. Each product has AI access and confidential switches; a hidden product hides its facts.
- **Not included:** pricing tables or product versions; turning existing decisions or notes into playbooks automatically (only new reads propose them, or Ollie can use "Read again" on a document); making tasks from a playbook's steps (stays in Part L as "Run this playbook").
- **Changes to Part L:** "Playbooks learned from your edits", "Check a draft against my playbooks" and "Where each playbook was used" become rules learned from edits, checking a draft against your rules, and where each rule was used. "Playbooks that make tasks" becomes "Run this playbook", using the playbook's steps and their "days after starting".
- **Checked by:**
  - The six existing rules show under Rules unchanged and still shape a draft; `get_playbooks` and `get_rules` both return them.
  - A playbook with five steps is added, reordered and linked to a project, and shows on that project's page.
  - A document describing a process produces a "Playbook" card; approving it creates the playbook with its source.
  - A product with two facts and a linked rule shows them on its page, and a brief for a meeting with a linked organisation includes the product and its rule.
  - A confidential product, and its facts, never reach Claude.
- **Built (10th November 2026):**
  - Rules live in a new `rules` table. A start-up step (guarded by app_settings `migrated_part_m_rules`) copies the old `playbooks` rows across with the same ids, empties the old table and turns every "playbook" reference (links, facts, notes, activity, audit, suggestions, brief and Ask citations, digests) into "rule", in one transaction. It never runs once a process playbook exists. Publishing changes the schema; this step moves the data when the app starts.
  - Playbooks are `process_playbooks`: steps kept on the row as an ordered list with their own ids (text, person, days after starting). Confidential is on, off or "follows its links" (hidden when any linked project or product is hidden). Only In use playbooks reach AI. A new playbook made in the app starts as Draft; one approved from the Knowledge Inbox starts In use. Approving a change counts as a check; an AI-proposed change never changes links.
  - Products are a full knowledge item (`products`) with facts, notes, links, relationships and the map, AI access and confidential switches, and no one-hour access grants. A product's rules apply on projects and organisations linked to it, in the app, for Claude and in briefs.
  - Knowledge Inbox: "Playbook", "Playbook change" (steps marked new, changed or removed, with what each was) and "Product" cards. The document and session reader proposes them (at most 2 playbooks and 3 products a read), and only knows playbooks that are In use and not confidential.
  - Claude: `get_rules` (with a product option), `get_playbooks` kept as the old name, `get_playbook`, `propose_playbook`, `propose_product`. The Cowork instructions mention the new tools, so the block needs pasting into Cowork again.

## 16. Knowledge you can trust (asked for 11th November 2026)

Ollie shared a diagram of how OllieOS should work: sources are read, claims are checked against what is already approved and against who has the say, Ollie approves, and the result reaches every AI. Compared with what is built, the flow is right but three parts are thin: Slack and Gmail only make tasks, not knowledge; a person is matched by one email and nothing records who decides what; and only two facts of the same kind about the same thing are caught as a conflict. Agreed with Ollie on 11th November 2026: the "owner confirms" invite loop stays out for now, so OllieOS stays a one-person app and Ollie's approval is the only confirmation. Two parts, each its own sign-off, built before Part K (Ollie chose this on 11th November 2026). N comes first because the contradiction check in O weighs claims by who said them. Ollie agreed the weekly round-up as written: Fridays at 16:00, with confidential items left out of the version to forward.

| Part | Features | Size |
|---|---|---|
| N | Who's who (several emails and a Slack account per person, merge two people, who decides), who said each claim, knowledge from Slack and Gmail, Merge in the Knowledge Inbox | Medium to large |
| O | Contradiction check across every source, context packs for Claude Projects, weekly round-up to forward | Large |

### Part N: Who's who, and knowledge from Slack and Gmail

- **One person across every tool.**
  - A person can have several email addresses and a Slack account. Gmail, Calendar, Granola and Slack all match on any of them, so the same person is found wherever they turn up.
  - Merge two people: everything on one (facts, decisions, notes, tasks, links, relationships, meetings, emails) moves to the other, and the merged one is removed. The person page offers "Same person as…", and a short "Possible duplicates" list shows people with the same name or a matching email.
- **Who decides.** A project, product or organisation can name the people who decide on it (for example "Sam Lee decides on Atlas launch"), shown on its page and editable there. Claude can read it, and the brief shows it beside each person in the room. Ollie decides everywhere unless he names someone else.
- **Who said it.** Every Knowledge Inbox card shows who said the claim and when (a known person where one matches, otherwise the name as written), next to where it came from. This applies to every source: Granola, documents, Claude sessions, the sweep and now Slack and Gmail.
- **Knowledge from Slack and Gmail.** The Slack and Gmail checks already read each new exchange with AI to find tasks. The same read now also picks out firm decisions and facts about people, projects, organisations and products OllieOS already knows, and proposes them as cards citing the message. Small talk, questions and maybes are left out. Messages hidden from AI, Noise and newsletters are never read for knowledge. It adds very little cost, since it is the same AI read.
- **Merge in the Knowledge Inbox.** Beside Approve and Reject, "Same as existing" picks an approved decision, fact or rule that already says this. The existing item counts as checked today and keeps the card's source as a second source, so nothing is added twice.
- **Not included:** other people confirming anything (the invite loop); reading Slack channels Ollie is not in; Slack search (the connection does not allow it).
- **Checked by:**
  - A person with two email addresses is matched from an email to either address, and from Slack.
  - Merging two people moves a fact, a task and a meeting onto the one kept.
  - "Sam Lee decides on Atlas launch" shows on the project page and in a brief with Sam in the room.
  - A Slack message stating a decision about a known project produces a Decision card that says who said it, citing the message.
  - "Same as existing" on a card marks the approved fact as checked and adds no new fact.

### Part O: Contradictions, context packs and the weekly round-up

- **Contradiction check across every source.**
  - Every new card, from any source, is checked by AI against the approved decisions, facts and rules about the same people, projects, organisations and products. A card that disagrees shows "Contradicts" with the approved item, who said each and when. It goes to the Conflicts tab, which already handles conflicting facts.
  - Each side is weighed. A claim is stronger when the person who said it decides on that area (Part N) and when it is newer. The card says which side looks stronger and why in one line, for example "Stronger: Sam decides on Atlas launch, and this is three weeks newer". Ollie still chooses: "New one is right" (the old item is kept in history as replaced), "Old one stands" (the card is rejected), or "Both are true".
  - Going stale: when an approved item is contradicted by a newer source, it shows "May be out of date" on its page and in Needs a check until Ollie decides. Claude is told the item is in question.
  - Hidden items are never sent to the AI for this check, so a claim about something hidden is only checked against what AI may see.
  - Cost: about 1p a card.
- **Context packs.** "Download for Claude" on project, product and organisation pages makes one file, ready to add to a Claude Project. It holds the summary, current facts, decisions, the rules that apply, playbooks in use, linked documents (titles and links) and who decides, each with its date and source. It only includes what AI may see; anything confidential or hidden is left out, and the page says how many items were left out. It is a copy as of the day it was made, and the file says so.
- **Weekly round-up.** Every Friday at 16:00 (changeable in Settings), a round-up at `/digest/week`. It covers what was approved this week, contradictions found and how each was settled, what went stale, and new rules, playbooks and products. "Save as Gmail draft" makes a draft with no one addressed, ready to forward (never sent). The draft leaves out anything confidential or hidden from AI; the page itself shows everything.
- **Not included:** the invite loop; sending the round-up; context packs that update themselves inside Claude (a pack is a copy, and the Claude connection stays the live route).
- **Checked by:**
  - A Gmail message saying a project's launch moved to March, against an approved fact saying February, appears under Conflicts with both dates, who said each, and which looks stronger.
  - Choosing "New one is right" replaces the fact and keeps the old one in history.
  - The contradicted fact shows "May be out of date" until Ollie decides.
  - A context pack for a project includes its facts, decisions and rules, and leaves out a confidential decision.
  - The weekly round-up lists the week's approvals and the conflict, and its Gmail draft leaves out a confidential item.
