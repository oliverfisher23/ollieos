# OllieOS

Ollie's private personal operating system for tasks and work knowledge, readable and writable by Claude through a built-in MCP server. Spec: `docs/PRD.md`, `docs/DESIGN.md`, `design/screens/`. Plan: `docs/build-plan.md`.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/scripts run seed-tasks` — seed the 10 starting tasks and their people (runs once per database)
- Required env: `DATABASE_URL`; secret `ALLOWED_EMAIL` (the only email allowed to sign in; if unset, nobody can)

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

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

- Work milestone by milestone (PRD section 15). After each, report against the acceptance criteria and wait for Ollie's approval before starting the next.
- Never hard-code colours in components; use the theme tokens.
- British English, dates as ordinals ("Friday 13th November"), no em dashes in any interface text.
- Never add a delete tool to the MCP server.
- Keep example content from the screen files out of the real database, except the tasks listed for import in PRD section 14.1.

## Gotchas

- OllieOS component CSS in `index.css` sits in `@layer components` so Tailwind utilities like `hidden sm:flex` can override it.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
