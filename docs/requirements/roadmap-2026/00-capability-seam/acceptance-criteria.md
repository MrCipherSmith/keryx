# Acceptance Criteria — Block 00: Capability Seam (Foundation)

Version: 1.0.0

Each criterion is **hard** and **testable**. `Ref` links to the binding constraint in
`tech-bestpractices.md` and/or the decision in `architecture.md`. Block 0 is DONE only when every
AC below passes. These ACs are the ones a block PRD reuses (A–E must satisfy the same seam ACs when
they instantiate it).

## A. Dependency policy (zero-dep floor)

- [ ] **AC0-1** — `package.json` `dependencies` block is **empty**; every new runtime lib appears
      only under `optionalDependencies` (or documented optional `peerDependency`).
      *Test*: assert on parsed `package.json`. *Ref*: C0-1, G0-2, XP1.
- [ ] **AC0-2** — No optional dependency is imported at module top-level anywhere in `src/`; each is
      loaded only via `await import(...)` inside its adapter, wrapped in try/catch.
      *Test*: static scan of `src/` for top-level imports of any `optionalDependencies` name → none.
      *Ref*: C0-2.
- [ ] **AC0-3** — A default command runs successfully with the optionals directory absent (or
      `bun install --omit=optional`), producing byte-identical output to the baseline.
      *Test*: strip optionals dir, run a default command, diff output. *Ref*: C0-1, C0-13, XP1.

## B. Uniform opt-in seam & graceful degradation

- [ ] **AC0-4** — A capability declared with all four coordinated parts (init flag / manifest entry
      / config toggle / `resolveCapability`) resolves to an `Adapter` when all are satisfied and to
      `null` otherwise. *Test*: seam unit test, both branches. *Ref*: C0-3, G0-1.
- [ ] **AC0-5** — Capability disabled in the manifest ⇒ `resolveCapability` returns `null`, **no**
      optional dep is loaded and **no** asset is touched; deterministic path runs.
      *Test*: spy on `await import` + `resolveAsset`; assert never called. *Ref*: C0-4, XP2.
- [ ] **AC0-6** — Capability enabled but its dep is not installed / asset missing / checksum fails ⇒
      command **warns once to stderr**, runs the deterministic fallback, and **exits 0** (never
      hard-fails). *Test*: enable capability with no dep/asset; assert single stderr warning +
      exit 0 + deterministic output. *Ref*: C0-5, G0-3, XP2.
- [ ] **AC0-7** — The warn-once helper emits the degradation warning **exactly once** per command
      invocation regardless of how many call sites hit the unavailable capability.
      *Test*: multiple resolve calls in one process → one warning. *Ref*: C0-5.
- [ ] **AC0-8** — A capability adapter that throws at `isAvailable()` or `run()` **never** propagates
      to its caller; the error is caught and the caller receives the deterministic result.
      *Test*: fault-injected adapter throws → caller still returns deterministic output; no uncaught
      exception. *Ref*: C0-11, G0-4.
- [ ] **AC0-9** — Every block ships **both** the deterministic implementation and the adapter; the
      deterministic path is a first-class, tested code path (availability-false test exists).
      *Test*: presence of an availability-false test for the reference capability. *Ref*: C0-6, T-3, F-3.

## C. Config & manifest wiring

- [ ] **AC0-10** — Config loaders deep-merge partial user config over defaults and fall back to
      defaults on malformed JSON (no throw). *Test*: partial config + malformed config cases.
      *Ref*: C0-8.
- [ ] **AC0-11** — Enable/disable is read from `metaproject.json`; a missing manifest = capability
      off. *Test*: no-manifest workspace → capability resolves `null`. *Ref*: C0-9.
- [ ] **AC0-12** — `init` offers `--<cap>` / `--no-<cap>` (ceilings default OFF) and writes the
      capability into `modules.<m>.capabilities[]` + the module config; `update` reconciles a new
      capability without disabling already-enabled modules.
      *Test*: init/update integration tests. *Ref*: C0-3, G0-1, US-007.

## D. Asset Resolver (XP3 / XP4)

- [ ] **AC0-13** — Assets are obtained from exactly one of: a user-provided config path, an explicit
      `<module> assets pull <id>`, or the well-known user cache — nothing else.
      *Test*: resolver T1/T2/T3 tests. *Ref*: A-1.
- [ ] **AC0-14** — `resolveAsset` verifies sha256 on **every** load and returns `null` (⇒ fallback)
      when the asset is missing or unverified. *Test*: valid, missing, tampered cases.
      *Ref*: A-3, G0-5.
- [ ] **AC0-15** — `<module> assets pull <id>` verifies the download's sha256 against
      `assets.lock.json` and **refuses on mismatch**. *Test*: pull with mismatched checksum →
      non-zero, no file written. *Ref*: A-2, XP4.
- [ ] **AC0-16** — Network fetch occurs **only** inside `assets pull`; no default command reaches the
      resolver's download path. *Test*: no-network sandbox runs every default command with no socket
      opened. *Ref*: A-6, A-7, T-4, XP1.
- [ ] **AC0-17** — `assets.lock.json` (id/version/url/sha256/size) is git-committed and is the source
      of pinned provenance. *Test*: file present + schema-valid. *Ref*: A-4.
- [ ] **AC0-18** — No `postinstall` (or any install hook) downloads assets or dependencies.
      *Test*: `package.json` scripts contain no downloading install hook. *Ref*: C0-12, A-5.

## E. Fixture-corpora harness & FN-rate gate

- [ ] **AC0-19** — `runCorpus(dir, detect)` loads a committed `fixtures/<corpus>/`, runs the
      detector/selector, and produces a deterministic `CorpusReport` (fnRate + precision + recall);
      re-run diff is empty. *Test*: harness self-test + re-run determinism. *Ref*: F-1, F-2, F-4, G0-6.
- [ ] **AC0-20** — `gateCorpus(report, { maxFnRate })` returns `fail` (CI non-zero) when the FN rate
      regresses beyond the threshold and `pass` otherwise. *Test*: below/above threshold cases.
      *Ref*: E-8, G0-6.
- [ ] **AC0-21** — The harness accepts a block's corpus without per-block code (a block PRD can name
      its corpus as the acceptance gate). *Test*: run two distinct seed corpora through the same
      runner. *Ref*: F-1.

## F. Package-wide gate (the golden rule)

- [ ] **AC0-22** — With **zero** opt-in flags set and **no** assets present, the full existing test
      suite and every deterministic command behave **byte-identically** to today: no new dependency
      loaded, no socket opened. *Test*: full suite + no-network sandbox on a clean workspace.
      *Ref*: C0-7, T-4, XP1/XP2. **(This is the package-wide acceptance gate.)**

## G. Testing coverage (structure)

- [ ] **AC0-23** — The reference capability has **both** an availability-true test (dep/asset present
      or stubbed) and an availability-false fallback test. *Ref*: T-3.
- [ ] **AC0-24** — A no-network sandbox test confirms every default command succeeds with no socket
      opened. *Ref*: T-4, XP1.
