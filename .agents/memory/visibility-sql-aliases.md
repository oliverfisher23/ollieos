---
name: Visibility SQL alias clashes
description: The raw SQL visibility checks use short aliases inside their subqueries; outer aliases must not reuse them
---
The visibility helpers (projectVisible, strategyVisible, ideaVisible and friends) return raw SQL whose inner subqueries alias tables with short names such as `x`. Wrapping one in a query whose outer alias is also `x` makes the inner column references resolve to the wrong table ("column x.project_ids does not exist").

**Why:** cost a debugging round when a service checked AI visibility with `select x.id from ideas x where ...`.

**How to apply:** when calling a visibility helper with your own alias, use a distinctive one (for example `row_in`) or the plain table name.
