---
name: Research agent model quirks and cost
description: Web search plus structured output with Sonnet, how the answer comes back, and what a company costs
---
- With web search and a json_schema output, the answer can come as several text blocks (citations split it, and thoughts can come before it). Join them and parse from the FIRST `{"name"`: nested people objects also start with `{"name"`, so lastIndexOf cuts into the middle and every run fails.
- Cost measured on a real company: 5 searches, ~87k input and ~3k output tokens (another run with 6 searches was ~131k input). Search results are what drive input tokens, about 15k to 20k per search. Told Ollie 25p to 45p a company.

**Why:** the first real run failed twice on the lastIndexOf parse, and my first cost estimate (5p to 15p) was well under the real figure.

**How to apply:** when changing the research model, prompt or search count, re-measure on one real company before quoting a cost; if Ollie wants it cheaper, Haiku or fewer searches are the levers.
