---
name: Reading Slack and Gmail through Replit connectors
description: Limits found when building the Gmail and Slack readers; read before changing how they find new messages.
---

- Slack connection is a user token without `search:read`, so `search.messages` fails with missing_scope.
- `assistant.search.context` works, but Slack's terms forbid storing its results or using it for background collection. Do not use it for the timed reader.
- `users.conversations` `updated` is NOT last-message time (checked against `conversations.history`: often weeks off either way). Only use it to order never-checked conversations.
- Ollie is in about 2,100 conversations (about 103 live DMs, the rest mostly group DMs), so the reader rotates through quiet ones. History calls take about 1.8 seconds each including the pacing gap, so about 50 conversations fit into the 90-second budget.
- Gmail grants read, compose and send but no modify, so the reader cannot label or archive. Compose is enough for drafts.create/update in a thread; never use send.
- Sorting with `claude-haiku-5-5` (thinking disabled, effort low, json_schema output) gave good results on real mail. It repeats items unless told to give one item per request per exchange, and Gmail messages must be grouped by thread.

**Why:** these cost several probes to find, and the obvious approaches (search, `updated`) look like they work but do not.
**How to apply:** before changing message discovery or the sorter, re-check these limits rather than switching to search.

## Gmail cannot be changed, only read and drafted into
The Replit Gmail connection holds readonly, compose, send and labels, never gmail.modify. Marking spam, archiving or changing a message's labels returns 403, so "spam" in OllieOS means its own Noise, and the UI says Gmail itself is untouched.
**Why:** platform credentials never request gmail.modify. **How to apply:** offer OllieOS-side actions; do not promise Gmail-side changes. (Sending is technically allowed but Ollie's rule is drafts only.)
