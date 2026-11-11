---
name: save-session-to-ollieos
description: Saves a record of the current session to Ollie's OllieOS with the save_session tool, so he can look back on it and future sessions can carry on from it. Use when Ollie says "save this session", "save to OllieOS", "log this session" or similar, and at the natural end of any piece of work done with the OllieOS connector. Also covers picking up context from OllieOS at the start of a session.
---

# Save a session to OllieOS

OllieOS is Ollie's personal OS. It is connected to Claude as a connector, and its tools include `get_context`, `get_rules`, `save_session`, `add_idea` and `search`. A saved session appears in OllieOS under Knowledge, Sessions. Its follow-ups go to his Inbox as tasks or promises, its documents are proposed for his Library, and OllieOS reads it for facts and decisions that wait in his Knowledge Inbox for his approval.

## At the start of a session

1. Work out which project or person the session is about. If it is not clear, use the OllieOS `search` tool.
2. Call `get_context` for it. It includes recent sessions on the same subject, so carry on from where the last one ended rather than starting again.
3. Before drafting anything for Ollie (emails, messages, documents), call `get_rules` and follow them.

## Saving the session

Call `save_session` **once**, when the work is done or when Ollie asks. Fill it in like this:

| Field | What to put |
| --- | --- |
| `title` | A short title for what the session was about, up to 200 characters. |
| `summary` | A few sentences: what the session set out to do and where it ended up. Up to 3,000 characters. |
| `outcomes` | What was done, one line each, including every decision Ollie made. Up to 30. |
| `projects` | The projects it was about, by name. |
| `people` | The people it was about, by name or email. |
| `actions` | Follow-ups still to do after the session, up to 20. Each has a `title`, and optionally `kind`, `person`, `project`, `due_date` (YYYY-MM-DD) and `quote` (the words it came from). Use `kind: "promise"` when Ollie said he would do something for someone, and name that person. Otherwise use `"task"`. |
| `artifacts` | Documents produced in the session worth keeping, such as a plan, brief or analysis, up to 10. Give the full text in `content` (Markdown is fine), plus `title`, and optionally `kind` and `summary`. |
| `task_refs` | Tasks already created or updated in OllieOS during this session, such as `task:42`. |
| `transcript` | The key parts of the conversation, if useful. |
| `session_id` | Your own id for the session. Reuse it if you save again, so the same session is updated rather than duplicated. |
| `happened_at` | When the session started, only if it was not today. |
| `confidential` | `true` if the session was about the company sale, the board, pay or HR. |

## Rules

- Do not also call `create_task` or `log_promise` for the same follow-ups. `save_session` creates them from `actions`.
- Never invent decisions, dates or promises. Only record what Ollie actually said or agreed.
- Use British English.
- If an idea worth coming back to came up, add it with `add_idea` (with `from_session: true`) rather than as an action.
- After saving, tell Ollie in one or two lines what was saved: the title, how many follow-ups went to his Inbox, and any names in `unmatched` that OllieOS did not recognise, so he can fix them.
- If the OllieOS tools are not available, say so and ask Ollie to switch the OllieOS connector on for this chat. Do not pretend the session was saved.
