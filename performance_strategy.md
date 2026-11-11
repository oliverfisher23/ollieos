# Performance Strategy

## Hot paths
- Single-user Express 5 / PostgreSQL / Drizzle workspace. Prioritise Home, tasks/planning, email inbox, meetings/briefs and MCP/Ask context/search.
- Home production GETs on 2026-11-11 repeatedly took approximately 300–426 ms, including 304 responses. Treat these as total request measurements, not individual query timings.
- Email inbox polls every 60 seconds, or every 4 seconds while updating. Metadata reads on this path must be bounded to current inbox threads.
- Manual connector checks currently include scheduled preparation in their HTTP response path. Follow-on model work should not delay completion of a selected connector check.

## Large / growing tables
- audit_events: one row per AI-delivered item, plus mutations; recent-activity queries should not aggregate all historical events to produce a bounded page.
- Tasks, suggestions, Ask turns, sessions and knowledge sources accumulate. Actual production row counts and query plans are unknown; do not assert large-table scan behaviour without measurement.
- Deployment connector logs report 870 readable Dropbox files on two checks. This is not a Library document or database-row count.
- Library text is stored up to 200,000 characters per document; AI retrieval consumes only 4,000. knowledge_sources.read_text also retains previous full extraction text. Keep metadata projections separate from body reads.

## Existing workload bounds
- Task list: 500 rows; Review: 1,000; session list: 300; Ask conversation traversal: 50 turns, prior-context budget: 4 turns; Drive folder import: 100 files, up to 50 response documents.
- Upcoming brief generation already has three workers. Gmail/inbox reads use bounded pools and snapshots in several places; preserve these controls and AI visibility/audit requirements.

## Dismissed categories
- (None yet)

## Scan constraints and evidence
- Read-only source/schema/log scan; no database execution, application requests, tests, builds or benchmarks that could mutate data.
- Deployment logs reviewed in full for task 2. No production EXPLAIN plans or slow-query traces were available. Most later web requests returned 401 quickly and do not measure the protected handlers.
