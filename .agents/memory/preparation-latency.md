---
name: Manual check preparation latency
description: Why manual checks queue preparation instead of awaiting unrelated AI jobs
---
Manual connector checks finish once that connector's data and its durable preparation request are saved. Briefs, classification and digest preparation are eventual, coalesced background work, not part of the manual HTTP response.

**Why:** waiting for unrelated AI preparation made a completed connector check look unfinished. A plain untracked background promise would instead risk losing the preparation request during a restart.

**How to apply:** retain durable retry, cross-instance exclusion and the existing per-part order/error isolation when changing preparation. Checks finishing during a pass must retain one later pass so newly arrived data is not missed.

Preparation isolates failures by returning error results, not only by rejecting promises. Treat both part-level errors and partial failure counts as retryable; persist a delay so coalesced checks cannot cause an immediate retry loop.

**Why:** treating a resolved preparation pass as successful can silently discard failed work, despite the queue itself being durable.
