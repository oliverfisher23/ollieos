---
name: Replit connectors SDK
description: Which @replit/connectors-sdk client works for reading Ollie's Google services from the API server
---
Use `new ReplitConnectors().proxy("<connector-name>", path, { method })` (e.g. connector `google-calendar`). The v3 `ConnectorsClient` answers "No google-calendar connection found" in this workspace even when the integration is attached.

**Why:** found while building the Google Calendar reader; proxy returned 200 on the same connection.

**How to apply:** for Gmail, Slack and Drive readers, start with `ReplitConnectors().proxy` and map 401/403 to a "reconnect in Replit" error. The Calendar connection's primary calendar is Ollie's work account.

Timed connector checks only run while the server is up, so the published app must be a Reserved VM, not Autoscale (Autoscale idles after 15 minutes). Smallest shared VM was $15 a month when checked on 10th November 2026.
