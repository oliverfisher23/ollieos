---
name: Data-layer query constraints
description: Why activity pagination and Gmail task matching must preserve historical grouping and URL variants
---

Do not bound AI activity by taking an arbitrary tail of audit events before grouping. A single read call can emit many events, and later events may belong to an older batch. Select whole recent groups first and preserve their complete counts.

**Why:** the activity screen represents actions, not individual delivered items. Splitting a batch changes the meaning of the count even if the screen still looks correct.

**How to apply:** any future activity storage or pagination redesign must retain complete batch semantics and atomic navigation-header updates with the detailed events.

Do not replace Gmail thread matching with equality against one canonical full URL.

**Why:** Gmail links can have different account segments for the same thread. Historical email tasks must still link to the current inbox without rewriting their source URLs.

**How to apply:** normalise and index the thread identity, or retain an equivalent indexed expression that supports those historical URL variants.

Never index an expression (`index().on(sql\`...\`)`). Replit's publish step copies indexes to production and garbles expression indexes (it drops a closing bracket or the last character), so publishing fails. Store the value in a generated column (`text(...).generatedAlwaysAs(sql\`...\`)`) and index that column instead, as `audit_events.batch_key` and `tasks.gmail_thread_id` do.
