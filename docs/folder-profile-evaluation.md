# Folder profile evaluation

A live Jev `jev-1.13.0` run compared folder profiles off and on using the fixed `folder-profiles-synthetic-2026-09-24` corpus. The production classifier, profile builder, client and scheduler processed seven synthetic notes against the same 300 candidate directories. No real vault notes were used. The [raw report](evaluations/folder-profiles.json) contains all fourteen case/condition results; the [runner instructions](../scripts/profile-evaluation.md) explain reproduction.

| Condition | First-choice hits | Actual HTTP requests | Reported input tokens |
| --- | ---: | ---: | ---: |
| Profiles off | 5 / 7 | 14 | 105,522 |
| Profiles on | 7 / 7 | 8 | 62,587 |

Every response reported input-token usage. The hit count includes the ambiguous note, for which the expected and returned selection was `unassigned` in both conditions. Profiles corrected the electrical-engineering and gardening cases in this run. Each of the six clear-topic cases used one request with profiles, compared with two without profiles.

## Full-catalogue cost counterexample

The ambiguous `ambiguous-unassigned` case had insufficient evidence for prefiltering, so the profile-enabled classifier kept the full catalogue. Both conditions used two requests and correctly returned `unassigned`, but input tokens increased from **15,033 to 27,938** with profiles because the folder metadata was included. This case demonstrates the cost of retaining the full candidate set when evidence is weak; it did not exercise rejection of a shortlist followed by a second full-catalogue pass. That separate safeguard can also increase requests.

## Limits of this evidence

This is one run of only seven fixed synthetic cases, covering six domains and one ambiguous note. Most directory paths deliberately obscure their topic; the baking folder retains an explicit manual purpose. The setup tests metadata under those conditions, not a representative sample of real vaults. The observed 5/7 versus 7/7 counts are not estimates of general accuracy, and the aggregate token reduction is not a guarantee of savings for every note. Input tokens and HTTP counts are measured separately; this report does not calculate billed monetary cost. Unit-test stubs validate accounting only and are not part of these model-quality results.
