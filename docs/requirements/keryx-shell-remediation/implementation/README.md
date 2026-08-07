# Implementation Dispatches
Version: 1.0.0

Three flow dispatches, each written to be executed by an agent end to end under
the project's flow rule, with no further interpretation needed:

```
flow init → flow task add → flow freeze → flow start
  → implement → tests green → bun run check
  → draft PR → review → merge → flow complete
```

Each dispatch carries: the flow title, the frozen acceptance criteria **verbatim**
(they must be pasted into `acceptance-criteria.md` before `flow freeze`, because
freezing checksums that file), the task list, the exact files, and the definition
of done.

| Dispatch | Flow | Depends on |
|---|---|---|
| [flow-1-agent-can-finish.md](flow-1-agent-can-finish.md) | Parameter parity, unattended posture, prompt reconciliation | nothing |
| [flow-2-tool-surface.md](flow-2-tool-surface.md) | The missing tools, and one composite call | flow 1 |
| [flow-3-scriptable-door.md](flow-3-scriptable-door.md) | Non-interactive tools, provider registry, model ids | nothing — can run in parallel with flow 1 |

The re-measurement (P3) is **not** a dispatch. It is a benchmark run, not an
implementation, and it happens after flow 1 and flow 2 land.

## Rules that apply to all three

1. **Never edit `flow.json` or `acceptance-criteria.md` by hand after freeze.**
   Every state change goes through `keryx flow`.
2. **A test, not a demonstration.** Every acceptance criterion below is written so
   it can be asserted. If a criterion cannot be turned into a test, say so in the
   PR rather than marking it done.
3. **No `deny` is ever weakened.** This is the one line no dispatch may cross;
   flow 1 carries explicit criteria that fail the work if it is crossed.
4. **Docs move with the code.** A flag, a tool or a provider list that changes
   without `docs/docs/cli-reference.md` and `docs/docs/harness.md` changing in the
   same PR has only moved the divergence — the exact defect D4 records.
5. **`bun run check` and `bun run check:doc-links` both green before the PR
   leaves draft.**

## Source of truth

- Findings: [`../../keryx-shell-benchmark/run-2026-08-05.md`](../../keryx-shell-benchmark/run-2026-08-05.md) (read the correction box first)
- Requirements: [`../specification.md`](../specification.md)
- Review: [`../review-2026-08-05.md`](../review-2026-08-05.md)
- Tool surface: [`../tool-surface.md`](../tool-surface.md)
