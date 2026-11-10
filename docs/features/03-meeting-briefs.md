# Feature PRD: Meeting briefs

| | |
|---|---|
| Screen | `design/screens/MeetingBrief.dc.html` |
| Entry points | "Brief me" on the Home Today strip and phone Home; "Brief" links in the digest |
| Depends on | Calendar events from the sweep, knowledge model, playbooks, Ask (Anthropic API) |
| Milestone | 5, after calendar ingest |

## 1. Problem

Ollie has several external meetings most days. Context for each is spread across email, Granola, Slack and memory, and pulling it together before a call takes time he doesn't have.

## 2. What it does

A one-page brief for every work meeting, ready 30 minutes before it starts, built only from OllieOS data.

## 3. Screen

- **Header (dark band):** "Brief" eyebrow with date, time and platform; meeting title; how many sources it used; a countdown pill ("Starts in 25 minutes").
- **Why this meeting:** 2 to 4 sentences: who asked for it, what they want, what Ollie offered.
- **Who's in the room:** a card per attendee with name, role, organisation, first or last contact, and whether they've accepted. Unknown attendees show "No previous contact". Each links to their person page.
- **Questions to open with:** 3 to 5 questions. If a playbook or note says to open with discovery, the questions are discovery questions.
- **Notes for after:** a notes box; Granola notes are attached automatically after the meeting.
- **Side column:**
  - What you promised (open promises to any attendee, with source and due)
  - Related projects and goals
  - Documents to have open (from the document index)
  - Watch-outs from your playbooks (playbooks that match the meeting's projects)

## 4. Rules

1. Briefs are generated for calendar events that are not marked personal and have at least one attendee who is a known person or organisation, or a title matching a project.
2. Generation runs when the sweep posts calendar events, and again on open if the brief is more than 3 hours old.
3. Built from `get_context` for each attendee and linked project, plus open promises and playbooks, passed to the Anthropic API with an instruction to use only those facts and cite them. Every sentence in "Why this meeting" must trace to a fact, email or note.
4. Confidential items are excluded unless Ollie has an approved access request.
5. If there isn't enough to say, the brief says "Not much on file" and shows only attendees and promises. It never pads.
6. After the meeting, the next sweep attaches the Granola notes and offers to turn actions into Inbox items and decisions into Knowledge Inbox suggestions.

## 5. Data model

| Table | Fields |
|---|---|
| `meeting_briefs` | id, calendar_event_id, generated_at, why, questions (JSON), attendee_ids, project_ids, promise_ids, document_ids, playbook_ids, cited_ids, notes, granola_ref |

## 6. MCP changes

- New tool `get_meeting_brief(calendar_event_id | "next")` so Claude can read the brief in chat ("brief me on my next call").
- Resource `ollieos://brief/next`.

## 7. Acceptance criteria

1. A work meeting with a known attendee has a brief 30 minutes before it starts.
2. Every statement in "Why this meeting" links to a source.
3. A personal event (for example "Doctors") never gets a brief.
4. Open promises to any attendee appear in "What you promised".
5. After the meeting, Granola notes appear on the brief and their actions are offered as Inbox items.

## 8. Open decisions

| Item | Proposal |
|---|---|
| Push notification 30 minutes before | Phase 2, if the app is installed to the home screen |
