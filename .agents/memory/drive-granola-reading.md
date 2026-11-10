---
name: Drive and Granola reading
description: Non-obvious rules and quirks for the Google Drive and Granola connectors (Part C)
---
- Granola must not switch Claude's meeting feed off just because a check succeeded: it only takes over after a check that found one of Ollie's own meetings.
  **Why:** the first Granola key was a team-space key that only saw colleagues' notes (none of Ollie's); a "good" run would have silently cut off his meeting notes.
  **How to apply:** keep the meetings>0 condition if the auto-switch logic changes.
- The connector proxy answers HTTP 404 with "No <service> connection found" when the connection is missing, not only for a missing item. Per-item 404 handling must check the body first.
- Drive judging sends the first ~2,500 characters of each recently opened file to Haiku. Ollie's Drive holds sensitive files (candidate lists, bonus drafts); Haiku flagged them confidential correctly in the dry run on 10th November 2026.
- Dev and prod had no active non-confidential projects on 10th November 2026, so Drive suggestions do nothing until projects exist; the cursor waits rather than skipping files.
- OllieOS needs the Granola **API** connection (connector `granola`); the Granola MCP connection only works for the agent in chat, never from app code. The API key must include the "Personal notes" access scope; on Springpod's Enterprise plan an admin controls which scopes members may use (Settings → Workspace → General → API access for members). Checked through the MCP on 10th November 2026: Ollie does capture his own meetings (3 in the previous 7 days).
