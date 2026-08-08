# Spike — can `bun:ffi` apply Landlock, and does it survive exec?

Step 2 of [implementation-plan.md](../implementation-plan.md). Answers the one
unproven assumption in [specification.md](../specification.md) §4.2.

- **Host:** Ubuntu 24.04, kernel 6.8.0-136-generic, x86_64, Bun 1.3.11
- **Landlock ABI:** 4 (reached through `bun:ffi`, matching the number ADR-0010
  measured by other means)
- **Date:** 2026-08-08
- **Reproduce:** `./verify.sh` (29 assertions) and `./bench.sh`

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

**But the delivery shape in §4.2 costs ~40 ms per command, roughly 4× the
bubblewrap it is meant to replace.** The Landlock syscalls are ~1 ms of that.
The rest is a second Bun cold start (~23 ms) plus transpiling the launcher
(~13 ms), both paid because §4.2 spawns a *second* Bun to apply the ruleset.
This does not invalidate the approach, but it is a real number that Step 3 must
decide about rather than discover.

## Evidence

`./verify.sh`, 29/29 passing. Every assertion that something was **denied** is
paired with a control that differs only in the ruleset, and asserts the *reason*
for the denial rather than its symptom — an assertion that also passes when the
command never ran is not evidence.

| # | Assertion |
|---|---|
| 1 | `landlock_create_ruleset(NULL, 0, VERSION)` → ABI 4 |
| 2 | full apply sequence completes and the command runs |
| 3 | read inside the allowed hierarchy succeeds |
| 3 | write inside the allowed hierarchy succeeds |
| 3 | write outside is denied — `Permission denied` |
| 3 | read outside is denied **and the contents did not leak** |
| 4 | grandchild write inside succeeds |
| 4 | **grandchild write outside is denied — the restriction is inherited** |
| 4 | great-grandchild write inside succeeds (control: three-deep nesting runs) |
| 4 | great-grandchild write outside is denied with `EACCES` |
| 5 | control: `NoNewPrivs` is 0 outside the launcher |
| 5 | `NoNewPrivs` is 1 inside the contained child |
| 5b | `execve` mode: the command's parent is this script, not a resident `bun` |
| 5b | control: `--spawn` mode does leave `bun` resident as the parent |
| 5b | exit code 42 propagates in both modes |
| 5b | `SIGKILL` reports 137 in both modes, not 0 |
| 6 | an inapplicable ruleset exits 125, names the path, never runs the command |
| 6 | the TCP axis is refused below ABI 4 rather than silently dropped |
| 6b | a bare program name resolves via PATH in both modes |
| 6b | a program absent from PATH is refused, **not taken from the cwd** |
| 6b | a missing program exits 125 in both modes, not 1 |
| 6b | `SIGUSR1` reports 138 in both modes (not flattened to 128) |
| 6b | a real-time signal reports 162 in both modes, **never the reserved 125** |
| 6b | malformed port arguments fail closed |
| 6c | `/dev/null` is writable under the narrowed device grant |
| 6c | `/dev/shm` supports file creation, so POSIX shm still works |
| 7 | control: TCP bind succeeds when the net axis is not handled |
| 7 | `handled_access_net` with no allow-rule denies TCP bind with `EACCES` |
| 7 | an explicit `net_port` allow-rule restores the bind |

The inside/outside pairs matter more than the denials alone: both directories
are `mktemp -d` under `/tmp`, owned by the same user with the same mode, so DAC
cannot explain the difference. Only the ruleset can.

The script asserts its own assertion count, so a section that silently stops
running cannot leave it exiting 0, and it skips (rather than fails) section 7
on a kernel below ABI 4.

## Measured overhead

ADR-0010's method — wall clock around N runs of `/bin/echo` — with three
changes, each because the original could not support a claim made from it:
N=30 rather than 5; every mechanism measured in the **same run** so rows are
comparable to each other; and **each iteration timed individually**, reported as
median with (min–max), because a mean is the statistic a single load spike
contaminates and "stable" should be visible in the output rather than asserted.

`measure()` also **runs each command once and checks it succeeded** before
timing it — see "what surprised us" #5 for why that is not defensive padding.

A `BROKEN` row makes the script exit non-zero, so a table containing a
non-measurement cannot be quietly committed. Load average ~3.1:

| Mechanism | Axes | Median (min–max) |
|---|---|---|
| none (`/bin/echo`) | — | 2.1 ms (1.5–2.8) |
| bubblewrap, ADR-0010's invocation | fs + netns | 10.9 ms (9.6–11.9) |
| bubblewrap, no `--unshare-net` | fs | 10.0 ms (9.1–12.0) |
| **landlock via `bun:ffi` (§4.2 shape)** | fs | **40.2 ms (37.5–49.2)** |
| landlock via `bun:ffi`, TCP axis handled | fs + tcp | 44.3 ms (40.8–48.6) |
| landlock via `bun:ffi`, prebundled to one `.js` | fs | 38.2 ms (36.3–44.8) |
| landlock via a compiled C helper | fs | 2.3 ms (1.9–3.1) |

Decomposition:

| Component | Cost |
|---|---|
| Bun runtime cold start (`bun -e '0'`) | 24.1 ms (22.5–25.5) |
| import + transpile `landlock-ffi.ts` | ~12.8 ms (n=1) |
| ABI query (syscall 444) | ~0.16 ms (n=1) |
| create ruleset + path rules + `no_new_privs` + `restrict_self` | ~0.87 ms (n=1) |
| **all Landlock syscalls together** | **~1.03 ms (n=1)** |

Compiled helper: **16472 bytes**.

Caveats, so these figures are not read for more than they are:

- **Not comparable to ADR-0010's.** It recorded bubblewrap at ~17 ms and bare at
  ~1.8 ms; this run measures ~10.9 ms and ~2.1 ms for the same commands, in a
  different session. Compare **within** a table, never across the two. For the
  same reason the ~409 ms `docker run` figure is deliberately **not** in the
  table above — it belongs to ADR-0010's session, and putting it in this one
  would invite exactly the cross-session comparison this paragraph forbids.
- **Load-dependent.** An earlier, quieter session on this host measured the
  §4.2 shape at ~30 ms rather than ~40 ms, with the same ratios. The absolute
  number moves with system load; the ordering and the ~4× relationship did not.
- **bwrap is not quite like-for-like.** ADR-0010's invocation includes
  `--unshare-net`, which the Landlock filesystem rows do not do. The fs-only
  bwrap row is included so the comparison can be made on equal axes; it changes
  the ratio by under a millisecond.
- The decomposition rows are **single samples**, marked `n=1`, not medians.

## What surprised us

**1. The mechanism is cheap; the delivery is not.** Landlock costs ~1 ms. The
specification's own §4.2 sentence — "Bun is already a hard runtime requirement,
so this adds **no** new dependency and **no** per-architecture binary" — is
true, and it is exactly what makes the approach cost ~17× what the thing it
avoids would cost. The avoided distribution cost is paid back as latency on
every single contained command, forever. That trade is defensible; it should be
made explicitly.

**2. `Bun.spawnSync` leaves Bun resident.** In the naive shape the Bun process
stays alive as the parent of the contained command for its whole lifetime —
tens of MB of RSS per concurrently contained command, and an extra node in the
process tree that the harness would have to reason about for signals and exit
codes. Calling `execve` through the same FFI seam fixes this: the Bun process is
*replaced* by the command, one fewer node than even bubblewrap's tree (`bwrap`
itself stays resident as the parent of what it contains). `verify.sh` §5b proves
both the fix and the control. **Step 3 should use `execve`, not `spawn`.**

**3. A nested Bun dies if its cwd is outside the ruleset**, with
`CouldntReadCurrentDirectory` — before any user code runs, so it cannot be
caught or reported nicely. Not a problem for the normal case (the workspace is
both the cwd and writable) but it will bite anyone running a Bun-based command
whose cwd was not granted.

**4. The spike reproduced the bug it was verifying — twice.** The first TCP
probe connected to a dead port and checked that it failed. It "passed" on
`ECONNREFUSED`, which an absent listener returns whether or not Landlock is
involved: green, and proving nothing. Replaced with a three-case bind test where
only the middle case changes. Then review found the same shape again in the
great-grandchild assertion, which checked only that the output file was absent —
satisfied equally by a denial and by the command never starting.

**Both are the exact defect ADR-0010 exists to correct, committed by the spike
sent to verify it.** The generalisation for Step 1: **a probe without a negative
control is not evidence**, and asserting the *symptom* of a denial is not the
same as asserting its *cause*.

**5. A benchmark that does not check exit status measures whatever happens.**
The first published version of the table above timed the compiled C helper
invoked with a flag it did not understand — the shared argv array had gained
`--dev`, and only the TypeScript side learned it. The helper exited 125 at argv
parsing without ever applying a ruleset or running `/bin/echo`, and the ~2.3 ms
that produced was printed as the headline cost of the compiled-helper
alternative, carrying the whole "~17×" comparison. `measure()` now runs each
command once and refuses to time it unless it succeeded. The corrected figure
is 2.5 ms — nearly the same number, which is exactly why nobody would have
caught it by reading the table.

That is the **third** time this spike published a green that proved nothing.
The pattern across all three is one thing: **an assertion or a measurement was
trusted because it produced a plausible-looking number, without checking that
the thing being measured had happened at all.**

**6. `glibc` has no Landlock wrappers**, so everything goes through `syscall(2)`.
Declaring that variadic function to `bun:ffi` with a fixed arity works, but the
arity must be 7 (number + 6 args): glibc's x86_64 implementation unconditionally
loads arg6 from `8(%rsp)`, so a shorter declaration hands the kernel an
uninitialised stack slot. This is silent when it goes wrong.

## What Step 3's implementer must know

**Design**

- Use **`execve` via FFI**, not `Bun.spawnSync`, in `landlock-exec.ts`. Note
  that raw `execve` does **no PATH search** — `execIntoCommand` resolves the
  program itself, or the two modes would differ in which commands they can
  start, not merely in process residency.
- **Prebundle** the child to a single `.js` in the build step: measured at
  ~3 ms of the ~13 ms transpile cost. The build script already bundles
  `proxy-worker.ts` the same way.
- ~23 ms of Bun cold start is **irreducible** for any Bun-hosted helper.
  `bun build --compile` does not help: it embeds the same runtime. If ~40 ms per
  command is not acceptable, the only way down is the compiled helper, and that
  decision belongs to a human, not to Step 3's implementer.
- Exit codes: `Bun.spawnSync` returns `exitCode: null` for a signalled child and
  `process.exit(null)` exits **0**, so a SIGKILLed command reports success
  unless you map `signalCode` to 128+N yourself. Take the signal numbers from
  `node:os` `constants.signals`, not a hand-written table — a partial table maps
  every signal it forgot to exit 128, a plausible status that names neither
  success nor the signal.
- **PATH resolution must refuse, not fall back.** Raw `execve` resolves a
  slash-free name against the *current directory*, which for a contained command
  is attacker-influenced workspace. Returning the unresolved name on a PATH miss
  therefore runs a planted file where `execvp` would report ENOENT. Also require
  the candidate to be a regular file: `access(X_OK)` is satisfied by a directory
  (`/usr/bin/X11` is real), and `execvp` keeps searching on such a hit.
- **The exit code is a shared channel.** 125 (apply failed) and 128+N (signal)
  are indistinguishable from a contained command that chose those statuses
  itself, so a caller cannot read the exit code alone as a boundary outcome.
  Step 3 should report the boundary result on a channel the child cannot
  write — the run receipt already exists for this.

**Correctness**

- Clamp `handled_access_fs` to the **measured ABI** — an unknown bit yields
  `EINVAL`. See `fsMaskForAbi`. Note the clamp is asymmetric and one direction
  is dangerous: too-old is handled by refusing (see the TCP rule below), but a
  kernel **newer** than the code silently leaves its new access classes
  unhandled and therefore *unrestricted*. `RestrictOutcome.abiClamped` surfaces
  that so a caller can refuse rather than under-restrict quietly.
- Every handled bit must be granted **somewhere**, but not necessarily
  everywhere: a bit that is handled and granted by no rule in a hierarchy is a
  deliberate deny. `IOCTL_DEV` (ABI 5) belongs in the **device** grant, not in
  the general read-write grant — folding it into every `--rw` would confer
  device control on any device node beneath any writable path. (The ABI-5
  behaviour itself is inferred from the headers; this host is ABI 4 and masks
  the bit off, so no assertion here exercises it.)
- Grant sets are not free-form, and the fix for a too-narrow grant is usually a
  **nested rule, not a wider one**. `/dev/shm` is a tmpfs where
  `shm_open`/`sem_open` create regular files, so Chromium, Python
  multiprocessing and libpq break with `EACCES` under a device-only `/dev`
  grant. The answer is `--rw /dev/shm` beneath `--dev /dev`, not `MAKE_REG` on
  all of `/dev`. Measured, not assumed; `verify.sh` §6c asserts both.
- `struct landlock_path_beneath_attr` is `__attribute__((packed))`: **12 bytes**,
  not 16. Getting this wrong yields `EINVAL` that looks like a permissions
  problem.
- `struct landlock_ruleset_attr` is 8 bytes below ABI 4 and 16 from ABI 4. This
  spike sends the 8-byte form below ABI 4 out of caution; whether the larger
  form is actually rejected by an ABI 1–3 kernel was **not tested**.
- Open rule paths with `O_PATH | O_CLOEXEC`.
- `PR_SET_NO_NEW_PRIVS` **must** precede `restrict_self`, or it returns `EPERM`.
  Be precise about what it does: it stops a set-uid or file-capability binary
  from *gaining* privileges across `execve` inside the domain. It is **not**
  what keeps the ruleset attached — a Landlock domain cannot be shed by
  anything, with or without the flag.
- A rule may not grant more than the ruleset handles; mask every rule with the
  handled set.
- Rule paths must be **directories** in practice — file targets accept only the
  file-applicable subset of access bits.
- **Fail closed when an axis is unavailable, do not degrade.** The first draft
  of this spike silently dropped a requested TCP restriction on a kernel below
  ABI 4 and ran the command at exit 0 with an unrestricted network. Review
  caught it. `assertNetSupported` is exported pure so the behaviour can be
  asserted on a host whose kernel cannot reach the branch.

**Boundary breadth — do not copy this spike's grants blindly**

- The minimum read-only set for a command to merely *start* on this host is
  `/usr /bin /lib /lib64 /etc /proc /sys` plus the Bun install directory, with
  `/dev` accessible. Derive it from the profile rather than hardcoding it; note
  `/lib64` does not exist on aarch64, and an unopenable rule path fails closed.
- **The launcher forwards the entire parent environment into the contained
  process, unfiltered.** This is the real credential-exposure path, measured:
  a parent variable arrives in the contained command verbatim. ADR-0010 records
  that `--mask-env` is unimplemented on Linux, so API keys are in that
  environment today. Step 3 owns this decision.
- A whole-`/proc` read grant exposes `/proc/<pid>/cmdline` and
  `/proc/<pid>/status` of other same-uid processes. It does **not** expose
  `/proc/<pid>/environ`: that read requires `PTRACE_MODE_READ`, and Landlock's
  ptrace hook refuses a sandboxed process access to a process outside its
  domain. Measured both ways with one victim process — readable uncontained,
  `EACCES` contained. An earlier draft of this document claimed the opposite;
  it was wrong, and the correction is recorded rather than quietly edited,
  because a decision record that asserts unverified attacks is the same defect
  as one that asserts unverified boundaries.
- `/proc/<pid>/root` and `/proc/self/root` re-entry into an ungranted directory
  are both denied — no traversal escape through the `/proc` grant.
- `/dev` uses a narrow `DEVICE_ACCESS` (read, write, list, ioctl) rather than
  the full read-write set: no node creation, no removal, no truncation, no
  cross-hierarchy `REFER`, so a contained process cannot unlink or truncate
  `/dev/null`. `/dev/shm` gets its **own nested `--rw` rule** instead, because
  it is a tmpfs where `shm_open`/`sem_open` create regular files. An earlier
  revision solved that by widening all of `/dev`, which bought POSIX shared
  memory at the price of letting a contained process delete device nodes —
  Landlock evaluates the most specific matching hierarchy, so the nested rule
  is both narrower and sufficient.

**Boundaries this spike did not move**

- The ABI-4 TCP axis is **reachable and enforcing** (proven, with a control). It
  remains **TCP-only**, so specification §4.3 stands unchanged: `network: "off"`
  still selects bubblewrap until a seccomp filter covers UDP, raw and unix
  sockets. The CLI flag is deliberately named `--handle-tcp` and not `--net`,
  because the flag name is the part most likely to be copied and misread.
- Fail-closed was verified for the launcher only (exit 125, command never runs).
  The adapter-level path (spec N1, AC8) is untouched and unverified here.
- **Only ABI 4 on one kernel was exercised.** ABI 1 (Ubuntu 22.04 / kernel 5.15)
  behaviour is inferred from the headers, not measured — the size-8
  `ruleset_attr` path and the ABI-1 FS mask have never run.

## If the answer had been no

Recorded because the plan asked for it, and because the numbers make it a live
option rather than a hypothetical. The compiled helper — `alternative-helper.c`
here, `codex-linux-sandbox` in Codex — is **16 KB**, ~140 lines, and costs
~2.3 ms per command instead of ~40 ms. What it would cost keryx:

- a per-architecture binary (at minimum `x86_64` and `aarch64`) built and
  published with every release;
- a C toolchain in CI, and a build step that is no longer "Bun builds Bun";
- the binary in the npm `files` list, so the published package stops being
  platform-neutral — either one fat package or per-platform optional
  dependencies, which is the mechanism ADR-0005 exists to limit;
- signing/notarisation questions the project does not have today;
- a second implementation of the ruleset logic to keep in sync with the pure
  `landlock.ts`.

That is a real cost, and ~38 ms per contained command is a real cost too. This
spike's job was to make both measurable rather than to pick. **The recommendation
is to proceed with `bun:ffi` as specified** — it works, it ships with what keryx
already has, and the alternative reintroduces exactly the per-architecture
distribution problem ADR-0005 exists to avoid — while recording the compiled
helper as the known optimisation if per-command latency becomes a complaint.

## Files

| File | Purpose |
|---|---|
| `landlock-ffi.ts` | the `bun:ffi` binding — syscalls, structs, ABI clamping, `execve` |
| `landlock-exec.ts` | the §4.2 child shape: restrict self, then become the command |
| `net-probe.ts` | TCP bind probe used by `verify.sh` §7 |
| `verify.sh` | the 29 assertions above |
| `bench.sh` | the overhead table |
| `alternative-helper.c` | the compiled-helper alternative, for the cost comparison only |
| `tsconfig.json` | lets the spike be typechecked without entering the repo's `src/**` project |

**None of this is wired into `src/harness/process/sandbox/`, and none of it
should be shipped as-is.** It is a decision record with executable evidence
attached.
