# Round 2 fixes — PR 1008 (head 39861592)

| Id | Severity | Disposition | What changed |
|----|----------|-------------|--------------|
| R2-01 | minor | fixed | The unlocatable-quote refusal no longer offers "ingest without --head": in a git checkout the head falls back to the checkout's HEAD, so the same finding is refused again. The message ends "Re-quote one distinct line from `git show <head7>:<path>` or dismiss the finding with evidence." The test pins that the sentence is gone. |
| R2-02 | minor | fixed | The URL test now uses `https://example.com/view?doc=docs/a.md`, which only the URL strip keeps out of the result; a new test puts a real file outside the tree and expects `citation not found` for `../<name>.md`. Kills r2-cite-url-kept and r2-lex-guard-off (checked by manual mutation of the guard). Correction: round 1 claimed r1-cite-url-kept was killed by its test; it was not. |
| R2-03 | info | not changed | Unpinned edges without a demonstrated effect (tilde fence inside a backtick fence, `na`/`nil`/dash placeholders, lowercase bare names by design, the lost warning on the path where the report already says the PR moved). |

Deferred from round 1 and not re-filed: R1-03, R1-10, R1-12.

Verification: the two touched test files pass (18 tests); the full check is left to CI.
