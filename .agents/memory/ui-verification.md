---
name: Verifying signed-in screens
description: How to screenshot or click through OllieOS screens that sit behind the allowlisted login
---
The screenshot tool and testing browser cannot sign in as Ollie, so signed-in screens cannot be checked the normal way.

**Why:** the API refuses every email except ALLOWED_EMAIL, and the capture browser has no session.

**How to apply:** run a second API instance on another port with a test ALLOWED_EMAIL, insert a test row in `sessions` with that email, then drive Chromium (`/repl/tools/bin/chromium`, Playwright from `/mnt/pid2/node_modules/playwright`) against localhost:80 and route `**/api/**` to the test instance with `Authorization: Bearer <sid>`. Run the test server with run_in_background (plain `&` dies with the shell). Delete test tasks, their audit rows and the test sessions afterwards, since example content must not stay in the database.
