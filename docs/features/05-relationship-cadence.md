# Feature PRD: Relationship cadence

| | |
|---|---|
| Screen | `design/screens/People.dc.html` |
| Also shown in | Digest ("Gone quiet"), person page details |
| Depends on | Activity log from the sweep |
| Milestone | 3 |

## 1. Problem

Partner relationships (Riipen, BT, IBM and others) go quiet without anyone deciding to let them. By the time Ollie notices, momentum is lost.

## 2. What it does

Each key person gets a contact cadence. OllieOS works out the last contact from email, meetings and Slack, and shows who is overdue, who is due soon and who is on track.

## 3. Screen

- Title, explanation, "N overdue" in italic serif.
- Tabs: All, Overdue, Due soon, On track, with counts.
- Table: person (avatar, name, organisation), project, cadence, last contact, status pill (Overdue with days, Due soon with days left, On track), action.
- Actions: **Draft a check-in** for overdue or due-soon people (opens a draft built from their person page and project; never sent from OllieOS), **Change cadence** for people on track.
- A note explains that dates before the import come from Claude memory and may be out of date.

## 4. Rules

1. Cadence options: weekly, every 2 weeks, monthly, every 2 months, quarterly, none. People with "none" don't appear here.
2. Last contact is the latest `activity` row linked to the person of kind email (sent or received), meeting or Slack. Notes don't count.
3. Status: overdue after one cadence period; due soon within the last 20% of the period.
4. When a person's project is marked complete or paused, their cadence pauses too.
5. Suggested cadence for new people comes from the sweep (for example weekly for someone in an active deal) and goes through the Knowledge Inbox.
6. Overdue people appear in the digest's "Gone quiet" section, at most 3 a day.

## 5. Data model

`people` gains `cadence` (enum), `cadence_paused` (boolean). `last_contact_at` is computed from `activity` and cached.

## 6. MCP changes

- `get_context` for a person includes cadence and status.
- New tool `list_overdue_contacts`.

## 7. Acceptance criteria

1. A person on a monthly cadence with no activity for 32 days shows as Overdue.
2. Logging an email with them moves them to On track.
3. "Draft a check-in" produces a draft that cites the person's open threads and is never sent automatically.
4. Pausing their project removes them from Overdue.
