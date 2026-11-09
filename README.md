# OllieOS build pack

Everything Replit Agent needs to build OllieOS: Ollie's personal operating system for tasks and knowledge, readable by Claude through an MCP server.

## What's in here

| Path | What it is |
|---|---|
| `KICKOFF_PROMPT.md` | The first message to paste into Replit Agent |
| `docs/PRD.md` | The product requirements (v2.1): scope, data model, confidentiality rules, MCP server, ingest API, build order, acceptance criteria |
| `docs/DESIGN.md` | Visual spec: fonts, colour tokens, shapes, components and how to read the screen files |
| `design/screens/*.dc.html` | Nine prototype screens (Home, Ask, Tasks, Task detail, Knowledge project, Person, Settings, phone Home, phone Triage) |

## How to use it

1. Create a new Repl in your **personal** Replit account (not the Springpod workspace).
2. Upload this whole folder into the Repl, keeping the structure.
3. Paste `KICKOFF_PROMPT.md` into Replit Agent.
4. Approve each milestone before the next one starts.

## Secrets to add in Replit

| Name | Value |
|---|---|
| `ALLOWED_EMAIL` | The one email allowed to log in |
| `INBOX_API_KEY` | A long random string for the ingest API |
| `ANTHROPIC_API_KEY` | For Ask OllieOS (milestone 3) |

## After it's live

Tell Claude the app's address. Claude will connect it as a connector, set up the twice-daily sweep, and run the memory import.
