---
name: Running one-off server code in dev
description: How to run a service function (e.g. a real model read) against the dev DB without tsx
---
There is no tsx. Put the script inside artifacts/api-server (so imports resolve), bundle it with esbuild
(`--bundle --platform=node --format=esm --external:pg-native`) and a banner that defines `require`,
`__filename` and `__dirname` (pino's thread-stream needs `__dirname`), then run it with `NODE_ENV=production`.
Delete the script and bundle afterwards, and delete any rows it created (no example content in the dev DB).

**Why:** `--packages=external` fails (pg is not resolvable from the bundle), and NODE_ENV=test turns the knowledge reader off.
**How to apply:** for the "one real model call" check after mocked tests. If the code kicks the background reader, poll
`knowledge_sources.status` until it is no longer queued/reading instead of calling readWaiting (the kicked reader claims it first).
