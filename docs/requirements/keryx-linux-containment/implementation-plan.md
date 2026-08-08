# Keryx Linux Containment — Implementation Plan
Version: 1.0.0

Sequencing for [specification.md](specification.md). One flow per step; every
flow merges into `feat/linux-containment-landlock`, not into `main`.

## Order, and why it is this order

The architecture suggests building Landlock first. The risk says otherwise.

Step 1 removes a **false statement from a shipped product**. It is small, it is
independent of Landlock, and it stands on its own: a user told "containment is
not working here, and here is why" is better off than one told "available",
even with no Landlock in existence. Step 2 then converts that honest negative
into a positive on most current Linux hosts.

## Step 0 — unblock the branch

**Not a flow. A precondition.**

`src/commands/sandbox.ts`, `capability-matrix.ts`, its doc-sync test and
`install.sh`'s sandbox reporting are on `fix/benchmark-remediation-v2` and not
on `main`. This branch is cut from `main`, so steps 1 and 3 have nothing to edit
until that work lands.

Choose one, and record which:

- merge `fix/benchmark-remediation-v2` to `main`, then rebase this branch; or
- rebase this branch onto `fix/benchmark-remediation-v2` and let both merge
  together.

No flow starts before this is settled.

## Step 1 — stop claiming a boundary that was never probed

**Delivers:** R4, R5, R6, R7, R8 · **AC4, AC5, AC6, AC7** · touches no launcher.

- `sandbox/probe.ts` — one trivial contained run per layer, injectable, cached.
- `CapabilityStatus` gains `unavailable` with `reason` + `remediation`.
- `sandbox status` and `install.sh` render the probe, not a `PATH` lookup.
- Linux rows keyed on kernel/ABI rather than the platform string.
- Doc-sync test extended so the runbook cannot drift from the third state.

**Proves:** on today's stock Ubuntu, with bubblewrap installed and no AppArmor
profile, `sandbox status` reports containment as **not working**, quotes
`bwrap: setting up uid map: Permission denied`, and names the profile as the
remediation. That is the exact host state measured on 2026-08-08, so this flow
can be verified against a machine that already exhibits the defect.

**Ships alone.** Do not hold it for step 2.

## Step 2 — the Landlock spike

**Delivers:** the one unproven assumption in the specification (§4.2).

Issue `landlock_create_ruleset`, `landlock_add_rule`, `landlock_restrict_self`
and `prctl(PR_SET_NO_NEW_PRIVS)` from `bun:ffi`; confirm the restriction is
inherited by an exec'd child and by *its* children.

**Outcome is a decision, not code:** either `bun:ffi` carries it — and step 3
proceeds as specified — or it does not, and step 3 gains a compiled helper plus
the per-architecture distribution cost that Codex accepted and this package
hoped to avoid. Timebox it; a spike that has not concluded is itself the answer.

### Done — result: `bun:ffi` carries it

Full finding and executable evidence: **[spike/README.md](spike/README.md)**
(28 assertions, `spike/verify.sh`). Summary:

- The whole sequence works from Bun, and the restriction is inherited by a
  grandchild and a great-grandchild. Step 3 proceeds as specified; **no compiled
  helper, no per-architecture binary.**
- **Cost: ~40 ms per command** (median, load-dependent), of which only ~1 ms is
  Landlock. The rest is a second Bun cold start (~23 ms) plus transpiling the
  launcher (~13 ms), both required by §4.2's shape. That is roughly **4×
  bubblewrap** on the same host and must go into Step 4's runbook figures
  (**S6**) as measured, not estimated.
- Three design corrections for Step 3, all cheap: use **`execve` via FFI** rather
  than `Bun.spawnSync` (otherwise a Bun process stays resident as the parent of
  every contained command, and note raw `execve` does no PATH search);
  **prebundle** the child to one `.js` (~3 ms); and map `signalCode` to 128+N,
  because `Bun.spawnSync` returns `exitCode: null` for a signalled child and
  `process.exit(null)` exits 0.
- The ABI-4 TCP axis is reachable and enforcing. §4.3 is unchanged: it is
  TCP-only, so `network: "off"` still selects bubblewrap. The spike's flag is
  named `--handle-tcp`, not `--net`, so the surface cannot be misread.
- **Fail closed when an axis is unavailable, never degrade.** The spike's first
  draft silently dropped a requested TCP restriction below ABI 4 and ran the
  command at exit 0 with an unrestricted network; review caught it.
- **For Step 1:** the spike twice wrote assertions that passed without proving
  anything (a TCP probe green on `ECONNREFUSED`; a denial asserted only by an
  absent output file). A probe without a negative control is not evidence, and
  asserting the symptom of a denial is not asserting its cause.
- Untested and inherited by Step 3 as risk: **ABI 1** (kernel 5.15 / Ubuntu
  22.04) is inferred from headers, never run.

## Step 3 — the Landlock launcher

**Delivers:** R1, R2, R3 · **AC1, AC2, AC3, AC8, AC9, AC10**.

- `sandbox/landlock.ts` — pure profile → ruleset, mirroring `bwrap.ts`.
- `sandbox/landlock-abi.ts` — cached, injectable ABI query.
- `sandbox/landlock-exec.ts` — the child that restricts itself, then runs.
- `wrap.ts` — the Linux branch gains Landlock; stays spawn-free.
- `detect.ts` — layer selection replaces the availability boolean.

Constraints that are not negotiable in review:

- `network: "off"` may **not** be served by Landlock alone (spec §4.3 — UDP, raw
  and unix sockets are outside its access types). Until a seccomp filter exists,
  that profile selects bubblewrap.
- An inexpressible profile fails closed. Never approximate a boundary.
- Rules are never applied in the keryx process.

## Step 4 — make the rest of the documentation true

**Delivers:** the claims the previous steps invalidate.

- `keryx-os-sandbox` README + specification: the platform matrix now has a
  Landlock column and a kernel axis.
- Verification runbook: a Landlock section, the AppArmor profile demoted to the
  bubblewrap-fallback path, and the measured per-command overhead (**S6**) beside
  the existing figures (none ~1.8 ms, bwrap ~17 ms, container ~409 ms).
- Roadmap row moves off `specification ready`.

Cheap, and the reason it is a step rather than an afterthought is that step 3
makes several currently-correct sentences wrong.

## Step 5 — live verification

**Delivers:** AC10, AC11 — the only criteria a unit test cannot reach.

Needs a stock Ubuntu 24.04 host with **no** AppArmor profile for `bwrap`. This
machine no longer qualifies: the profile was installed here on 2026-08-08 to
unblock benchmark case C4. Either use a fresh host or remove
`/etc/apparmor.d/bwrap` for the duration and reload — recorded here so the run
is not accidentally performed against a host that was already remediated, which
would false-pass AC11.

## Deferred, deliberately

| Item | Why not now |
|---|---|
| Container layer (ADR-0010 layer 3) | The only path to a Linux domain allowlist, and ~409 ms per command with a daemon whose group membership equals root on the host being protected. Interface noted, build deferred. |
| seccomp filter for non-TCP sockets | Needed before Landlock can serve `network: "off"`. Scoped as its own flow after step 3 measures how often the bubblewrap fallback is actually taken. |
| Rootless container runtime (podman) | Follows the container layer. |
| Domain allowlist / credential masking on Linux | Neither Landlock nor bubblewrap can express them. Unchanged by this package. |
