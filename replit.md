# OllieOS

Ollie's private personal operating system for tasks and work knowledge, readable and writable by Claude through a built-in MCP server. Spec: `docs/PRD.md`, `docs/DESIGN.md`, `design/screens/`. Plan: `docs/build-plan.md`.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — vitest for the AI access rules; rebuilds a throwaway `ollieos_test` database each run, never touches the real one
- `pnpm --filter @workspace/scripts run seed-tasks` — seed the 10 starting tasks and their people (runs once per database)
- Required env: `DATABASE_URL`; secrets `ALLOWED_EMAIL` (the only email allowed to sign in; if unset, nobody can), `SESSION_SECRET` (also signs OAuth consent requests), `INBOX_API_KEY` (bearer key for `/api/ingest/*`; ingest answers 503 until it is set)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- DB schema: `lib/db/src/schema/` (all PRD tables, full-text `search` columns are generated)
- API contract: `lib/api-spec/openapi.yaml`; server routes in `artifacts/api-server/src/routes`, logic in `src/services`
- Shared dates, labels and quick-add parser: `lib/shared` (all dates go through it, London time)
- Theme: `artifacts/ollieos/src/theme/tokens.css` is the only file with colour values

## Architecture decisions

- Single user: Replit Auth plus an allowlist. A non-allowlisted login gets no session and lands on `/not-authorised`; `requireOllie` guards every data route (401/403).
- Every write records an `audit_events` row in the same transaction; task history is built from those rows.
- Do next ranking: overdue first, then High by due date, then Medium; undated last; snoozed skipped; Low only when overdue.
- Undo restores the `previous` snapshot stored on the latest audit event (1 hour window). A follow-up triage to the same status (adding a Noise rule, changing the Waiting person) reuses the earlier snapshot, so one Undo goes back to Inbox and removes a rule it created.
- Noise rules only apply to new items at capture time; Restore moves an item from Noise back to Inbox.
- All task state changes in the web app go through `useTaskActions()` so cache invalidation and Undo toasts stay consistent.
- Every AI read goes through `lib/ai-data` with an `AiScope` (client, actor, live grants). Confidential or aiAccess off means hidden; tasks, decisions and notes with confidential null follow their parent, true always hides, false always shows. Every item handed to an AI writes one `read` audit row, grouped by a batch id.
- Access grants are approved `access_requests` rows that last 1 hour and expire at read time (nothing scheduled). A grant applies only to the requesting client; a project/person/organisation grant also opens children hidden only by inheritance. AI tools always get the same `REQUEST_REPLY`, whether or not the item exists.
- Ask OllieOS is its own AI client (`ai_clients` row, auth internal). Its "Allow for this question" grants the held-back items to Ask only, then re-answers the turn. Ollie's own views use no grants.
- Knowledge writes in the web app go through `useKnowledgeWrite()` (`src/lib/knowledge.ts`), which refreshes every Knowledge query plus the task caches.
- Facts are never edited in place; replacing one supersedes it and keeps the history.
- MCP server at `POST /mcp` (stateless, JSON responses) with OAuth 2.1: discovery at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, endpoints under `/api/oauth/*` (dynamic registration, public clients, PKCE S256 only). Consent is the web page `/oauth/consent?req=` behind Ollie's sign-in. Access tokens last 1 hour, refresh tokens 30 days and rotate on use; a failed code or refresh attempt still spends it.
- `src/mcp/` and `src/routes/ingest/` never import the database (boundary test): reads go through `lib/ai-data` (visible items only; hidden ones answer `not_found`), writes through `services/aiWrites`. Ingest acts as the "Capture sweep" client with actor `ingest`; the AI log shows the client name.
- Capture dedupes on source + source_ref through the `capture_log` unique index, so the same item sent twice, even at once, makes one task. Noise rules apply only when no status is given and never to meeting items. A confidential item is saved but the reply never names it or returns its id.
- Revoke on a connected tool cuts it off at once (tokens revoked, ingest key refused with 403). Reconnect lets the sweep back in; an OAuth tool must go through consent again. Ask OllieOS cannot be revoked.
- Ask OllieOS uses Anthropic `claude-sonnet-5-5` through Replit AI Integrations (no own key, billed to Replit credits); structured output via `output_config.format` json_schema, no temperature, forced tool_choice is rejected.

## Product

- Home: add tasks, Do next, Inbox count with "Triage N", Waiting on with chase lines, Done this week with weekly update copy.
- Triage at `/triage` (keys N/B/W/X, U to undo); Inbox tab has row triage and J/K/N/B/W/X/E keys.
- Tasks tabs, task detail with history, Noise tab with Restore, Stale marker on Backlog.
- Settings: Noise rules with hit counts and on/off switches; AI access (stats, request queue with item picker for unmatched names, open approvals with End now, connected tools with Revoke/Reconnect and the connector address, "What AI looked at" log); Capture sweep (last clean run, key status, what it reads, last runs). Imports and Export are placeholders.
- Home Today strip comes from the sweep's calendar; the Next meeting has Brief me, linking to its project or else its first person.
- Home status line shows the newest AI access request with Allow 1 hour / Decline, or the live approval.
- Knowledge at `/knowledge/*`: projects (summary, facts, decisions, open tasks, people, activity, AI access panel), people (`/knowledge/people`, owe lists, timeline, Ask Claude prompt copy), organisations, decisions and notes, with search and in-place editing. `/people` redirects there.
- Ask OllieOS at `/ask` and `/ask/:id` (dark shell): cited answers, draft a reply, bundle into one task with Undo, follow-ups. Home's Ask mode opens `/ask?q=`.

## User preferences

- Work milestone by milestone (PRD section 15). After each, report against the acceptance criteria and wait for Ollie's approval before starting the next.
- Never hard-code colours in components; use the theme tokens.
- The icon rail (desktop) and bottom bar (phone) appear on every page, in both the dark and light shells (`components/main-nav.tsx`).
- British English, dates as ordinals ("Friday 13th November"), no em dashes in any interface text.
- Never add a delete tool to the MCP server.
- Keep example content from the screen files out of the real database, except the tasks listed for import in PRD section 14.1.

## Gotchas

- OllieOS component CSS in `index.css` sits in `@layer components` so Tailwind utilities like `hidden sm:flex` can override it.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
