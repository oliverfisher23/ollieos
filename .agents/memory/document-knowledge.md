---
name: Knowledge from documents and Dropbox
description: Non-obvious rules for the document reader, Sonnet settings and Claude's Dropbox folder (Part E)
---
- Sonnet (`claude-sonnet-5-5`) refuses `thinking: {type: "disabled"}` with a 400; only Haiku accepts it. Send no thinking setting to Sonnet (low effort keeps it from thinking first), or `between_tools` when tools are used.
  **Why:** the shared structured-answer helper sent "disabled" for every model and every document read failed in the first real trial on 10th November 2026; the mocked tests could not catch it.
  **How to apply:** any new direct model call outside Haiku must check this; run one real call before trusting mocked tests.
- Dropbox files are read with a temporary link from the connector proxy, then a plain fetch of that link. The proxy cannot stream file downloads.
- The real cost is about 2p a file. Ollie's folder /Cowork/Springpod has 870 readable files (about £16 to read once). The dev trial on 3 forecast and customer files gave only 1 suggestion (a new organisation), so the reader is conservative.
- Ollie chose to read the whole Springpod folder once, but in production after publishing, not in dev. Dev is pointed at the small Customers/Amazon subfolder only.
  **Why:** dev and production databases are separate, so a dev read would be paid for twice.
