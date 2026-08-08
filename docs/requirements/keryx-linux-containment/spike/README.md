# Spike — can `bun:ffi` apply Landlock, and does it survive exec?

Step 2 of [implementation-plan.md](../implementation-plan.md). Answers the one
unproven assumption in [specification.md](../specification.md) §4.2.

- **Host:** Ubuntu 24.04, kernel 6.8.0-136-generic, x86_64, Bun 1.3.11
- **Landlock ABI:** 4 (reached through `bun:ffi`, matching the number ADR-0010
  measured by other means)
- **Date:** 2026-08-08
- **Reproduce:** `./verify.sh` (17 assertions) and `./bench.sh`

## Verdict

**Yes — `bun:ffi` carries it.** All four questions the plan asked are answered
affirmatively, with no privilege, no namespace, no AppArmor profile and no new
runtime dependency:

1. The ABI query reaches the kernel and returns 4.
2. `landlock_create_ruleset` + `landlock_add_rule` + `prctl(PR_SET_NO_NEW_PRIVS)`
   + `landlock_restrict_self` all succeed from a Bun process.
3. The restriction is enforced in the exec'd command: reads and writes inside an
   allowed hierarchy succeed, and both are denied with `EACCES` outside it.
4. It is inherited by a grandchild **and** a great-grandchild.

**But the delivery shape in §4.2 costs ~30 ms per command, which is ~3× the
bubblewrap it is meant to replace.** The Landlock syscalls are ~1.1 ms of that.
The other ~23 ms is Bun's cold start, paid because §4.2 spawns a *second* Bun to
apply the ruleset. This does not invalidate the approach, but it is a real
number that Step 3 must decide about rather than discover.

## Evidence

`./verify.sh`, 17/17 passing:

| # | Assertion |
|---|---|
| 1 | `landlock_create_ruleset(NULL, 0, VERSION)` → ABI 4 |
| 2 | full apply sequence completes and the command runs |
| 3 | read inside the allowed hierarchy succeeds |
| 3 | write inside the allowed hierarchy succeeds |
| 3 | write outside is denied — `Permission denied` |
| 3 | read outside is denied — `Permission denied` |
| 4 | grandchild write inside succeeds |
| 4 | **grandchild write outside is denied — the restriction is inherited** |
| 4 | great-grandchild write outside is denied too |
| 5 | `NoNewPrivs: 1` in the contained child |
| 5b | `execve` mode: the command's parent is `bash`, not a resident `bun` |
| 5b | control: `--spawn` mode does leave `bun` resident as the parent |
| 5b | exit code 42 propagates in both modes |
| 6 | an inapplicable ruleset exits 125 and never runs the command |
| 7 | control: TCP bind succeeds when the net axis is not handled |
| 7 | `handled_access_net` with no allow-rule denies TCP bind — `EACCES` |
| 7 | an explicit `net_port` allow-rule restores the bind |

The inside/outside pairs matter more than the denials alone: both directories
are `mktemp -d` under `/tmp`, owned by the same user with the same mode, so DAC
cannot explain the difference. Only the ruleset can.

## Measured overhead

Same method as ADR-0010 — wall clock around N runs of `/bin/echo`, mean per
command — but N=30 rather than 5, and every mechanism measured in the same run
so the figures are comparable to each other. Stable across three runs; one
outlier at 41.6 ms was observed under load and is not representative.

| Mechanism | Per command |
|---|---|
| none (`/bin/echo`) | ~1.0 ms |
| bubblewrap (`--ro-bind / / --dev /dev --unshare-net`) | ~9.7 ms |
| **landlock via `bun:ffi` (§4.2 shape)** | **~30 ms** |
| landlock via a compiled C helper (the Codex shape) | ~1.5 ms |
| `docker run --rm --network none alpine:3` (ADR-0010) | ~409 ms |

Decomposition of the ~30 ms:

| Component | Cost |
|---|---|
| Bun runtime cold start (`bun -e '0'`) | ~22.3 ms |
| loading + transpiling the two spike `.ts` files | ~5 ms (~2.7 ms recovered by prebundling to one `.js`) |
| ABI query (syscall 444) | ~0.20 ms |
| create ruleset + 9 path rules + `no_new_privs` + `restrict_self` | ~1.0 ms |
| **all Landlock syscalls together** | **~1.1 ms** |

> ADR-0010 recorded bubblewrap at ~17 ms and bare at ~1.8 ms. This run measures
> ~9.7 ms and ~1.0 ms for the same commands. The difference is session
> conditions, not a correction — do not read it as bubblewrap having got faster.
> Compare figures **within** a table, never across the two.

## What surprised us

**1. The mechanism is cheap; the delivery is not.** Landlock costs ~1.1 ms. The
specification's own §4.2 sentence — "Bun is already a hard runtime requirement,
so this adds **no** new dependency and **no** per-architecture binary" — is
true, and it is exactly what makes the approach cost 20× what the thing it
avoids would cost. The avoided distribution cost is paid back as latency on
every single contained command, forever. That trade is defensible; it should be
made explicitly.

**2. `Bun.spawnSync` leaves Bun resident.** In the naive shape the Bun process
stays alive as the parent of the contained command for its whole lifetime —
tens of MB of RSS per concurrently contained command, and an extra node in the
process tree that the harness would have to reason about for signals and exit
codes. Calling `execve` through the same FFI seam fixes this completely: the Bun
process is *replaced* by the command. `verify.sh` §5b proves both the fix and
the control. **Step 3 should use `execve`, not `spawn`.** It costs nothing and
it makes the contained process tree identical to bubblewrap's.

**3. A nested Bun dies if its cwd is outside the ruleset**, with
`CouldntReadCurrentDirectory` — before any user code runs, so it cannot be
caught or reported nicely. Not a problem for the normal case (the workspace is
both the cwd and writable) but it will bite anyone running a Bun-based command
whose cwd was not granted.

**4. The first TCP test was a false green, and it is worth recording why.** The
obvious probe — connect to a port and see if it fails — returns `ECONNREFUSED`
whether or not Landlock is involved, because nothing was listening. It "passed"
before proving anything. The fix was a three-case bind test where the middle
case is the only one that changes: unhandled → `BOUND`, handled with no rule →
`DENIED:EACCES`, handled with an allow-rule → `BOUND`. This is the same shape of
mistake ADR-0010 exists to correct, reproduced inside the spike verifying it.
**Any probe in Step 1's `probe.ts` needs a negative control or it is not
evidence.**

**5. `glibc` has no Landlock wrappers**, so everything goes through `syscall(2)`.
Declaring that variadic function to `bun:ffi` with a fixed arity works, but the
arity must be 7 (number + 6 args): glibc's x86_64 implementation unconditionally
loads arg6 from `8(%rsp)`, so a shorter declaration hands the kernel an
uninitialised stack slot. This is silent when it goes wrong.

## What Step 3's implementer must know

**Design**

- Use **`execve` via FFI**, not `Bun.spawnSync`, in `landlock-exec.ts`. See
  `execIntoCommand` in `landlock-ffi.ts`. Exit codes propagate correctly in both
  modes (proven), but only `execve` keeps the process tree clean.
- **Prebundle** `landlock-exec.ts` to a single `.js` in the build step. Worth
  ~2.7 ms of the ~5 ms transpile cost, for free — the build script already
  bundles `proxy-worker.ts` the same way, so there is a pattern to copy.
- ~22 ms of Bun cold start is **irreducible** for any Bun-hosted helper.
  `bun build --compile` does not help: it embeds the same runtime. If ~30 ms per
  command is not acceptable, the only way down is the compiled helper, and that
  decision belongs to a human, not to Step 3's implementer.

**Correctness**

- Clamp `handled_access_fs` to the **measured ABI**, not to the header you wrote
  against — an unknown bit yields `EINVAL`. See `fsMaskForAbi`.
- `struct landlock_path_beneath_attr` is `__attribute__((packed))`: **12 bytes**,
  not 16. Getting this wrong yields `EINVAL` that looks like a permissions
  problem.
- `struct landlock_ruleset_attr` is 8 bytes below ABI 4 and 16 from ABI 4 —
  passing the larger size to an older kernel is rejected.
- Open rule paths with `O_PATH | O_CLOEXEC`.
- `PR_SET_NO_NEW_PRIVS` **must** precede `restrict_self`, or it returns `EPERM`.
- A rule may not grant more than the ruleset handles; mask every rule with the
  handled set.
- Rule paths must be **directories** in practice — file targets accept only the
  file-applicable subset of access bits.
- The minimum read-only set for a command to merely *start* on this host is
  `/usr /bin /lib /lib64 /etc /proc /sys` plus the Bun install directory, with
  `/dev` writable. Deriving this from the profile rather than hardcoding it is
  Step 3's problem, and getting it wrong fails as "command not found"-shaped
  errors, not as permission errors.

**Boundaries this spike did not move**

- The ABI-4 TCP axis is **reachable and enforcing** (proven). It remains
  **TCP-only**, so specification §4.3 stands unchanged: `network: "off"` still
  selects bubblewrap until a seccomp filter covers UDP, raw and unix sockets.
  Nothing here contradicts that, and nothing here should be read as making
  Landlock a network-off mechanism.
- Fail-closed behaviour was verified for the launcher only (exit 125, command
  never runs). The adapter-level fail-closed path (spec N1, AC8) is untouched
  and unverified by this spike.
- Only ABI 4 on one kernel was exercised. ABI 1 (Ubuntu 22.04 / kernel 5.15)
  behaviour is **inferred from the headers, not measured** — the size-8
  `ruleset_attr` path and the ABI-1 FS mask have never run.

## If the answer had been no

Recorded because the plan asked for it, and because the numbers make it a live
option rather than a hypothetical. The compiled helper — `alternative-helper.c`
here, `codex-linux-sandbox` in Codex — is **16 KB**, ~120 lines, and costs
~1.5 ms per command instead of ~30 ms. What it would cost keryx:

- a per-architecture binary (at minimum `x86_64` and `aarch64`) built and
  published with every release;
- a C toolchain in CI, and a build step that is no longer "Bun builds Bun";
- the binary in the npm `files` list, so the published package stops being
  platform-neutral — either one fat package or per-platform optional
  dependencies, which is the mechanism ADR-0005 exists to limit;
- signing/notarisation questions the project does not have today;
- a second implementation of the ruleset logic to keep in sync with the pure
  `landlock.ts`.

That is a real cost, and ~28 ms per contained command is a real cost too. This
spike's job was to make both measurable rather than to pick. **The recommendation
is to proceed with `bun:ffi` as specified** — it works, it ships with what keryx
already has, and 30 ms sits far below the 409 ms container the ADR already
accepted as a profile — while recording the compiled helper as the known
optimisation if per-command latency becomes a complaint.

## Files

| File | Purpose |
|---|---|
| `landlock-ffi.ts` | the `bun:ffi` binding — syscalls, structs, ABI clamping, `execve` |
| `landlock-exec.ts` | the §4.2 child shape: restrict self, then become the command |
| `net-probe.ts` | TCP bind probe used by `verify.sh` §7 |
| `verify.sh` | the 17 assertions above |
| `bench.sh` | the overhead table |
| `alternative-helper.c` | the compiled-helper alternative, for the cost comparison only |
| `tsconfig.json` | lets the spike be typechecked without entering the repo's `src/**` project |

**None of this is wired into `src/harness/process/sandbox/`, and none of it
should be shipped as-is.** It is a decision record with executable evidence
attached.
