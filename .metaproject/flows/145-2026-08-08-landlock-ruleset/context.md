# Context

Collected deterministically by `keryx flow init` at 2026-08-08T13:09:57.909Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

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

### Requirements package

- `docs/requirements/keryx-linux-containment/specification.md` — §3 layers, §4
  Landlock mechanics (§4.3 is the binding constraint), §10 AC1/AC2.
- `docs/requirements/keryx-linux-containment/prd.md` — R1–R3, N2, N3, risk table.
- `docs/requirements/keryx-linux-containment/implementation-plan.md` — step 3,
  and the three non-negotiables review will enforce.
- `docs/decisions/keryx-harness/ADR-0010-linux-containment-without-privilege.md`.

### Code the translation has to agree with

- `src/harness/process/sandbox/profile.ts` — `SandboxProfile` is the input and
  does **not** change. Note `defaultReadDenyList(home)`: every policy-derived
  profile with a known home has a non-empty `readDenyList`.
- `src/harness/process/sandbox/bwrap.ts` — the shape to mirror: pure builder plus
  a `wrap*` that produces a `ContainedCommand`. Only the builder half is in this
  lane; the wrap half needs the applied-rules mechanism from the step 2 spike.
- `src/harness/process/sandbox/wrap.ts` — read for the fail-closed idiom
  (`{ ok: false, reason }`) and the existing `network: "restricted"` refusal on
  Linux. Not modified.

### Boundary of the semantic model (the load-bearing fact)

Landlock allow-rules are cumulative along a path — kernel docs, *Layers of file
path access rights*: "one policy layer grants access to a file path if at least
one of its rules encountered on the path grants the access". There are no deny
rules, and `landlock_add_rule` rejects an empty `allowed_access` (`ENOMSG`), so a
deeper rule cannot narrow a shallower one. Every "deny X under a broad allow"
profile therefore has no faithful representation. This single fact decides the
`readDenyList` outcome and is why `handled_access_fs` is computed from what the
profile restricts rather than fixed.

### Parallel work — do not touch

Two other agents are in this package concurrently. Off-limits: `detect.ts`,
`capability-matrix.ts`, `src/commands/sandbox.ts`, `scripts/install.sh`,
`wrap.ts`, `seatbelt.ts`, `profile.ts`, `bwrap.ts`, `adapter.ts`, proxy/TLS.
`sandbox/index.ts` is touched only by appending an export block.
