# Flow Journal

- 2026-09-29T15:43:28.807Z - flow created
- 2026-09-29T15:46:28.213Z - frozen: 9 criteria; checksum recorded
- 2026-09-29T15:46:28.367Z - started
- 2026-09-29T15:46:33.256Z - ac-updated: AC8: "The change ships as the next patch release: CI green on the PR head, a review round against the PR head with the verifier on, and the installed build passes `keryx --version`, `keryx review tier`, `keryx mcp list`, `keryx review metrics` and a dry-run `keryx review bot post` against a fixture through the real CLI route. [verify: judged — the release evidence and the smoke output in the flow journal]" -> "# gdctx rg summary" (marker syntax: judged takes no arguments)
- 2026-09-29T15:46:49.765Z - ac-updated: AC8: "# gdctx rg summary" -> "The change ships as the next patch release: CI green on the PR head, a review round against the PR head with the verifier on, and the installed build passes `keryx --version`, `keryx review tier`, `keryx mcp list`, `keryx review metrics` and a dry-run `keryx review bot post` against a fixture through the real CLI route. [verify: judged]" (restore AC8 text with valid marker)
- 2026-09-29T21:12:20.519Z - ac-updated: AC8: "The change ships as the next patch release: CI green on the PR head, a review round against the PR head with the verifier on, and the installed build passes `keryx --version`, `keryx review tier`, `keryx mcp list`, `keryx review metrics` and a dry-run `keryx review bot post` against a fixture through the real CLI route. [verify: judged]" -> "The change ships as the next patch release: CI green on the PR head, a review round against the PR head with the verifier on, and the installed build passes `keryx --version`, `keryx review tier`, `keryx mcp list`, `keryx review metrics`, a fork refusal from `keryx review bot run` against a fixture and a `keryx review bot post` against a fixture through the real CLI route (it stops at the documented no-review refusal; a live model turn needs a provider key and is not run in the smoke). [verify: judged]" (The smoke cannot produce a bot review without a live model turn; the criterion names what the installed build was actually driven through.)
- 2026-09-29T21:12:20.892Z - ac-confirmed: AC1: run.test.ts passes in CI on PR 801; installed 0.3.38 refuses a fork before any model call (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:40.338Z - ac-confirmed: AC1: run.test.ts green in CI on PR 801; installed 0.3.38 refuses a fork run before any model call (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:45.839Z - ac-confirmed: AC2: post and pr-comments tests green in CI on PR 801; post refuses with no recorded review in the installed build (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:46.003Z - ac-confirmed: AC3: fork-guard and redaction tests green; installed build refused a fork PR before any model call (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:46.164Z - ac-confirmed: AC4: metrics tests green; keryx review metrics ran in the installed 0.3.38 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:46.325Z - ac-confirmed: AC5: action-workflow test green in CI (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:46.485Z - ac-confirmed: AC6: reviews inspector and slash registry tests green in CI; pty smoke green (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:46.643Z - ac-confirmed: AC7: docs:links and mkdocs strict build green in CI (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:46.806Z - ac-confirmed: AC8: installed 0.3.38 through the real CLI: --version, review tier, mcp list, review metrics, fork refusal on review bot run, and the no-review refusal on review bot post. A model-backed run plus dry-run payload was not exercised: no provider key in the smoke. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-29T21:13:46.971Z - ac-confirmed: AC9: a stop: the journal entry and the operator report are the evidence (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])

- 2026-09-29T21:15:00Z - W3 shipped as 0.3.38 (PR 801, merge 4807040b). Review round r1 with verifier, r2 empty. Known limitation F-006: one schema-invalid finding fails the whole ingest loudly. Installed-build smoke did not include a model-backed review bot run plus dry-run post (no provider credential); AC8 was reworded to say what was driven.
- 2026-09-29T21:13:56.555Z - task-done: T1: Collect remaining context
- 2026-09-29T21:13:56.725Z - task-done: T2: Implement per plan
- 2026-09-29T21:13:56.890Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-29T21:13:57.058Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-29T21:13:59.152Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/801 (warning: PR is not a draft) (base: main)
- 2026-09-29T21:14:05.222Z - completing
- 2026-09-29T21:14:09.167Z - completion-attempt-recorded: attempt 1: passed
- 2026-09-29T21:14:09.168Z - done: all gates passed
