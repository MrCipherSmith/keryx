# Context

Collected deterministically by `keryx flow init` at 2026-08-08T23:45:13.743Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-08T20:19:50.211Z)
- refresh: `keryx health run`

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

### Requirements package (read these before any code)

| Source | What it settles |
|---|---|
| `docs/requirements/keryx-linux-containment/specification.md` §4.1–4.4, §10 | the model, the `<bun> landlock-exec.ts --ruleset … -- <cmd>` shape, why network-off is not equivalent, the **grant list** (§4.4), AC1–AC11 |
| `docs/requirements/keryx-linux-containment/implementation-plan.md` "Step 3" | the six constraints that are not negotiable in review |
| `docs/requirements/keryx-linux-containment/spike/README.md` "What Step 3's implementer must know" | the FFI facts below, measured on this host |
| `docs/requirements/keryx-linux-containment/spike/landlock-ffi.ts`, `spike/landlock-exec.ts` | working reference implementation — **evidence, not shippable code** |
| `docs/decisions/keryx-harness/ADR-0010-linux-containment-without-privilege.md` | the three layers, the delivery shape and its revisit trigger |

### Code surface as it stands on this branch

| File | State |
|---|---|
| `sandbox/landlock.ts` (707 lines) | pure translator. `handledFs = WRITE_ACCESS_RIGHTS` only — **reads are unhandled, therefore unrestricted**. `readDenyFailures()` refuses any non-empty `readDenyList`. Reworked by this flow (§4.4). |
| `sandbox/landlock-abi.ts` | injectable reader + per-process cache. `LANDLOCK_ABI_UNAVAILABLE = 0`. Imports nothing — a source guard holds that. |
| `sandbox/probe.ts` | the only spawning module. `SandboxLayer`, `ProbeResult`, `runContainmentProbe`. |
| `sandbox/wrap.ts` (67 lines) | pure dispatcher: darwin → seatbelt, linux → bwrap, `restricted` → fail-closed, other → fail-closed. No Landlock branch. |
| `sandbox/detect.ts` (104 lines) | `SandboxLauncherInfo.available: boolean`, injectable `existsSync`/`env`/`platform`, no spawn. |
| `sandbox/index.ts` | publishes `buildLandlockRuleset`, the ruleset types, `cacheLandlockAbi`. The UAPI bit table stays module-private to `./landlock` for the applier. |

`detect.ts` dependents (gdgraph): `src/commands/harness.ts`,
`src/harness/tool/builtin/shell-exec-tool.ts`, `src/lib/serve-runner.ts`,
`src/commands/sandbox.ts`, `scripts/stress/keryx-shell-stress.ts`, plus
`adapter.ts` via `launcherAvailable: boolean`. Specification §9 says callers are
unchanged — so `available` stays as a derived field and `layer` is added beside
it, rather than a rename that touches six call sites for no boundary gain.

### FFI facts, measured (spike, flow 143) — get these wrong and the failure is silent

- `glibc` has no Landlock wrappers: everything goes through `syscall(2)`,
  declared to `bun:ffi` with arity **7** (number + 6 args). A shorter declaration
  hands the kernel an uninitialised stack slot on x86_64.
- `struct landlock_path_beneath_attr` is packed: **12 bytes**, not 16.
- `struct landlock_ruleset_attr` is **8 bytes below ABI 4, 16 from ABI 4**.
- Rule paths are opened `O_PATH | O_CLOEXEC`, must be **directories**, and every
  rule is masked with the handled set.
- `PR_SET_NO_NEW_PRIVS` **must** precede `landlock_restrict_self` (else `EPERM`).
  It is not what keeps the ruleset attached — nothing sheds a Landlock domain.
- `handled_access_fs` must be clamped to the measured ABI (unknown bit ⇒
  `EINVAL`). The clamp is asymmetric: a **newer** kernel silently leaves its new
  access classes unhandled and therefore unrestricted.
- `execve`, not `Bun.spawnSync`: spawn leaves Bun resident as the parent of every
  contained command. Raw `execve` does **no PATH search**.
- Cost: ~40 ms per contained command (≈4× bwrap), of which ~1 ms is Landlock;
  the rest is a second Bun cold start, structural because rules may never be
  applied in the keryx process. Prebundling the child saves ~3 ms of ~13 ms.
- A nested Bun whose cwd is outside the ruleset dies with
  `CouldntReadCurrentDirectory` before user code runs.

### Lessons this flow is required to carry

- **A probe without a negative control is not evidence** — the spike published
  three greens that proved nothing (`ECONNREFUSED` read as a denial; an absent
  output file read as a denial; a benchmark timing a helper that exited at argv
  parsing). Every enforcement assertion here needs a control that fails when the
  boundary is removed.
- `.metaproject/memory/lessons/allowlist-not-a-boundary.md` — a boundary
  asserted against a string, not against the kernel, is not a boundary.
- `.metaproject/memory/constraints/stale-installed-keryx-binary.md` — the
  `keryx` on `PATH` is a stale build; verify against this checkout, not the
  installed CLI.
- `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-…` — fix rounds
  get their own review pass.

### Baseline

- Code Health gate: pass (2026-08-08T20:19:50Z), score 93, one pre-existing WARN.
- `bun test src/harness/process/sandbox`: 243 pass / 5 skip / 0 fail (flow 145).
- Whole-repo `bun test`: 3330 pass / 14 skip / 2 fail — both pre-existing in
  `scripts/install-global.test.ts`.
- This host is Landlock **ABI 4**, so AC4–AC7 can be exercised here; the AppArmor
  `bwrap` profile is installed here, which is why AC10/AC11 (step 5) cannot be.
