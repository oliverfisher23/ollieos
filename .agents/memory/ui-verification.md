---
name: Verifying signed-in screens
description: How to screenshot or click through OllieOS screens that sit behind the allowlisted login
---
The screenshot tool and testing browser cannot sign in as Ollie, so signed-in screens cannot be checked the normal way.

**Why:** the API refuses every email except ALLOWED_EMAIL, and the capture browser has no session.

**How to apply:** run a second API instance on another port with a test ALLOWED_EMAIL, insert a test row in `sessions` with that email, then drive Chromium (`/repl/tools/bin/chromium`, Playwright from `/mnt/pid2/node_modules/playwright`) against localhost:80 and route `**/api/**` to the test instance with `Authorization: Bearer <sid>`. Run the test server with run_in_background (plain `&` dies with the shell). Delete test tasks, their audit rows and the test sessions afterwards, since example content must not stay in the database.

The test session's `sess.user` must include `lastName` and `profileImageUrl` (null is fine) or `/api/auth/user` fails its response schema with a 500 and the app never gets past the splash. Note the max `audit_events` id before testing so the test rows can be deleted afterwards.

Task lists render both a table (desktop) and cards (phone) with the same testids, so scope Playwright locators to `table` or a row. Grant `clipboard-read`/`clipboard-write` on the context to check copy buttons.

Better option since the AI access milestone: point the test API instance at the `ollieos_test` database (`DATABASE_URL` with the db name swapped) and seed it by SQL, so Ollie's real data is untouched while he uses the app. Vitest leaves the last test's rows in that database, so truncate or account for them before seeding. Drop `ollieos_test` afterwards.


For the OAuth consent page, get a real signed `req` by calling `/api/oauth/register` then `/api/oauth/authorize` on the test instance and reading the `Location` header. After clicking Approve the browser follows a redirect to a dead loopback address; wait about a second before the next `goto` or Playwright reports an interrupted navigation.

Seeding without tsx (not installed): insert the `sessions` row with psql, and also a `users` row for the test email, or Ollie's own person record ("Your profile") is never created. Start the test API from the built `dist/index.mjs` with `INBOX_API_KEY` set so `/api/ingest/suggestions` can seed the Knowledge Inbox. Stale facts need `last_confirmed_at` pushed back by SQL, then `POST /api/settings/knowledge/check`.

Quickest seeding: after inserting only the `users` and `sessions` rows by SQL, create everything else with curl against the test API (`Authorization: Bearer <sid>`); the first `GET /api/goals` also runs the seed goals and playbooks. Only `last_contact_at` and links need SQL. The test API uses the real Anthropic integration, so check-in drafts and Ask answers work there.

For briefs and the digest: seed calendar events relative to now through `/api/ingest/calendar`, then `POST /api/ingest/sweep-run` with only `started_at` and `finished_at` (extra keys answer 400). That one call builds briefs and the digest, the same as a real sweep. Briefs and the digest summary call the real model, so wait about 6 seconds before a brief page screenshot.

Pushing the schema to the test database: `push-force` reads `DATABASE_URL`, so run it as `DATABASE_URL=$(cat /tmp/tdb) pnpm --filter @workspace/db run push-force`. Without the override it force-pushes to the dev database, which holds Ollie's real data.

A second API instance pointed at the dev database starts the connector timer, so it can run real checks on Ollie's data: keep it to a few seconds (`timeout 40 node dist/index.mjs`) and block non-GET requests in the Playwright route. Never stop it with `pkill -f` on a pattern from the same command line; that kills your own shell.

- The UI check session needs a full user object (id, email, firstName, lastName, profileImageUrl) in `sess`, or `/api/auth/user` fails the response check and the app shows the login page. Background servers started with `&` inside a normal shell call die when the call ends; start them as a background task.

There is no `POST /api/tasks` or plain `POST /api/decisions` seeding route: insert tasks and decisions by SQL with `created_by = 'ollie'` (and `decided_at` for decisions). Organisations, people, projects, links and relationships seed fine through the API.

Plan my day fits tasks from the current London time, so an evening UI check makes nothing fit. To see the timeline, save the plan through the UI, then set `day_plans.items` starts by SQL and reload. Vitest uses the same `ollieos_test` database, so stop the test API before running the suite.
