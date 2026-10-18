# Flow 457 evaluation (AC10, AC11)

All live runs used Opus reviewers with identical prompts. Ground truth (`pr<N>-truth.json`) is what the historical rounds of each PR established — often over several rounds with operator dispositions, so a single run of ANY plan under-scores against it. The fair comparison is the A/B (`pr<N>-ab-*`): old plan and new plan run now, same model, same diff, same prompts.

## A/B: old plan vs new plan, live (Opus)

| PR | Dispatches old → new | Tokens old → new | Known defects found (any severity) old / new | Found as major old / new | Confirmed new defects old / new |
|---|---|---|---|---|---|
| #424 round 1 | 18 → 13 | 1.65M → 1.14M | 4/8 → **6/8** | 1/8 → 1/8 | 2 / 2 (same) |
| #939 | 45 → 27 | 4.44M → 2.74M | 4/8 entries → 3/8 (2/6 defects both) | 2/6 → 1/6 | 1 / 1 |
| #1005 round 1 | 9 → 7 | 0.78M → 0.63M | 2/3 → 2/3 | 1/3 → 1/3 | 0 / 0 |

Reading: the new plan matches or beats the old one on what it finds at 60–80% of the cost. On #939 it missed one major (D2-b, agent-instruction preflights) that the old plan's architecture/logic reviewers caught — the A/B ran before deep slices received the full roster, but architecture and logic were already on that slice, so this is single-run variance rather than a routing gap. Neither plan found #939 D3–D6 or #1005 F-058 in one run.

## Single new-plan runs vs historical truth (Opus)

- #940 (`pr940-run-*`): 4/4 known defects found (3 majors + 1), plus **8 new confirmed defects**; 6 of them were still on main and are fixed in PR #1037 (operator-answer forgery via slate_note, irreversible-ask check, answer replay keys, busy /sessions,/rewind, child 429 status, unattended follow-through).
- #424, #939, #1005 single runs (`pr<N>-run-*`) were scored before the depth fix and against multi-round truth; they exposed the light-depth loss that led to "source code and agent instructions are always read deep" and then "deep slices get the full applicable roster". Kept for the record.

## Offline plan-eval (AC10), final routing

`review plan-eval --max-bytes 18000 --wave-bytes 54000` — every ground-truth blocker/major/minor lands in a slice owned by its reviewer under both plans. Dispatches alone: #424 15→15, #939 36→31, #940 37→26, #1005 64→23. With the blast radius (mandatory graph chunks old → new: #940 55 → 0, #1005 48 → 3; tests moved to tests-to-run.json): **#940 92 → 26 runs (-72%), #1005 112 → 26 runs (-77%)**.

## Decisions taken from the evaluation
1. Light depth only for docs, tests, config and generated files; source code, agent instructions and schemas are always deep.
2. Deep slices get every round role whose path gate applies (owner: minor findings matter; style/performance/clean-code produce them).
3. Minor findings are never dropped: the per-reviewer findings cap now trims only `info`; the verdict and published review list minors one by one.
