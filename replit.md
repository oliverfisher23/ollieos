# OllieOS

Ollie's private personal operating system for tasks and work knowledge, readable and writable by Claude through a built-in MCP server. Spec: `docs/PRD.md`, `docs/DESIGN.md`, `design/screens/`. Plan: `docs/build-plan.md`.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

- Work milestone by milestone (PRD section 15). After each, report against the acceptance criteria and wait for Ollie's approval before starting the next.
- Never hard-code colours in components; use the theme tokens.
- British English, dates as ordinals ("Friday 13th November"), no em dashes in any interface text.
- Never add a delete tool to the MCP server.
- Keep example content from the screen files out of the real database, except the tasks listed for import in PRD section 14.1.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
