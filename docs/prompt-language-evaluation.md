# Instructions language evaluation

The live Jev comparison for review item #12 completed on 2026-09-24. **Keep the current production Chinese instructions.** The English candidates remain available as an evaluated alternative in [the fixed fixtures](../scripts/prompt-evaluation-cases.mjs).

Eight synthetic cases each ran once with Chinese instructions and once with English instructions against `jev-1.13.0`: four filing cases and four link-resolution cases, covering Chinese, English, mixed-language content and abstention. Within each pair, state, options, option order and local-context JSON were identical; only instructions language changed. Pair order alternated. All 16 serial requests completed without retries.

| Measurement | Chinese instructions | English instructions |
| --- | ---: | ---: |
| Expected target ID selected | 8/8 | 8/8 |
| Reported input tokens, total | 4,745 | 4,525 |
| Mean elapsed time | 358 ms | 361 ms |
| Requests with unknown token count | 0 | 0 |

English used 220 fewer input tokens (4.6%) in this run. Neither language improved target accuracy on these eight examples. This small sample does not establish broader quality equivalence, superiority or a stable latency difference. It provides no accuracy reason to change the production prompt and invalidate cached or persisted suggestions unnecessarily.

The [raw metadata-only JSONL](evaluations/prompt-language.jsonl) records each target ID, hit, token count and elapsed time plus the summary; it contains no credentials, note bodies or complete requests. The [script instructions](../scripts/prompt-evaluation.md) describe the controlled comparison and how to reproduce it. Production prompts were not changed as a result of this evaluation.
