# Survivors judged — round 2

| Mutant | Judgement |
|---|---|
| r2-cite-url-kept | R2-02. The added test does not discriminate: the lookbehind already rejects the cited URL path. Input `?doc=docs/a.md` would. |
| r2-lex-guard-off | R2-02. The guard is tested as a pure function only. Effect: a rebuttal citing a file outside the tree reads as present. Advisory. |
| r2-gate-unusable-dropped-sayso | R2-03. Only a warning is lost, on the path where the report already says the PR moved. |
| r2-ev-fence-char-off | R2-03. Needs a tilde fence inside a backtick fence. No effect shown. |
| r2-ev-placeholder-narrow | R2-03. `na`, `nil` and dash placeholders are untested. |
| r2-cite-root-lowercase | R2-03. Lowercase bare document names are not checked by design (R1-04). |
| r2-cli-detect-off | Equivalent in effect: without `detect()` the adapter's own failure path returns the same warning. Not filed. |
