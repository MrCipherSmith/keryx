# Plan

## Approach

Compose, do not rewrite. `detect.ts` answers "is a launcher present"; that
question is still worth asking and its answer is still correct. What was wrong
was treating that answer as an answer to a *different* question — "does
containment work here". So step 1 adds the missing question rather than
replacing the existing one.

```
detect.ts  ──► launcher present?  (unchanged, pure-ish, injectable existsSync)
                      │
                      ▼  only when present
probe.ts   ──► trial contained run  →  ProbeResult { layer, ok, detail, remediation }
                      │
                      ▼
capability-matrix.ts ─► static: is it implemented on this platform at all?
                      │
                      ▼  composed at report time, never stored
sandbox.ts ──► SandboxCapabilityReportRow { kind, status, reason?, remediation? }
                      │
                      ▼
install.sh ──► `keryx sandbox status`  (one source, zero drift)
```

`detect.ts`'s `SandboxLauncherInfo.available` boolean survives this flow.
Specification §2 replaces it with a layer choice, but that replacement only
makes sense once there is more than one layer to choose from — it belongs to
step 3 with Landlock. Changing the shape now would churn `adapter.ts`,
`resolveSandboxAdapter` and the fail-closed tests for no gain, and AC8 says
fail-closed must be *unchanged*.

## Decisions

### D1 — the probe runs the real wrapper

The trial command is built with `wrapBwrap` / `wrapSeatbelt` — the same pure
builders the product spawns through. A hand-written `bwrap --ro-bind / / --
/bin/true` would be a different boundary from the one being reported on, and a
probe that tests something other than the thing it reports on is the defect
being fixed, in a new place.

### D2 — synchronous spawn

`spawnSync` from `node:child_process`, injected. `buildSandboxReport` stays
synchronous, so `sandbox status`, its tests and the JSON path are unchanged in
shape. An async probe would push `async` through the whole report path for no
behavioural gain.

### D3 — cache is process-global, with a documented test-only reset

N4 says "at most one probe per process". A per-deps memo would not be that. The
module keeps one global slot; `runContainmentProbe` (uncached) is exported for
tests that need several outcomes, and `resetContainmentProbeCacheForTests()`
clears the slot. Production callers use `probeContainment`.

### D4 — the kernel axis, without Landlock

R6 says Linux reporting is keyed on the kernel, not on the string `"linux"`.
Landlock ABI does not exist yet, so the kernel key in step 1 is the **kernel
facility each Linux row depends on** (`unprivileged-user-namespaces` for the two
bubblewrap-backed rows) plus the kernel release read from `os.release()`,
injected. The `unavailable` reason therefore reads

> the kernel on this host (6.8.0-136-generic) does not permit unprivileged user
> namespaces …

and not "unavailable on linux". Step 3 adds the ABI to the same axis without
reshaping it.

### D5 — install.sh delegates rather than re-implements

Specification §7: "`scripts/install.sh` prints the same, from the same source."
The installer runs the keryx it just installed (`keryx sandbox status`) and
prints its output. Any wording lives in one place. If that invocation fails for
any reason, the installer prints an explicitly *unknown* result — never an
optimistic one — and still exits 0, because it is a report and not a gate.

### D6 — no probe on a path that cannot report capability

Unsupported platform, or launcher absent: nothing is spawned. There is no
launcher to trial, and N4 forbids probing where nothing is being reported.

## Trade-offs accepted

- The probe costs one `bwrap`-wrapped `/bin/true` (~17 ms measured) on
  `sandbox status` and once during install. It is not on any run path.
- A launcher that lies (exits 0 without containing) fools the probe. The
  specification asks for a `/bin/true`-class trial and this implements exactly
  that; a containment *assertion* (write outside the workspace and check it was
  refused) is strictly better and is noted as follow-up, not smuggled in here.

## Risks

| Risk | Mitigation |
|---|---|
| Probing on darwin regresses macOS (N5) | Probe is injected in every unit test; the darwin trial is `wrapSeatbelt` + `/usr/bin/true`, and `seatbelt.ts` is not edited (AC9) |
| `install-global.test.ts` asserts the old installer wording | Rewritten in the same commit against the new wording, and extended with a shim that reproduces the uid-map failure so the fixed defect is covered end to end |
| A reviewer reads the sysctl back in as "the obvious fix" | An explicit test asserts no rendering path can emit `apparmor_restrict_unprivileged_userns` |
