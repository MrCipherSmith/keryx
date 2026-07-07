# Tasks — Block 00: Capability Seam (Foundation)

Version: 1.0.0

Ordered, atomic task decomposition. Each task has a `kind`
(`context` | `implement` | `test` | `docs`), explicit dependencies, the ACs it satisfies (see
`acceptance-criteria.md`), and the constraints it must honor. Tasks are sized to be individually
reviewable and to map onto `gd-metapro flow` task units (see README "how to run this block").

> **Ordering constraint (hard):** Block 0 **MUST land before Blocks A–E.** The seam, Asset
> Resolver, `optionalDependencies` policy, and fixture harness are decided once, centrally
> (architecture §7). No block below may begin until T1–T14 are DONE and AC0-22 (the package-wide
> golden-rule gate) passes.

## Phase 1 — Seam core

- **T1 — Study the `security.backends` precedent** · *kind: context* · deps: —
  Read `src/security/config.ts` (`mergeSecurityConfig`/`loadSecurityConfig`), `src/security/guard.ts`
  (`isSecurityEnabled`, no-op/never-throw), `src/standard/capabilities.ts` (`extractCapabilities`),
  `src/commands/init.ts` capability flags. Output: a short note mapping each to the generalized seam.
  *Ref*: arch §0, §2.

- **T2 — Implement `CapabilityAdapter` + `CapabilitySpec` + `resolveCapability`** · *kind: implement*
  · deps: T1
  Create `src/capability/seam.ts`: the adapter/spec interfaces and `resolveCapability(cwd, spec)`
  returning `Adapter | null`, gating on manifest-enabled AND dep-importable (`await import`, try/catch)
  AND asset-resolved. Must **never throw** — every failure maps to `null`.
  *Satisfies*: AC0-4, AC0-5, AC0-8 (adapter error path), AC0-11. *Ref*: C0-3, C0-9, C0-11.

- **T3 — Implement warn-once helper** · *kind: implement* · deps: T2
  Create `src/capability/warn-once.ts`: a process-scoped guard that emits a degradation warning to
  stderr exactly once per invocation. Wire it into `resolveCapability`'s fallback path.
  *Satisfies*: AC0-6 (warn), AC0-7. *Ref*: C0-5.

- **T4 — Seam unit tests** · *kind: test* · deps: T2, T3
  `src/capability/seam.test.ts`: available path, unavailable (disabled / dep-missing / asset-missing)
  path, adapter-throws-caught path, warn-once emitted once, missing-manifest = off.
  *Satisfies*: AC0-4, AC0-5, AC0-6, AC0-7, AC0-8, AC0-11. *Ref*: T-3.

## Phase 2 — Dependency policy

- **T5 — Establish `optionalDependencies` policy in `package.json`** · *kind: implement* · deps: T2
  Keep `dependencies` empty; declare the first-wave optional libs (MCP SDK, `web-tree-sitter`, an
  embedding runtime) under `optionalDependencies`. Add a guard/lint step that fails on any top-level
  import of an optional dep in `src/`. Ensure no `postinstall`/install hook downloads anything.
  *Satisfies*: AC0-1, AC0-2, AC0-18. *Ref*: C0-1, C0-2, C0-12, C0-13.

- **T6 — No-network sandbox + omit-optional test** · *kind: test* · deps: T5
  Add a test running every default command (a) with the optionals dir stripped and (b) under a
  no-network sandbox asserting no socket is opened, diffing output against baseline.
  *Satisfies*: AC0-3, AC0-16 (default-command half), AC0-24. *Ref*: T-4, XP1.

## Phase 3 — Asset Resolver

- **T7 — Implement `resolveAsset` + `assets.lock.json` reader** · *kind: implement* · deps: T2
  Create `src/assets/resolver.ts` (`resolveAsset(cfg, id)` → T1 path / T2 lock / T3 cache; sha256
  verified on every load; `null` on missing/unverified; **never** touches network) and
  `src/assets/lock.ts` (read/verify the committed lockfile). Add a committed
  `.metaproject/assets.lock.json` scaffold.
  *Satisfies*: AC0-13, AC0-14, AC0-17. *Ref*: A-1, A-3, A-4.

- **T8 — Implement `pullAsset` + `<module> assets` subcommands** · *kind: implement* · deps: T7
  Create `src/assets/pull.ts` (the **only** network path) and wire the uniform
  `assets list | verify | pull <id>` subcommand for opt-in modules. `pull` verifies sha256 against
  `assets.lock.json` and refuses on mismatch (no file written).
  *Satisfies*: AC0-15, AC0-16 (network-only-in-pull half). *Ref*: A-2, A-6, A-7, XP4.

- **T9 — Asset Resolver tests** · *kind: test* · deps: T7, T8
  `src/assets/resolver.test.ts`: valid / missing / tampered-checksum resolution → `null`;
  `pull` mismatch refusal; assert `resolveAsset` never opens a socket.
  *Satisfies*: AC0-14, AC0-15, AC0-16. *Ref*: A-2, A-3, T-4.

## Phase 4 — Fixture-corpora harness

- **T10 — Implement `runCorpus` + `gateCorpus`** · *kind: implement* · deps: T1
  Create `src/harness/corpus.ts` (load `fixtures/<corpus>/`, run a `DetectorFn`, compute
  deterministic FN/precision/recall) and `src/harness/gate.ts` (CI entry: fail on FN-rate regression
  beyond `maxFnRate`). Generalizes the E6 idea; no per-block code.
  *Satisfies*: AC0-19, AC0-20, AC0-21. *Ref*: F-1, F-2, F-4, E-8.

- **T11 — Harness self-test on seed fixtures** · *kind: test* · deps: T10
  Add two committed seed corpora under `fixtures/`; assert deterministic report, empty re-run diff,
  below/above-threshold gate outcomes, and that both run through the same runner unchanged.
  *Satisfies*: AC0-19, AC0-20, AC0-21. *Ref*: F-2.

## Phase 5 — init/update wiring

- **T12 — Uniform capability flags + manifest/config registration in `init`** · *kind: implement* ·
  deps: T2, T7
  Extend `src/commands/init.ts`: `--<cap>` / `--no-<cap>` (ceilings default OFF), write the
  `modules.<m>.capabilities[]` object entry + the module `*.config.json` (deep-merged over defaults,
  malformed-JSON fallback). Extend `extractCapabilities` to read the enriched object shape while
  still accepting the bare-string form.
  *Satisfies*: AC0-10, AC0-12. *Ref*: C0-3, C0-8, C0-9.

- **T13 — Capability reconciliation in `update`** · *kind: implement* · deps: T12
  Extend `src/commands/update.ts` to reconcile a newly-added capability into an existing manifest
  without disabling already-enabled modules (mirror existing `moduleEnabled` reconciliation).
  *Satisfies*: AC0-12. *Ref*: C0-9.

- **T14 — init/update integration tests** · *kind: test* · deps: T12, T13
  Assert flag parsing, manifest+config writes, deep-merge + malformed-JSON fallback, and update
  reconciliation preserving enabled modules.
  *Satisfies*: AC0-10, AC0-12. *Ref*: T-3.

## Phase 6 — Reference capability & package gate

- **T15 — Wire one throwaway reference capability end-to-end** · *kind: implement* · deps: T2–T14
  Instantiate the seam for a single **non-shipping** reference capability (per NG0-1 / OQ-3) that
  exercises dep-import + asset-resolve + deterministic fallback, to prove the pattern without
  delivering an end-user feature.
  *Satisfies*: AC0-9, AC0-23. *Ref*: C0-6, T-3.

- **T16 — Reference availability-true + availability-false tests** · *kind: test* · deps: T15
  Both branches for the reference capability: dep/asset present (stubbed) and absent (fallback).
  *Satisfies*: AC0-9, AC0-23. *Ref*: T-3, F-3.

- **T17 — Package-wide golden-rule gate** · *kind: test* · deps: T5, T6, T15
  With zero opt-in flags and no assets present, run the full existing suite + no-network sandbox and
  assert byte-identical behavior to baseline (no dep loaded, no socket opened).
  *Satisfies*: AC0-22, AC0-24. *Ref*: C0-7, T-4, XP1/XP2. **(Block-completion gate.)**

- **T18 — Finalize spec package & roadmap cross-links** · *kind: docs* · deps: T17
  Confirm README/prd/specification/acceptance-criteria are consistent with what shipped; ensure
  `docs/requirements/roadmap.md` and `roadmap-2026/README.md` reference Block 0 as landed and note
  that A–E may now instantiate the seam.
  *Ref*: DOC-1, DOC-3.

## Task dependency graph

```
T1 ──► T2 ──► T3 ──► T4
        │
        ├──► T5 ──► T6
        │
        ├──► T7 ──► T8 ──► T9
        │      └────────────► T12
        │
        └──► T10 ──► T11
                     T12 ──► T13 ──► T14
        (T2..T14) ──► T15 ──► T16
        (T5,T6,T15) ──► T17 ──► T18
```

## Definition of Done (Block 0)

All of T1–T18 complete AND every AC in `acceptance-criteria.md` passing — with **AC0-22** (the
package-wide golden-rule gate) green. Only then may Blocks A–E begin instantiating this seam.
