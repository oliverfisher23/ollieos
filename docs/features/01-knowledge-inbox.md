# Feature PRD: Knowledge Inbox

| | |
|---|---|
| Screen | `design/screens/KnowledgeInbox.dc.html` (Suggested tab) |
| Depends on | Knowledge model (PRD section 9), MCP server (section 11) |
| Milestone | 4, alongside access control |

## 1. Problem

If AI tools write facts and decisions straight into OllieOS, wrong guesses become "the truth" and every AI that reads them repeats the mistake. OllieOS is only a trustworthy source of truth if Ollie approves what goes into it.

## 2. What it does

Every fact, decision, new person or change to a summary that an AI tool proposes arrives as a **suggestion** in the Knowledge Inbox. Ollie approves, edits then approves, or rejects each one. Tasks and activity entries still go straight in; they have their own triage.

## 3. Screen

- Title, short explanation, and "N to review" in italic serif.
- Tabs: **Suggested**, **Conflicts** and **Needs a check** (the last two are covered in `02-stale-and-conflicting-facts.md`), each with a count.
- One card per suggestion:
  - kind pill (New fact, New person, Proposed decision, Changed summary)
  - the item it belongs to (project, person or organisation), linked
  - who proposed it and when (Capture sweep, Claude chat, Voice capture)
  - the proposed text
  - the source (email, meeting, chat, recording) with a link
  - actions: **Approve**, **Edit, then approve**, **Reject**
- After an action the card dims and shows the result ("Added to knowledge" or "Rejected").
- Home status line and the daily digest show the count waiting.

## 4. Rules

1. AI callers can never write a fact, decision or person directly. Their MCP writes create a `suggestions` row instead.
2. Ollie's own edits in the app apply immediately with no suggestion step.
3. A "Proposed decision" stays a proposal until approved, so Claude never treats it as agreed. Example: the US strategy proposal, which Sam and Andy have not agreed.
4. Rejected suggestions are kept for 30 days so the same suggestion isn't made twice; the capture sweep checks them before suggesting.
5. Approving a suggestion writes the fact or decision with `source` and `approved_at`, and an audit event.
6. Suggestions on a confidential item are only visible to Ollie and never shown to AI.

## 5. Data model

| Table | Fields |
|---|---|
| `suggestions` | id, kind (fact, decision, person, organisation, summary_change), entity_type, entity_id (null for a new person), payload (JSON of the proposed record), source_type, source_ref, source_url, proposed_by (client name), status (pending, approved, rejected), decided_at, created_at |

`facts` and `decisions` gain `approved_at` and `suggestion_id`.

## 6. MCP and API changes

- `add_fact`, `log_decision`, `upsert_person`, `upsert_project` from any AI client return `{ status: "suggested", suggestion_id }`.
- New tool `list_my_suggestions`: lets a client see what is still pending, so it doesn't propose duplicates.
- `POST /api/ingest/suggestions` for the capture sweep (same payload shape).

## 7. Acceptance criteria

1. An MCP `add_fact` call creates a pending suggestion, not a fact.
2. Approving it creates the fact with its source and audit event; rejecting it creates nothing.
3. "Edit, then approve" saves the edited text, not the proposed text.
4. A rejected suggestion with the same entity and text is not re-created within 30 days.
5. Pending count shows on Home and in the digest.

## 8. Open decisions

| Item | Proposal |
|---|---|
| Auto-approve low-risk kinds (for example a person's job title from an email signature) | No for phase 1; review after a month of use |
