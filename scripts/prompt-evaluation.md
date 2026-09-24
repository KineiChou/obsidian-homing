# Instructions language comparison

This is an offline-prepared, small paired evaluation for review item #12. It does not replace production Chinese instructions. Candidate English instructions and fixed synthetic fixtures live in `prompt-evaluation-cases.mjs`. It imports the production `JevClient` through an in-memory esbuild bundle when running live.

## Run

Use Node 22.12+ and installed development dependencies from the repository root:

```sh
node --test scripts/prompt-evaluation.test.mjs
node scripts/prompt-evaluation.mjs --dry-run
node scripts/prompt-evaluation.mjs --live > prompt-evaluation-results.jsonl
```

For the live command, paste a Jev key into stdin and press Enter. Terminal input is not echoed; no credential is written to disk. Avoid putting keys in command arguments, shell history, or committed files. Diagnostics go to stderr; stdout contains JSONL measurement records and a final summary. Noninteractive callers may supply the key through stdin. This script has not itself established provider quality: an operator must run the live comparison and review its results.

## Controlled comparison

Eight synthetic cases cover filing and link disambiguation, each with Chinese, English, mixed-language and abstention cases. Filing also covers project purpose, subtree rules and an instruction embedded in note data. Each case runs twice against pinned `jev-1.13.0`, once with current Chinese instructions and once with a candidate English translation. State, local-context JSON, option IDs, option order and all option descriptions remain identical within a pair. Linking retains local JSON in instructions, matching production. The language of option descriptions is deliberately unchanged. Chinese baseline drift is checked offline against production source.

There are at most **16 serial Jev requests**, with one question per request and **no retries**. Pair order alternates Chinese-first and English-first. The first request error stops the run; incorrect target choices do not stop later pairs. Fetch times out after 30 seconds; timeout does not establish whether the provider billed the request. No scheduler or vault is involved.

Records contain case/domain/content language, instruction language, model, expected and selected target IDs, hit, reported input tokens (null means unavailable), and local elapsed milliseconds. They exclude keys, body text, prompts, full requests/responses and provider error messages. Failed requests use only a fixed error marker. Summaries report completed requests, hits, completed-pair hits, known token totals, missing-token counts and mean latency. Compare paired hits when a run is incomplete; token totals exclude unknown values. Latency includes transport and parsing and may reflect transient service conditions.

These eight hand-authored examples are a bounded diagnostic, not a statistically reliable quality benchmark. Inspect individual paired outcomes and abstention behavior alongside cost and latency; do not replace production prompts solely because English uses fewer tokens or wins a single run. A successful process exit indicates completed requests, not perfect accuracy. Errors exit nonzero. Logs and live result files are operator artifacts and should not be committed automatically.
