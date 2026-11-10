# OllieOS: PRD for Replit Agent

| | |
|---|---|
| Owner | Ollie Fisher |
| Version | 2.2, 9th November 2026 (adds nine features, each with its own PRD in `docs/features/`) |
| Builder | Replit Agent |
| Where | Ollie's personal Replit account, not the Springpod workspace |
| Design | `design/screens/` (16 screens) and `docs/DESIGN.md`. DESIGN.md is the visual source of truth |
| Status | Ready for build. Open decisions in section 17 |

---

## 1. Summary

OllieOS is Ollie's personal operating system: one private web app that holds his tasks and his working knowledge, and that Claude and other AI tools read from and write to.

It has three parts:

1. **Tasks.** Everything Ollie needs to do, from email, meetings, Slack, quarterly actions and manual entry, triaged into Now, Backlog, Waiting on, Done or Noise.
2. **Knowledge.** Projects, people, organisations, decisions and notes, linked to each other and to tasks. This is the master copy of what Ollie knows about his work. Claude's own memory becomes secondary to it.
3. **AI access.** An MCP server built into the app, so Claude (and any MCP-capable tool) can search OllieOS, read a project or person before drafting, add tasks, log decisions and write notes. Confidential items are hidden from AI unless Ollie approves.

The app does not connect to email, Slack or Granola itself. A scheduled Claude task reads those sources and writes to OllieOS through the MCP server or the ingest API (section 12).

---

## 2. User and goals

One user: Ollie, on desktop and phone (saved to the home screen). AI tools act on his behalf.

Goals:

- Inbox at zero daily, with triage taking under 5 minutes.
- Nothing he committed to is lost between email, meetings and Slack.
- Before any call or email, Claude can pull the full context on the person and project from one place.
- Confidential material (sale process, board, financials) never reaches an AI tool without his say-so.
- A done list each Friday that feeds his weekly update.

---

## 3. Scope

### In scope

- Home, Tasks and Knowledge screens as designed (sections 6 to 8).
- Projects, people, organisations, decisions and notes, all linked (section 9).
- Confidential flag and AI access controls on every knowledge item, plus an approval queue (section 10).
- MCP server (section 11) and REST ingest API (section 12).
- Search across tasks and knowledge.
- Noise rules applied on ingest.
- Login restricted to Ollie's email.
- One-off import of current tasks and of Claude memory (section 14).

### Out of scope (this phase)

- Connecting to Gmail, Slack, Granola or Notion directly.
- Sending emails or messages from the app.
- Other users or sharing.
- Notifications and reminders.
- File storage beyond links (no document uploads).
- Native mobile apps.

---

## 4. Stack and hosting

| Layer | Choice |
|---|---|
| App | React (Vite) frontend and Node/Express API in one Repl, TypeScript |
| Database | Replit Postgres with Drizzle ORM. Full-text search with Postgres `tsvector` |
| Auth (people) | Replit Auth, restricted to the email in the `ALLOWED_EMAIL` secret |
| Auth (AI and scripts) | MCP server: OAuth 2.1 as required by Claude custom connectors (section 11.1). Ingest API: `Authorization: Bearer <INBOX_API_KEY>` |
| MCP | `@modelcontextprotocol/sdk`, Streamable HTTP transport at `/mcp` |
| In-app AI (Ask OllieOS) | Anthropic Messages API, server-side only, key in `ANTHROPIC_API_KEY`. Retrieval through the same search and confidentiality filter the MCP server uses |
| Hosting | Replit Autoscale deployment on a `.replit.app` URL |
| Fonts | Inter (interface), Instrument Serif italic (dates and accents), from Google Fonts |

Rules:

1. Every page and non-AI route requires the logged-in, allowlisted user.
2. Every write from any source records who made it (`ollie`, `claude`, `ingest`, or the MCP client name) in `audit_events`.
3. Confidential filtering happens in one server-side function used by every AI-facing route. No AI route reads the database directly.
4. Dates stored in UTC, shown in Europe/London time, written as ordinals ("Friday 13th November").

---

## 5. Visual design

Follow `docs/DESIGN.md` and the screen files in `design/screens/`. Summary:

- **Dark surfaces (Home, Ask, phone):** full-bleed grainy gradient (navy top-left, warm grey centre, burnt orange bottom-right) with an SVG noise overlay; dark glass panels.
- **Light surfaces (Tasks, Task detail, Knowledge, Settings):** warm off-white page, white panels, large semi-bold titles, underline tabs, italic serif counts, light-ruled tables, soft status pills.
- Font: Google Sans first in the stack, DM Sans as the loaded fallback (Google Sans is not licensed for general use), Instrument Serif italic for dates and counts.
- Text contrast at least 4.5:1. Touch targets at least 44px on phone. Works at 375px wide.

---

## 6. Home (`design/screens/Main.dc.html`, phone: `PhoneHome.dc.html`)

Top to bottom:

1. **Greeting:** date in italic serif, "Good morning, Ollie".
2. **Status line:** last sweep time, new Inbox count, and any pending AI access request with Allow 1 hour and Decline buttons inline.
3. **Ask or add box:** a mode switch between "Add a task" and "Ask OllieOS".
   - Add mode: inline syntax `!high`, `!low`, `due:fri`, `due:2026-11-20`, `#backlog`, `@project-slug`. Suggestion chips below.
   - Ask mode: sends the question to the Ask screen (section 6.1).
4. **Today strip:** today's calendar events. The next work event is highlighted with a "Next" label and a "Brief me" link to the linked person or project. Personal events show muted.
5. **Do next card (white):** one task, chosen as overdue first, then High priority by soonest due date, then Medium by soonest due date. Shows title, priority, due, project and a one-line reason. Buttons: Done, Snooze to tomorrow (sets `snoozed_until`). Shows "1 of N".
6. **Inbox card:** count, a breakdown by source, and a "Triage N" button that opens Triage mode (section 6.2).
7. **Waiting on card:** person, what for, days waiting (amber at 5 days or more), Chase button that copies a short chase line to the clipboard.
8. **Promises card:** things Ollie committed to in email or Slack (tasks with `kind = promise`), with person and date.
9. **Done this week card:** count, the latest items, and a link to the weekly update.

The left icon rail (desktop) and bottom tab bar (phone) link to Home, Tasks, Knowledge, People and Settings. The phone tab bar has a central add button.

### 6.1 Ask OllieOS (`design/screens/Ask.dc.html`)

- Shows the question as a chat bubble, then the answer.
- The answer has: a provenance line ("Answered from OllieOS · N sources · no confidential items used"), a short summary, a list of items, each with source chips that link to the task, email or meeting, related people and projects, and actions (Draft a reply, Bundle into one task, Copy answer).
- Drafts are shown inline and never sent from OllieOS.
- A follow-up box keeps the conversation going.
- Server flow: search OllieOS through the confidentiality filter, pass only the allowed results to the model with an instruction to answer only from them and cite each item by id, then render the citations as chips. If nothing relevant is found, say so.

### 6.2 Triage mode (in `Main.dc.html` and `PhoneTriage.dc.html`)

- Full-screen, one item at a time: source, from, time, title, snippet, and the sweep's suggested action.
- Progress bar and "n of N".
- Four actions: Now, Backlog, Waiting, Noise. Keyboard: `n`, `b`, `w`, `x`, and `u` to undo. Phone: large buttons, swipe right for Now and left for Noise.
- Noise offers "Always ignore items like this" (section 13).
- Ends on "Inbox clear."

---

## 7. Tasks

### 7.1 Statuses

| Status | Meaning |
|---|---|
| `inbox` | Captured, not triaged |
| `now` | Doing this week |
| `backlog` | Will do, not this week |
| `waiting` | Ball is with someone else (`waiting_on` person) |
| `done` | Completed (`completed_at`) |
| `noise` | Archived (`noise_rule_id` when a rule caught it) |

Any status can move to any other.

### 7.2 Screen

- Tabs: All open, Now, Backlog, Waiting on, Done, Noise, each with a count.
- Toolbar: italic count, source filter, week picker, filter button, search.
- Stat cards: Inbox to triage, Due this week, Waiting on others, Done this week.
- Table: complete circle, task, source, from, priority, due, status. Click a row to open the task detail panel.

### 7.3 Task detail panel (`design/screens/TaskDetail.dc.html`)

Right-hand panel over the faded list. Fields: title, Status (segmented: Inbox, Now, Backlog, Waiting on, Done), Priority (High, Medium, Low), Due date, Project link, For (person) link, Source card (type, subject, date, the quoted line that created the task, "Open in Superhuman" or the source link), Notes, History (from `audit_events`, newest first). Actions: Mark done, Ask Claude to draft (copies a prepared prompt in phase 1), Move to Noise. On phone it opens as a full-screen sheet.
- Inbox tab adds the triage buttons and keyboard shortcuts (`j`/`k`, `n`, `b`, `w`, `x`, `e`).
- Noise tab: restore to Inbox, and the rule that caught each item.
- Done tab: "Copy for weekly update" copies this week's items grouped by project.
- Backlog: "Stale" marker after 30 days untouched.

---

## 8. Knowledge

### 8.1 Layout

Left panel: search, Projects list (with open task counts and lock icon on confidential ones), Library (People, Organisations, Decisions, Notes). Main panel: the selected item.

### 8.2 Project page

Eyebrow (type and area), title, status pills, AI access panel (section 10), Summary, Key facts, Decisions (dated), Open tasks, People, Recent activity.

### 8.3 Person page

Initials avatar, name, organisation and role, Relationship summary, "I owe them" and "They owe me" (from open tasks and waiting items), Timeline (emails, meetings, notes), Add a note, Details panel, and an "Ask Claude" panel with prompts that open Claude with this page as context (deep link or copy, section 16).

### 8.4 Organisation, decision and note pages

Same layout pattern: title, summary, linked items, timeline.

### 8.5 Editing

Every field edits in place. Key facts and decisions are separate rows, not free text, so AI can read and add them one at a time.

---

## 9. Data model

| Table | Key fields |
|---|---|
| `tasks` | id, title, kind (`task` or `promise`), status, priority, due_date, snoozed_until, source, source_ref, source_url, source_quote, from_name, from_address, snippet, suggested_action, notes, waiting_on_person_id, person_id, project_id, noise_rule_id, confidential, created_at, updated_at, completed_at, triaged_at |
| `calendar_events` | id, source_ref (unique), title, starts_at, ends_at, attendees (names), personal (boolean), person_ids, project_id, updated_at. Today and the next 7 days only; replaced on each sweep |
| `sweep_runs` | id, started_at, finished_at, items_created, items_noise, items_duplicate, activity_logged, errors |
| `projects` | id, name, slug, area, status, summary, confidential, ai_access, created_at, updated_at |
| `people` | id, name, slug, organisation_id, role, email, relationship_summary, confidential, ai_access, last_contact_at |
| `organisations` | id, name, slug, type, summary, confidential, ai_access |
| `facts` | id, entity_type, entity_id, text, source, created_by, created_at, superseded_by |
| `decisions` | id, project_id, text, decided_at, decided_by, source, confidential |
| `notes` | id, entity_type, entity_id, body, created_by, created_at, confidential |
| `activity` | id, entity_type, entity_id, kind (email, meeting, slack, note, task), summary, source_url, occurred_at |
| `links` | from_type, from_id, to_type, to_id (many-to-many: people on projects, tasks to people) |
| `capture_log` | source, source_ref (unique together), task_id, outcome, captured_at |
| `noise_rules` | id, match_type, match_value, source, enabled, hit_count, last_hit_at |
| `access_requests` | id, client, entity_type, entity_id, reason, status (pending, approved, declined), expires_at, created_at |
| `ai_clients` | id, name, kind (connector, scheduled task, other), scopes, connected_at, last_used_at, revoked_at |
| `ask_threads` | id, question, answer, cited_ids, created_at (Ask OllieOS history) |
| `audit_events` | id, actor, action, entity_type, entity_id, payload, created_at |

Facts are never edited in place: a changed fact is a new row with `superseded_by` set on the old one, so history is kept.

---

## 10. Confidentiality and AI access

Every project, person, organisation, decision and note has two settings:

| Setting | Effect |
|---|---|
| `ai_access` on (default) | AI tools can read and write it |
| `ai_access` off | Hidden from AI tools |
| `confidential` on | Hidden from AI tools regardless of `ai_access`; lock icon in the interface |

Settings screen: `design/screens/Settings.dc.html` (counts, access requests with Allow for 1 hour and Decline, connected tools with Revoke, today's AI activity log).

Rules:

1. Anything linked only to a confidential project inherits confidential (tasks, decisions, notes). Ollie can override per item.
2. AI search results never show hidden or confidential items, not even their titles or counts.
3. An AI tool may call `request_access` naming a hidden item it knows exists (for example, Ollie mentioned it in chat). The request appears on Home as a banner. Ollie approves for one hour or declines. Approved access applies to that client only.
4. Every AI read of any item writes an `audit_events` row. Settings shows the last 100 AI reads.
5. The sale process, board materials and financials start as confidential on import.

---

## 11. MCP server

### 11.1 Connection

- Streamable HTTP at `https://<app>.replit.app/mcp`.
- OAuth 2.1 with dynamic client registration, so it can be added as a custom connector in Claude. The consent screen sits behind Replit Auth, so only Ollie can approve a client.
- Each connected client has a name and can be revoked in Settings.

### 11.2 Tools

| Tool | Does |
|---|---|
| `search` | Full-text search across tasks, projects, people, organisations, decisions and notes. Returns type, id, title, snippet |
| `get_context` | Everything about one project, person or organisation: summary, facts, decisions, open tasks, people, recent activity. The main tool for "brief me" and drafting |
| `list_tasks` | Filter by status, project, person, due before |
| `create_task` | Adds a task (defaults to `inbox` when the caller is not Ollie) |
| `update_task` | Changes status, priority, due date, links |
| `add_fact` | Adds a fact to an entity, with source |
| `log_decision` | Adds a dated decision to a project |
| `add_note` | Adds a note to an entity |
| `log_activity` | Records an email, meeting or Slack touchpoint against people and projects |
| `upsert_person` / `upsert_project` | Creates or updates by name, matching existing slugs first to avoid duplicates |
| `request_access` | Asks Ollie to unlock a hidden item (section 10) |
| `log_promise` | Records something Ollie committed to (a task with `kind = promise`) |
| `upsert_calendar` | Replaces today's and the next 7 days' calendar events |

Rules:

- No delete tools. AI can supersede a fact, archive a task to Noise or mark one done, but never delete.
- Every tool response passes through the confidentiality filter.
- Tool descriptions tell the model that OllieOS is the source of truth for Ollie's work and should be checked before asking him for context.

### 11.3 Resources

`ollieos://today` (Home summary), `ollieos://project/{slug}`, `ollieos://person/{slug}`.

---

## 11a. Connectors (added 10th November 2026)

OllieOS reads Ollie's services itself through Replit integrations, so it no longer depends on the Claude sweep. Settings has a Connectors page (replacing "AI access" and "Capture sweep") with one card per service: Google Calendar, Gmail, Slack, Google Drive and Granola. Each card shows its status, last check and what was found, with Check now and a switch for whether OllieOS or Claude reads it. The same page holds the Claude tools, access requests, the Claude sweep and "What AI looked at".

- **Part A (built):** Google Calendar, read directly. Once OllieOS has read it, the sweep's calendar is ignored.
- **Part B:** Gmail and Slack, with AI sorting on a cheaper model billed to Replit credits.
- **Part C:** Google Drive, and Granola through its Enterprise API (key entered in Replit's secure form).

OllieOS checks on its own timer: every 30 minutes on weekdays, 07:00 to 19:00 London time, changeable on the page. This replaces build plan question 32 (no timers). Timed checks need the published app to stay always on (Reserved VM).

## 12. Ingest API

For the scheduled Claude sweep and any script. All routes need `Authorization: Bearer <INBOX_API_KEY>`.

| Route | Does |
|---|---|
| `POST /api/ingest/tasks` | Up to 100 items: `source`, `source_ref`, `kind` (`task` or `promise`), `title`, `snippet`, `source_quote`, `source_url`, `from_name`, `from_address`, `suggested_action`, `suggested_priority`, `suggested_due`, `project_hint`, `person_hint`, `waiting_on_hint` (for items where Ollie is waiting on someone), `confidential`, `captured_at`. Duplicate `source` + `source_ref` is skipped; a noise rule match lands in Noise; otherwise Inbox. Returns an outcome per item |
| `GET /api/ingest/cursor` | When the last successful sweep finished, so the next sweep reads only newer items |
| `POST /api/ingest/sweep-run` | Records a sweep's start, finish and counts (feeds the Home status line) |
| `POST /api/ingest/calendar` | Replaces calendar events for today and the next 7 days |
| `POST /api/ingest/activity` | Activity entries linked by person and project hints |
| `GET /api/ingest/noise-rules` | Enabled rules |
| `GET /api/ingest/open-tasks` | Open tasks, to avoid near-duplicates |
| `GET /api/ingest/done?since=` | Done tasks, for the weekly update |
| `POST /api/import` | One-off bulk import (section 14), disabled after first use |

Confidential items are excluded from every `GET`.

---

## 13. Noise rules

Match types: `from_address_equals`, `from_domain_equals`, `slack_channel_equals`, `title_contains`. Created from an item in one tap when marking it Noise. Applied only to new items on ingest. Meeting actions are never auto-noised. Noise items are deleted after 90 days.

---

## 14. Imports

### 14.1 Tasks

Seed the current open tasks from Notion (status checked just before import). Ten tasks as of 9th November 2026, listed in the prototype's Tasks screen.

### 14.2 Knowledge from Claude memory

Claude exports Ollie's project areas and people from its memory as JSON matching `/api/import`, Ollie reviews the list, then Claude posts it. Rules:

- Work items only. Personal files (family, wedding, health) are not imported unless Ollie picks them.
- Sale process, buyer analysis, CIP and board items import as confidential.
- Each imported fact keeps `source: "claude-memory"` and its original date.

---

## 14a. Feature PRDs

Each feature below has its own PRD in `docs/features/`. Where a feature PRD and this document disagree, the feature PRD wins for that feature.

| # | Feature | Screen | Milestone |
|---|---|---|---|
| 01 | Knowledge Inbox: AI proposes facts, Ollie approves | `KnowledgeInbox.dc.html` | 4 |
| 02 | Stale and conflicting facts | `KnowledgeInbox.dc.html` | 4 |
| 03 | Meeting briefs | `MeetingBrief.dc.html` | 5 |
| 04 | Goals | `Goals.dc.html` | 3 |
| 05 | Relationship cadence | `People.dc.html` | 3 |
| 06 | Document index | `Library.dc.html` | 3 |
| 07 | Playbooks | `Library.dc.html` | 3 |
| 08 | Daily digest | `Digest.dc.html` | 5 |
| 09 | Voice capture | `PhoneVoice.dc.html` | 6 |

Main navigation becomes: Home, Tasks, People, Goals, Knowledge (with Knowledge Inbox and Library inside), Settings.

---

## 15. Build order

Work in milestones. At the end of each, show the result and wait for Ollie's approval.

| # | Milestone | Done when |
|---|---|---|
| 0 | Plan | Read this PRD and the prototype; write `docs/build-plan.md`. No code |
| 1 | Foundation | Auth with allowlist, full schema and migrations, app shell, Home layout with real data (Do next, Inbox count, Waiting on, Promises, Done), Tasks screen, task detail panel, quick add with inline syntax |
| 2 | Triage | Triage mode with four actions, shortcuts and undo, Waiting on with Chase, Done with weekly copy, Noise with restore, snooze |
| 3 | Knowledge and Ask | Projects, people, organisations, decisions and notes pages, linking, in-place editing, search, Ask OllieOS with citations, Goals, relationship cadence, document index, playbooks |
| 4 | Access control and trust | Confidential and AI access settings, inheritance, approval queue, AI read log, Knowledge Inbox, stale and conflicting facts |
| 5 | MCP and ingest | MCP server with OAuth and all tools (including the feature PRD tools), ingest API including cursor, sweep runs and calendar, Today strip and status line wired up, noise rules on ingest, meeting briefs, daily digest. Tested by connecting Claude |
| 6 | Polish and import | Phone Home, Triage and voice capture to match the phone screens, swipe gestures, home screen install, Noise clean-up job, CSV export, imports run (including seed playbooks), `APP_GUIDE.md` written |

---

## 16. Acceptance criteria

1. Any login other than the allowlisted email sees "Not authorised" and gets no data.
2. A confidential project, and every item linked only to it, never appears in any MCP or ingest response, including search counts.
3. `request_access` creates a Home banner; approving unlocks that item for that client for one hour, then it is hidden again.
4. Claude, connected as a custom connector, can run `get_context` on a project and draft an email using its facts.
5. Duplicate ingest of the same `source` + `source_ref` creates one task.
6. Every write and every AI read has an `audit_events` row naming the actor.
7. No MCP tool can delete anything.
8. Home and Tasks match the prototype at desktop width and work at 375px with no sideways scroll.
9. British English throughout, dates as ordinals, no em dashes in interface text.
10. Ask OllieOS answers only from OllieOS data, cites every item it uses, and never uses a confidential item without an approved request.
11. Do next follows the ranking in section 6 and skips snoozed tasks until their snooze date.
12. The ingest `confidential` flag hides an item from every AI-facing route from the moment it is created.

---

## 17. Open decisions

| Item | Proposal |
|---|---|
| OAuth for Claude custom connectors | Confirm the current requirements in Anthropic's connector docs at milestone 5 before building |
| "Ask Claude" buttons | Copy a prepared prompt to the clipboard in phase 1; a deep link later if Claude supports one |
| Custom domain | Stay on `.replit.app` for now |
| Default view on open | Home |
| How often the sweep runs | Weekdays about 07:40 and 13:40. OllieOS's own checks run every 30 minutes, 07:00 to 19:00 on weekdays (section 11a) |
| Ask OllieOS model | A current Claude model via the Anthropic API; confirm the model name at milestone 3 |
| Fonts | Google Sans if Ollie has a licence route, otherwise DM Sans |

---

## 18. After launch (not part of the Replit build)

- Claude scheduled sweep: email (Superhuman), Granola, Slack DMs and mentions, calendar and Q3 actions into Inbox, Promises, Waiting on, Activity and Calendar, twice daily on weekdays.
- Claude memory export and import (section 14.2).
- Retire the Notion to-do board.
