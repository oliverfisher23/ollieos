# Feature PRD: Stale and conflicting facts

| | |
|---|---|
| Screen | `design/screens/KnowledgeInbox.dc.html` (Conflicts and Needs a check tabs) |
| Depends on | Knowledge Inbox (`01-knowledge-inbox.md`) |
| Milestone | 4 |

## 1. Problem

Knowledge goes out of date quietly. "BT decision hinges on the September change board" was true in September and is meaningless in November. Two sources can also disagree (for example, Ollie's job title in project instructions versus Claude memory). A source of truth has to flag both.

## 2. What it does

- **Needs a check:** facts that nobody has confirmed for longer than their shelf life are listed for review.
- **Conflicts:** when two facts about the same thing disagree, both are shown side by side for Ollie to choose.

## 3. Screen

**Needs a check card:** kind pill "Stale fact", the item, "Last confirmed [date]", the fact, the source and days since confirmation. Actions: **Still true** (sets `last_confirmed_at` to now), **Edit**, **No longer true** (supersedes the fact, which then stays in history only).

**Conflict card:** kind pill "Conflict", the item, the two values side by side with their sources as labels. Actions: **Keep [left source]**, **Keep [right source]**, **Neither, I'll write it**.

## 4. Rules

1. Facts gain an optional `attribute` (for example `job_title`, `status`, `next_step`, `decision_date`). Two current facts with the same entity and attribute but different values create a conflict.
2. Shelf life by attribute: `status` and `next_step` 30 days; general facts 90 days; `job_title` and `organisation` 365 days. Configurable in Settings.
3. A weekly job (Sunday evening) finds stale facts and conflicts and adds them to the Knowledge Inbox. Maximum 10 stale items a week, oldest first, so the list never becomes a chore.
4. While a fact is stale or in conflict, `get_context` and Ask still return it but mark it `"needs_check": true`, and Claude is told to say so if it relies on it.
5. Imported Claude memory facts start with `last_confirmed_at` set to their original date, so old ones surface first.

## 5. Data model

`facts` gains: `attribute` (nullable), `last_confirmed_at`, `needs_check` (boolean).

| Table | Fields |
|---|---|
| `fact_reviews` | id, kind (stale, conflict), fact_ids, status (pending, resolved), resolution, created_at, resolved_at |

## 6. MCP changes

- `get_context` and `search` include `needs_check` on each fact.
- `add_fact` with an `attribute` that conflicts with a current fact creates a conflict review, not a plain suggestion.

## 7. Acceptance criteria

1. A `status` fact unconfirmed for 31 days appears under Needs a check after the weekly job.
2. "Still true" removes it from the list and resets its shelf life.
3. Two current facts with the same entity and attribute and different values appear as one conflict card.
4. Resolving a conflict supersedes the losing fact; history keeps both.
5. Ask answers that use a `needs_check` fact say so.
