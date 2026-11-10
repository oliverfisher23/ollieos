# Feature PRD: Daily digest

| | |
|---|---|
| Screen | `design/screens/Digest.dc.html` |
| Entry points | Home (link under the status line after the morning sweep), optional email |
| Milestone | 5, after the sweep is live |

## 1. Problem

After a day of meetings, Ollie needs one short read of what changed, without opening every view.

## 2. What it does

Each weekday morning after the first sweep, OllieOS writes a one-page digest of changes since 18:00 the previous day.

## 3. Screen

A single letter-style page, max width 760px:

- Eyebrow: date and "since 18:00 yesterday"; title "What changed"; a one-sentence summary.
- **Needs you:** new Inbox items with source breakdown, the most urgent deadline, Knowledge Inbox count.
- **Moved:** tasks done, replies received on Waiting on items, promises made, new people.
- **Gone quiet:** up to 3 overdue contacts (from relationship cadence).
- **Today:** work calendar events with Brief links.
- Footer: delivery note and an "Email me this at 07:45" switch.

## 4. Rules

1. Built from database changes (audit events, sweep results, activity, calendar). The summary sentence is written by the Anthropic API from those items only.
2. Each section shows at most 5 items, with a link to the full list.
3. Empty sections are left out. If nothing changed, the digest says "Quiet night" and shows only Today.
4. Confidential items are counted but not named in the emailed version.
5. Digests are kept for 30 days.

## 5. Data model

| Table | Fields |
|---|---|
| `digests` | id, for_date, summary, sections (JSON), emailed_at, created_at |

Settings gains `digest_email_enabled` and `digest_email_time`.

## 6. Acceptance criteria

1. After the 07:40 sweep, a digest for today exists and is linked from Home.
2. Sections with nothing in them don't appear.
3. With email on, the digest arrives at 07:45 without any confidential item names.

## 7. Open decisions

| Item | Proposal |
|---|---|
| Email provider | A transactional email service (for example Resend or Postmark) with the key in Replit Secrets; skip email in phase 1 if it adds delay |
