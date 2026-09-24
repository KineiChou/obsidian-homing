# Folder profile evaluation

Run from the repository with Node 22.12+ and installed development dependencies:

```sh
node scripts/profile-evaluation.mjs /private/tmp/profile-evaluation-results.json
```

Provide a Jev key on standard input when prompted. Terminal input is not echoed. Do not put credentials in command arguments or files. Only fixed synthetic notes are sent. The script uses the production Jev client, folder classifier, folder profiles and scheduler, with retries disabled. It makes at most 40 HTTP requests and stops on the first error. Each network request times out after 30 seconds.

The seven fixed cases cover six domains and one ambiguous note, with 300 identical candidate directories under both conditions. Off/on order alternates between cases. Most paths deliberately do not state their topic; the baking folder has an explicit manual purpose. This tests the value and cost of metadata in that setting, not a representative real-vault accuracy rate.

The pending template is `scripts/profile-evaluation.pending.json`. The output file starts as `not-run`, becomes `completed` only after all fourteen case/condition evaluations finish, or `incomplete` on failure. Rows contain only case IDs, selected/expected folder IDs, hit flags, actual HTTP request counts and usage metrics. No credentials, note text, request bodies or raw service responses are logged or written.

Compare `summary[0]` (off) and `summary[1]` (on): `hits`, `requests`, and `inputTokens`. `inputTokens` sums only service-reported counts; nonzero `unknownTokenResponses` means the token total is incomplete. HTTP requests remain billable even if a response fails. A completed run with lower accuracy is still valid evidence and is not treated as an execution error. The unit tests verify corpus and accounting mechanics with response stubs; they are not model-quality evidence.
