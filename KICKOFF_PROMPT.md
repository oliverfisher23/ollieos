# Kickoff prompt for Replit Agent

Paste everything below the line.

---

You are building OllieOS, a private web app for one user. The full spec is in this repo:

- `docs/PRD.md`: requirements, data model, confidentiality rules, MCP server, ingest API, build order and acceptance criteria
- `docs/DESIGN.md`: fonts, colour tokens, components and how to read the prototype screens
- `design/screens/*.dc.html`: nine prototype screens. They are visual and behavioural reference. Rebuild them as React components; do not copy the prototype runtime

Do milestone 0 only:

1. Read all three in full, including every screen file and its script block.
2. Write `docs/build-plan.md` covering:
   - file and folder structure
   - database schema (Drizzle) for every table in PRD section 9
   - every route and page, mapped to its screen file
   - the MCP tool list with input and output shapes
   - the confidentiality filter: where it sits and how every AI-facing route uses it
   - the theme file holding the tokens from DESIGN.md
   - anything in the PRD that is unclear or conflicting, as numbered questions
3. Stop and wait for my approval. Do not write app code yet.

Rules for the whole build:

- Work milestone by milestone (PRD section 15). After each, show what was built against the acceptance criteria and wait for approval.
- Never hard-code colours in components; use the theme tokens.
- British English, dates as ordinals ("Friday 13th November"), no em dashes in any interface text.
- Never add a delete tool to the MCP server.
- Keep the example content in the screens out of the real database, except the tasks listed for import in PRD section 14.1.
