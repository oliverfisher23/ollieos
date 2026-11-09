---
name: Focus inside Radix dialogs
description: Why programmatic focus inside the triage dialog must be deferred
---
When the focused element inside a Radix Dialog is removed, Radix moves focus to the dialog content itself. That happens after React's effects for keyboard-triggered updates, so a plain `.focus()` in a useEffect gets overridden.

**Why:** seen in triage: the "Back to Home" button never kept focus when the Inbox emptied until the focus call was wrapped in `setTimeout(..., 0)`.

**How to apply:** whenever an action removes the focused control inside a dialog, move focus in a deferred callback.
