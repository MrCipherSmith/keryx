# Run 3 — oracle for the `keryx` target (E3)

Computed **before** any leg ran, in a detached worktree at the pinned commit
`8c2918dce3a9058c670252525a6f1e75af01c99f`, with `harness/bin/keryx` 0.2.16 —
the same build every leg sees. Graph: **661 nodes, 1910 edges** (treesitter
capability reported unavailable, deterministic fallback used), which matches
the runbook's §2 check 3 figure.

Grade against this file, not against memory. The `helyx` oracle stays in
[../grading-key.md](../grading-key.md).

## A3 — import cycles

Exactly **four**, and the first two share an edge:

1. `src/commands/shell.ts → src/tui/chat-shell.ts → src/commands/select.ts → src/commands/shell.ts`
2. `src/commands/shell.ts → src/tui/chat-shell.ts → src/commands/shell.ts`
3. `src/mcp/tools.ts → src/mcp/metaproject-tools.ts → src/mcp/tools.ts`
4. `src/wiki/ask.ts → src/wiki/service.ts → src/wiki/ask.ts`

"There are no cycles" is wrong, not cautious — see runbook §6 rule 2.

## A4 — orphans

**23** files unreachable from any entry point:

```
fixtures/change-impacted-test/src/gamma.test.ts
fixtures/churn-complexity/src/churny-simple.ts
fixtures/churn-complexity/src/cold.ts
fixtures/churn-complexity/src/complex-stable.ts
fixtures/churn-complexity/src/hot.ts
fixtures/symbol-graph/source.ts
install.ts
scripts/check-doc-links.ts
scripts/install-global.test.ts
scripts/measure-cold-start.ts
scripts/opentui-tests-no-skips.ts
scripts/sandbox-deep-probe-redaction.test.ts
scripts/stress/concurrent-suite-stress.ts
scripts/verify-opentui-native.ts
src/capability/no-optional-imports.test.ts
src/capability/tui-layout.test.ts
src/commands/security.check-input.test.ts
src/gdgraph/treesitter/no-treesitter-import.test.ts
src/gdskills/review-skills-class-scope.test.ts
src/lib/production-graph.test.ts
src/lib/test-preload.ts
src/mcp/boundary.test.ts
src/tui/shell-fallback.test.ts
```

Most are fixtures, scripts and standalone tests. P3 (verification vs brevity)
is measured here: a leg that reports the bare number without saying that the
list is dominated by fixtures and one-shot scripts has reported a number, not
an answer.

## A1 — and the ambiguity the target introduces

**There is no `config.ts` in this repository.** The prompt names one, and the
tree at the pinned commit has ten files whose name ends in `config.ts`:

| File | Dependents (transitive) |
|---|---|
| `src/security/config.ts` | 21 |
| `src/lib/shell-config.ts` | 19 |
| `src/harness/config.ts` | 18 |
| `src/memory/config.ts` | 18 |
| `src/health/config.ts` | 14 |
| `src/lib/serve-config.ts` | 14 |
| `src/gdgraph/config.ts` | 10 |
| `src/lib/sandbox-config.ts` | 9 |
| `src/mcp/config.ts` | 5 |
| `src/mcp/client-config.ts` | 5 |

On `helyx` the same prompt resolved to exactly one file. Here it does not, so
A1 measures two things at once and the report must separate them:

- **Primary** — can the leg compute a transitive dependent set at all? Grade
  the numbers above against whichever file the leg chose.
- **Secondary** — what does it do about the ambiguity? Naming the ambiguity and
  either asking or stating the choice is the correct behaviour. Silently
  picking one and answering as if the prompt were unambiguous is weaker, and
  inventing a `config.ts` that does not exist is wrong.

The prompt is **unchanged** from run 2, per runbook §8 step 2 ("reuses existing
cases and prompts"). The ambiguity is a property of the target, and it is
recorded here rather than engineered away.
