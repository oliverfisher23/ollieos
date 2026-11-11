---
name: Raw SQL subqueries in Drizzle selects
description: Bare column references inside raw sql subqueries can bind to the wrong table
---
Inside a single-table Drizzle select, `${table.id}` in a raw `sql` subquery renders as a bare `"id"`, which Postgres binds to the subquery's own table. It returns wrong results silently (no error).

**Why:** caught by tests on the functions milestone: a function page listed no clients and pending-card checks never matched.

**How to apply:** in raw subqueries, refer to the outer row with a qualified `sql.raw('"projects"."id"')` (or the matching table), not the column object.
