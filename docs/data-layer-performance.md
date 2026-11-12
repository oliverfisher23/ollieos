# Data-layer performance verification

All checks below used synthetic records in the disposable `ollieos_test` database.
They do not establish production row counts, production query plans or a measured
production speed-up.

## Changes and regression coverage

- **AI activity:** indexed recent-group headers are written atomically with audit
  events. A one-time startup migration backfills old history. The listing selects
  at most 100 group headers before aggregating indexed events in those groups.
  Reference previews use an ordered `LIMIT 3`, not a full `array_agg`.
  Tests cover a 105-event batch, more than 100 groups, later events appended to an
  old batch, empty searches, backfill idempotence and transaction rollback.
- **Ask:** bounded recursive queries replace per-turn parent and child requests.
  Prior context loads only its actual turn budget, and the saved response reuses
  those turns while fetching only missing older ancestry. Tests cover 65 turns,
  the 50-turn limit, branch selection, a fixed query count and follow-up saving.
  Equal-time children are resolved deterministically by descending id.
- **Document projections:** Library knowledge metadata selects only its five
  consumed fields. AI document reads select the first 4,001 characters in SQL,
  retaining the existing 4,000-character clipping behaviour and indicator.
  A query-capture regression test prohibits `read_text` and `SELECT *` in the
  Library metadata query.
- **Drive import:** one initial URL lookup, conflict-safe inserts and queue
  upserts in chunks of 25, and one response enrichment batch. Tests cover a
  60-file folder, response order and its 50-document cap, reimports, concurrent
  duplicate protection, create-audit counts and requeueing an active reader.
- **Inbox links:** only candidate thread ids are queried. An expression index
  normalises historical Gmail URLs without requiring a data rewrite. `DISTINCT
  ON` retains open-first/latest selection, with id as an equal-time tie-breaker.
  Tests cover account-specific URLs, closed tasks, sent/chase exclusions,
  unrelated history and a zero-query empty candidate set.
- **Sessions:** select a bounded session page, aggregate matching suggestions
  once with filtered counts, then left join to preserve zero counts. Both list
  and detail paths are covered.

## Representative session plan

The regression suite runs `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the actual
session listing SQL with 1,000 sessions, 10,000 suggestions and a 300-session
page, after analysing the fixture tables.

The inspected plan used the `suggestions_source_status_result_idx` index for the
matching source references and one aggregate over the joined suggestions.
PostgreSQL chose 300 indexed probes within that single aggregate query rather
than three correlated count subqueries per session. This is a planner choice,
not a claim that all sessions must use one sequential scan.

The plan is regenerated at `generated-artifacts/data-layer-session-plan.json`
(excluded from Git and deployment). Tests also verify that all five new indexes
exist. Exact timings are intentionally not used as pass/fail thresholds.

## Commands

```sh
pnpm run typecheck
pnpm --filter @workspace/api-server run test
# Only the new focused tests:
pnpm --filter @workspace/api-server exec vitest run test/data-layer.test.ts
```

The completed full run passed all 29 test files and 279 tests. The development
schema was pushed and the API workflow restarted successfully. Production schema
and deployment were not changed.
