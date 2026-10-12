# PR #794 review, round 2 (flow363-pr794-review-r2)

Re-run at the PR head ebe617b9. The only change since the round-1 fix head 6a430094 is the import path: the description helpers are re-exported through `src/flow/service.ts` and read from there by `src/product/extract.ts` and `src/commands/flow.ts`, which brings the import-policy facade-bypass count back to its ceiling. No parser, gate or data-path code changed. No new findings.

```json keryx:findings
[]
```
