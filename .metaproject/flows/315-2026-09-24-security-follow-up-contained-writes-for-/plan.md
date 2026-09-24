# Implementation Plan

Status: approved (autonomous run, owner standing rule)

## Approach

Three independent lanes with disjoint files, run in parallel.

### Lane A: contained writes (R5-F1, R5-F3)

Files: `src/commands/init.ts`, `src/testing/service.ts`, `src/lib/metaproject-gitignore.ts`, and `src/lib/contained-write.ratchet.test.ts`.

- Route every write, mkdir, copy, and unlink through writeContained, mkdirContained, or removeContained.
  - Writes under the project are rooted at the project root.
  - A deliberate user-scope target is rooted at its own base directory.
- Add the three files to the ratchet.
- Add regression tests that use escaping symlinks: a manifest, a rules directory, a testing data dir, and `.gitignore`.

### Lane B: audit harness (R8-F1, plus R8-F2 and R8-F3 if they are cheap)

Files: `src/security/audit-harness/index.ts` and its test.

- Rewrite the vacuous agent test. The new version is a restricted agent with a UTF-16 BOM and an auto-run directive, and it asserts `bundle-auto-run-directive`.
- Add UTF-32 BOM detection.
- Fix the direct-path UTF-16 false positive.

### Lane C: learning (R10-F1, R10-F2)

Files: `src/learning/graduate.ts`, `src/learning/extract.ts`, and their tests.

- Re-gate existing proposals on rerun and at apply time.
- Recompute or gate `nextSteps` before printing it.
- Give model-backed drafts a fixed or gated extractor label.
- Gate the sourceRef.

### Test validity

Each lane proves its tests fail on the pre-fix code by temporarily reverting the source with an edit. Never use git stash for this.

## Steps

1. Run lanes A, B, and C in parallel with sonnet workers.
2. The orchestrator runs the targeted tests, plus typecheck and eslint on the changed files.
3. Open a draft PR into feat/agent-platform-expansion.
4. Run an adversarial opus review with bypass attempts. Fix and repeat, up to 3 attempts.
5. Once CI is green, merge. Under the owner's standing rule, 0 blocker and 0 major findings means merge.
6. Close the flow.

## Risks

- `init.ts` has 1952 lines and may write to user scope on purpose, so each containment root has to be chosen per target.
- The ratchet scans source text, so aliases and wrappers such as writeFileAtomic have to be removed.
- Commit 94ba146c's claim of "every .metaproject writer" was too broad. The claim is corrected in the PR body and the journal, not by rewriting history.
