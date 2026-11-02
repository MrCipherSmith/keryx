# Independent integration verification

**Gate: FAIL** at `9a0f4641efc9c4b3c70822637e7b420d9427ba3d`.

Blocking root/browser test dependency defect: `http.contract.test.ts` imports the browser adapter in the root Bun suite, which requires UI-only `i18next`. Actual strict gate452passed/1failed/1skip/1todo (455tests,64files,8092assertions). Parent confirmed same failure in remote CI; do not inject UI dependencies into root tests. T41 owns moving only the browser assertion to UI Vitest while preserving real served-page validation.

Other checks passed: health lint/types0findings; fullHub535(with UI dependencies present); independent UI197/type/lint/assets; scripts types; Python29+14+5; docs verifier; shell syntax/shellcheck; actual frozen offline archive/SDK runtime9tests61assertions. FullHub success does not override the failing root-only strict gate.

Full commands/counts/logs in companion JSON. UI dependency symlink restored. No source changes, commits, pushes, installs or production actions. Waiting for post-T41 freeze before rerunning strict and affected UI checks.
