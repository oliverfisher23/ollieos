---
name: Diagnosing failed publishes at the promote step
description: What to check when the build succeeds but the deployment "failed to initialize"; tool quirks and how to rule out the schema migration
---

The first Reserved VM publish (10th November 2026) built cleanly, then failed with the generic "failed to initialize due to a configuration or code error". Neither log reader showed any runtime output for that revision. The cause was not found in the project.

**Why:** a promote failure with zero runtime logs means the app probably never started. Checking the project rules it in or out quickly, so the next step is a retry or Replit support rather than code changes.

**How to apply:**
- `getDeploymentLogs` takes ISO strings and a `revisionId` (the build id). `fetchDeploymentLogs` takes Unix ms and only sees the currently serving build.
- To rule out the app: run `artifacts/api-server/dist/index.mjs` with `NODE_ENV=production`, a spare `PORT` and `OLLIEOS_CONNECTOR_TIMER=off`, then curl `/api/healthz`.
- To rule out the publish-time schema diff: create a scratch database, push the schema from the last "Published your App" commit into it (that matches production), then run `explainSchemaDiff().statementsToExecute` in one transaction. Drop the scratch database afterwards. Never leave a copied `lib/db` in the workspace, because pnpm would see a duplicate `@workspace/db`.
- The production database only changes when Ollie publishes, so it can be many milestones behind dev.
