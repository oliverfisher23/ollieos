---
name: Connecting ChatGPT and Gemini
description: What each outside AI can do with the OllieOS MCP connector, as checked on 10th November 2026
---
- The connector uses OAuth with dynamic client registration and any https redirect, so any MCP client can register; each shows as its own "Connector" on Settings and needs Ollie's approval.
- ChatGPT: OpenAI's help page lists custom MCP connectors for Business, Enterprise and Edu. Developer mode on Plus or Pro was not verified, so the setup steps are phrased "if your plan has it". Ollie has Plus or Pro.
- Gemini: the everyday Gemini app cannot add custom MCP servers. Gemini CLI and Gemini Enterprise can. Ollie declined an export file as a workaround.

**Why:** Ollie asked for one graph all three AIs can use; these limits decide what is possible.
**How to apply:** re-check the OpenAI and Google pages before promising Ollie that either works; do not build an export file unless he asks again.

The published app is in an organisation workspace, so it defaulted to a Private sharing setting. Every path (including /mcp and /.well-known/*) then answers 307 to Replit's sign-in page, and Claude shows "Connecting to the server: Not found 307". Fix is Sharing set to Public (unpublish, change, publish again); OllieOS's own login and OAuth still guard everything. Check with `curl -s -o /dev/null -w "%{http_code} %{redirect_url}" -X POST <prod>/mcp`.
