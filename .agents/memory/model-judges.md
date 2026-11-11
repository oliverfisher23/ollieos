---
name: Yes/no judges need an explicit boolean
description: Haiku structured-output judges list "not a match" items with a negative reason; never treat presence in a list as a yes
---
A Haiku judge asked to "return every item that contradicts" still returned items whose own reason said "so no contradiction". In production that flagged two of the first three conflicts falsely.

**Why:** with thinking off and low effort, the model fills the list while reasoning in the "why" field, and decides after writing it.

**How to apply:** for any judge that returns matches, have each entry carry a reasoning field first, then an explicit boolean, and filter on the boolean. Check one real run against live-like data (e.g. Ollie's six rules) before a backlog is processed, because a backlog multiplies a bad verdict rate.
