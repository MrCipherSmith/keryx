# Implementation Plan

Status: ready

## Approach

Take the specification's recommended first release: **an unattended posture that
grants no shell at all and exposes only `risk: "read"` tools.**

The three rounds inside PR #253 all tried to build a posture that *keeps*
`shell_exec` and decides per command which invocations are safe. Round 1 decided
with a destructive-command classifier, round 2 added an operator argv allowlist,
round 3 required a literal command word and banned wildcards after wrapper words.
Each round's rule was better than the last and each round's vocabulary was
behind — `timeout`, `setsid`, `stdbuf`, `flock`, `busybox`, `psql -c '\! …'`.
Removing the tool removes the class of defeat: there is no wrapper to miss when
nothing can be wrapped.

Two mechanisms are deliberately NOT chosen for this release, and both are
documented as the widening path rather than silently dropped:

- **OS sandbox as the boundary** (Seatbelt / bubblewrap, already built). The
  strongest option, and it moves the guarantee to the kernel — but its domain
  allowlist and credential masking refuse to run on Linux today (flows 099/100
  are blocked on hosts), so a posture requiring it fails closed on the platform
  CI runs on. Right answer, wrong release.
- **A literal, wildcard-free argv allowlist.** Round 3 reached this and the
  wildcard-free case held. What defeated it was permitting wildcards at all.
  Kept as the documented next step, gated on the corpus.

## Steps

1. **Context.** Read `docs/requirements/keryx-unattended-posture/` (PRD +
   specification) and `docs/harness.md` (three policy answers, seven risk
   classes). Do not re-derive the design constraint — it cost three review
   rounds and is settled.
2. **Posture declaration.** A launch-time flag on `keryx shell` (shape, not
   spelling: `--unattended[=<profile>]`) that selects a tool set rather than an
   approval policy. Resolve provider/model without opening a picker; refuse the
   combination with `--chat`.
3. **Tool-set restriction.** Under the posture the registered tool set is the
   `risk: "read"` operations only; `shell_exec` and every mutating tool are not
   registered, not advertised in the system prompt, and not invocable if the
   model names one anyway.
4. **Approval semantics.** An `ask` with no approver resolves to `deny`; a
   `deny` stays terminal. Neither is reachable in the read-only set, and both
   are asserted anyway so widening cannot quietly change them.
5. **Evidence.** The posture is visible in the TUI header and stamped into the
   run record, so a reader can tell an unattended run from a supervised one.
6. **The corpus.** Ship C-1 … C-5 from the specification as a permanent
   regression suite: real runner, real fixture project, real `git init`,
   asserting the refusal AND that the tree, the graph index and `package.json`
   are unchanged and `.env` unread. C-5's controls must show a benign action
   really runs and that the unflagged default still prompts.
7. **Mutation check.** For each guard, revert it and record which corpus test
   fails. A guard nothing pins is not a guard — this is AC8 and it is the step
   the three failed rounds would have been caught by.
8. **Docs.** `docs/harness.md` + CLI reference: what the posture refuses, what
   it does not, and where the boundary is soft. If a list survives anywhere, say
   it is a list and that it will be incomplete.
9. **Gate + draft PR.** `bun run check`, `bun run check:doc-links`, no test
   skipped or weakened.

## Risks

- **A reviewer finds a fifteenth wrapper.** Mitigated by construction: with no
  shell tool there is no wrapper. If the implementation reintroduces any
  command-word decision, that is a design regression, not a fix.
- **"Read-only is too narrow to be useful."** It is exactly enough for benchmark
  group A and for a CI "answer a question about this repo" step. Ship, measure,
  widen with evidence.
- **The cheap way to pass AC1 is to loosen the default.** AC6 pins the unflagged
  path byte-identical; treat any diff there as a blocker.
- **Docs over-promising.** This work has already produced a category guarantee
  it did not enforce on three separate pages. AC9 exists for that.
