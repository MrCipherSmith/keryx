# Context

Collected deterministically by `keryx flow init` at 2026-08-08T12:07:50.829Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Source documents

| Document | What it contributes |
|---|---|
| `docs/requirements/keryx-linux-containment/specification.md` §4, §4.2, §4.3 | The mechanics to prove, the child-process shape, and the TCP-is-not-network-off constraint the spike must not contradict |
| `docs/requirements/keryx-linux-containment/implementation-plan.md` Step 2 | The four questions, and the instruction that an inconclusive result is itself the answer |
| `docs/decisions/keryx-harness/ADR-0010-...md` | The measurement method (wall clock over runs of `/bin/echo`) and the figures to sit beside: none ~1.8 ms, bwrap ~17 ms, docker ~409 ms |

### Host

Ubuntu 24.04, kernel 6.8.0-136-generic, x86_64, Bun 1.3.11, Landlock ABI 4.
An AppArmor profile for `bwrap` was installed on this host on 2026-08-08 to
unblock benchmark case C4, so bubblewrap **works** here — which is why it can be
measured alongside Landlock, and why this host cannot be used for AC11 of the
main package (plan Step 5 records the same caveat).

### Applicable memory

`allowlist-not-a-boundary` is the relevant lesson: a check that matches on
something adjacent to the real property is not evidence. It applied directly —
the first TCP probe passed on `ECONNREFUSED`, which an absent listener returns
whether or not Landlock is involved. Fixed with a three-case test carrying a
negative control.

### Blast radius

None in `src/`. The spike is self-contained under
`docs/requirements/keryx-linux-containment/spike/`; the repo `tsconfig.json`
includes `src/**/*.ts` only, so the spike carries its own tsconfig and is
outside `bun run typecheck`. Verified: `bun run typecheck` clean,
`bun run check:doc-links` clean (700 links, 0 broken).
