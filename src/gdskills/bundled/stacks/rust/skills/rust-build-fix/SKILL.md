---
name: rust-build-fix
description: "Use when cargo build/cargo clippy fails, or Cargo.toml/Cargo.lock are out of sync -- resolves dependency/edition/MSRV mismatches, borrow-checker and lifetime errors, trait-bound errors, clippy failures, and a failing cargo test, with the smallest root-cause fix."
triggers:
  - "cargo build is failing"
  - "fix Cargo.toml Cargo.lock mismatch"
  - "resolve this Rust borrow checker error"
  - "cargo clippy is failing"
  - "this Rust trait bound isn't satisfied"
  - "cargo test is failing"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Rust build fix (2021/2024 edition)

Resolve a `cargo build`/`cargo clippy` failure, a `Cargo.toml`/`Cargo.lock`
mismatch, a borrow-checker/lifetime error, an unsatisfied trait bound, or a
failing `cargo test` — with the smallest change that fixes the actual root
cause. `rules/coding-style.mdc` and `rules/security.mdc` govern what a
"correct" fix looks like; this skill never reaches for a suppression
instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
cargo build --all-targets
cargo clippy --all-targets -- -D warnings
```

Read the exact error text (`rustc`'s diagnostics name the error code, e.g.
`E0502`, `E0308`) and classify it:

- **Compile error** (type mismatch, undefined item, wrong argument count).
- **Borrow checker / lifetime** (`E0502` conflicting borrows, `E0499`
  multiple mutable borrows, a lifetime that doesn't live long enough).
- **Trait bound** (`the trait bound ... is not satisfied`, a missing
  `impl` the code assumes exists).
- **Dependency/edition/MSRV** (`Cargo.lock` stale against `Cargo.toml`,
  a version conflict, a feature used past the declared `edition`/
  `rust-version`).
- **Clippy finding** (a lint from `cargo clippy`'s default set or the
  project's configured groups).
- **Test failure** (`cargo test` reports a failing assertion or panic).

### Step 2: Fix by category

**Dependency/edition/MSRV:** run `cargo update -p <crate>` for a targeted
bump, or `cargo update` for a full re-resolve, when `Cargo.lock` is simply
stale against `Cargo.toml`'s requirements. For a genuine version conflict,
check `cargo tree -i <crate>` (what depends on the conflicting version)
before bumping by hand. Only raise `edition`/`rust-version` in
`Cargo.toml` when the code genuinely needs a feature that edition/MSRV
introduces, and say so in the report — never to make an unrelated error
disappear.

**Borrow checker / lifetime:** read what the compiler's own suggestion
proposes first (`rustc` usually names the exact conflicting borrows or
missing lifetime). Prefer restructuring ownership, splitting a borrow, or
shortening a lifetime over reaching for `.clone()`; a clone is an
acceptable fix only when the value genuinely needs to be duplicated —
say so in the report either way (`rules/patterns.mdc`).

**Trait bound:** check whether the missing `impl` should exist on the
type in question (derive it, or implement it) versus whether the calling
code's generic bound is wider than it needs to be. Do not add a blanket
bound or an unnecessary `Box<dyn Trait>` conversion just to make the
compiler stop complaining without understanding which side is wrong.

**Clippy finding:** fix the underlying issue the lint names (an
unnecessary clone, a `.unwrap()` on fallible input, a needless
collect). Never add `#[allow(clippy::...)]` or a blanket
`#[allow(clippy::all)]` whose only purpose is to make the checker stop
complaining without addressing what it found.

**Test failure:** read the assertion output and the code path it
exercises; fix the actual bug the test caught. Never delete, skip
(`#[ignore]`), or loosen the assertion to reach a green build unless the
test itself is proven wrong (say so explicitly in the report).

### Step 3: Verify

```bash
cargo build --all-targets
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo test
```

All must exit 0 before reporting done.

### Step 4: Report

```
Fixed: Cargo.lock stale against a version bump in Cargo.toml (ran `cargo update -p tokio`)
  - Root cause: Cargo.lock predated a minor version bump in Cargo.toml
  - cargo build/clippy -D warnings/fmt --check/test all pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER add `#[allow(clippy::...)]` (especially a blanket
  `#[allow(clippy::all)]`) to silence a clippy finding instead of fixing
  what it found.
- NEVER raise `edition`/`rust-version` in `Cargo.toml`, or bump a major
  dependency version, just to make an error disappear without
  understanding why it changed.
- NEVER reach for `.clone()`/`.unwrap()` purely to make the compiler stop
  complaining without considering whether it addresses the actual error.
- NEVER delete, skip (`#[ignore]`), or loosen an assertion to reach a
  green `cargo test`.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `#[allow(clippy::redundant_clone)]` here so the linter stops complaining" | Silences the finding without addressing whether the clone is actually needed; check the ownership shape instead. `redundant_clone` lives in clippy's `nursery` group (allow-by-default), so it only surfaces when that group is enabled -- but once it fires, suppressing it is the same mistake as suppressing any other clippy finding |
| "Bumping the edition to 2024 makes this compile" | Changes the crate's declared minimum edition for every consumer to dodge one error; understand why the code needs 2024 first, or fix the code to work at the declared edition |
| "This test is flaky, I'll add `#[ignore]` for now" | Hides a real bug or a real flake source instead of fixing the underlying issue; find the actual cause |
| "I'll just `.clone()` past this borrow error" | A reflexive clone can mask an ownership design issue the compiler is correctly catching; read the compiler's own suggestion first |

## Verification

Do not report the fix done until all of the following hold:

- `cargo build --all-targets`, `cargo clippy --all-targets -- -D warnings`,
  `cargo fmt --check`, and `cargo test` all exit 0.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
