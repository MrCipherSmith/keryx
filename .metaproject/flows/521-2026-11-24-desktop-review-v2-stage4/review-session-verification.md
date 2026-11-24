# Review scope, session continuity and large-plan verification

## Desktop entry points

Two independent local attempts used the same real pull request and pinned revision. Review publication was disabled. The host API and the merge-base diff agreed on three changed files, 169 additions and two deletions. An integration-test TSX file did not add a UI or layout reviewer. A project review rule for the changed production store selected full depth.

| Launch | Result | Session verification |
| --- | --- | --- |
| Ordinary chat, automatic orchestrator | 15 of 15 assigned checks finished. No operator questions. | The card appeared on the board. Its primary action opened the original conversation. A follow-up read the authoritative progress, and the request and reply survived a native app restart. |
| Pull requests board, one reviewer | The reviewer finished and the run reported partial coverage. No operator questions. | The primary action opened the interactive review session with its original transcript. It accepted a normal follow-up. |

The native macOS application showed the repository and PR, file count, additions, deletions, selected reviewers and reasons, current stage and completion. Historical coordinator activity loaded in both directions. A separate real shell-driven review was visible while its originating task was active and stopped showing as running when that task finished while an unrelated background job remained active.

## Larger plans

The shared planner keeps the hosting base and comparison base distinct. Expansion decisions are tied to the actual revision and plan. Manual confirmation and bounded automatic approval are covered separately, including a moved head and a smaller explicit budget. A synthetic large-plan fixture exercises native admission without incurring model charges for hundreds of reviewer calls.

The reviewer-routing tests use mixed scopes, all three provider/model pools, explicit tier floors and a model shared between pools. A further real launch used a different model in each configured tier. Its 15 assignments selected four Strong and eleven Middle routes. Runtime sessions exposed the selected provider and model. The Light route was exercised in the mixed-scope fixture. Fourteen reviewers completed and one returned partial coverage because it could not verify a project rule at the base revision. The coordinator finished with a draft. After a cold start of the final native build, the terminal card showed the three changed files, depth rule, final coverage, and all 15 model/tier assignments with reasons. None of the three runs published a review.

## Verification runs

The Desktop suite passed 1,211 tests. The final affected CLI run passed 875 tests across 28 files, with each file in its own Bun process and Git hooks disabled for the temporary repositories. An earlier combined run hit the default five-second timeout in publication tests. The publication suite also passed independently with its default timeout. The native Rust library passed 268 tests with one ignored. A separate run covering coordinator-event resume, progress accounting and chunk estimates passed 65 tests. These suites overlap. TypeScript, Clippy with warnings as errors, and the Desktop build passed. Review-orchestrator preflight passed 85 tests. Documentation checks passed 67 tests. The ESLint and TypeScript code-health run returned zero findings.

## Verification materials

The local QA directory contains the macOS application, a verification report with the two attempt and session identities, and the ordered command references. The public flow records the behavior and counts. Session transcripts and the reviewed project's source stay in the local QA workspace. The original flow's separate publication exercise (T10) remains open.
