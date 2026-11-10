# Feature PRD: Goals

| | |
|---|---|
| Screen | `design/screens/Goals.dc.html` |
| Depends on | Projects and tasks, confidentiality rules |
| Milestone | 3, with knowledge pages |

## 1. Problem

Ollie has three 12-month priorities (growth, efficiency, product and market expansion). Day-to-day work arrives from everywhere and nothing shows whether this week's tasks actually move those priorities.

## 2. What it does

Goals sit above projects. Projects and tasks link to a goal. OllieOS shows how much open work supports each goal, flags goals with no work against them, and asks about work that isn't linked to any goal.

## 3. Screen

- Eyebrow "Next 12 months", title, and "N of M open tasks support a goal this week".
- **Goal cards:** number and name, the goal statement, a confidential label where set, sub-goals, linked projects as chips, and "N open tasks · N due this week". A goal with no open tasks shows a warning line: "nothing you're doing this week moves this goal".
- **Work not linked to a goal:** open tasks with no goal (directly or through their project), each with buttons for each goal and "Not goal work".

## 4. Rules

1. A task inherits its goal from its project; a direct link overrides it.
2. Targets are free text. Financial targets are entered by Ollie and marked confidential by default; the prototype shows them as placeholders.
3. Confidential goals: AI tools can see that a goal exists and its linked projects, but not the target text.
4. "Not goal work" is remembered per task, so it isn't asked again.
5. Do next ranking (PRD section 6) uses goal links to break ties: between two tasks of equal priority and due date, the goal-linked task comes first.
6. The weekly update groups done items by goal.

## 5. Data model

| Table | Fields |
|---|---|
| `goals` | id, parent_id (for sub-goals), name, statement, target_text, period_start, period_end, confidential, sort_order |

`projects` gains `goal_id`. `tasks` gains `goal_id` (override) and `not_goal_work` (boolean).

## 6. MCP changes

- `get_context` for a project includes its goal.
- New tool `list_goals` (targets omitted when confidential).

## 7. Acceptance criteria

1. A task in the RAF Micro Internship project counts towards the goal that project is linked to.
2. A goal with no open tasks shows the warning.
3. Linking an unlinked task from the Goals screen updates the counts.
4. MCP `list_goals` never returns the target text of a confidential goal.
