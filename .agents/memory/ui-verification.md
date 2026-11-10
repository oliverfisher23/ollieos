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

