---
name: rust-implementation
description: "Use when implementing or extending a feature in a Rust crate -- Cargo.toml/edition/workspace layout, ownership and borrowing, Result/Option error handling with the ? operator, thiserror/anyhow conventions, trait and generic design, and avoiding blocking calls in async fn."
triggers:
  - "implement this feature in Rust"
  - "add a Rust module to this crate under src/"
  - "propagate this Rust error with the ? operator"
  - "add a thiserror error enum for this Rust module"
  - "write this as an async fn in Rust without blocking the runtime"
  - "design this Rust trait for the consumer that needs it"
  - "implement this Rust struct with a builder pattern"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Rust implementation (2021/2024 edition)

Implement or extend a feature in a Rust crate: workspace/module layout,
ownership and borrowing, error handling with `Result`/`?`, trait and
generic design, and safe async idiom. Scoped to Rust specifically —
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
carry the full stack-specific rule set this skill draws its checklist
from; read them before writing code, not just this summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `Cargo.toml` for the crate/workspace name, the `edition` (2021 vs
   2024), and whether a `rust-version` (MSRV) is pinned — do not use a
   language feature newer than what's declared.
2. Find the existing layout: `src/lib.rs`/`src/main.rs`, module
   boundaries, whether this is a `[workspace]` with multiple member
   crates. Match it; do not invent a different layout for one change.
3. Read 1-2 neighboring files in the module you are touching for: error
   handling style (`thiserror` enum vs `anyhow::Result`), whether the
   crate is async (`tokio` in `Cargo.toml`'s dependencies) and which
   runtime, existing trait boundaries, and the crate's own newtype/builder
   conventions.

### Step 2: Design before writing

- Decide ownership shape per function: does it need `&self`, `&mut self`,
  or `self` by value? Does a parameter need to own its argument or can it
  borrow (`&str` over `String`, `&[T]` over `Vec<T>`)?
- Decide the error shape: a library module gets a `thiserror`-derived enum
  with `#[source]`/`#[from]` on wrapping variants; an application/binary
  entry point uses `anyhow::Result` with `.context(...)` at each
  meaningful `?`.
- For any new trait, decide who the consumer is and size the trait to
  exactly what that consumer calls (`rules/patterns.mdc`); decide
  `impl Trait` vs `Box<dyn Trait>` based on whether runtime polymorphism
  is actually needed.
- If the crate is async, trace which calls on the new path are I/O-bound
  (use the async equivalent) versus CPU-bound/blocking (route through
  `tokio::task::spawn_blocking`).

### Step 3: Implement

1. Borrow instead of clone by default (`rules/coding-style.mdc`); when a
   `.clone()` is genuinely necessary, say why in a comment if it is not
   obvious.
2. Propagate errors with `?`; never reach for `.unwrap()`/`.expect()` on a
   `Result`/`Option` built from fallible or untrusted input.
3. Derive `Debug`/`Clone`/`PartialEq`/etc. where the fields support it
   instead of hand-writing boilerplate impls.
4. Keep any `unsafe` block minimal and carrying a `# Safety` doc comment
   stating the exact invariant it relies on (`rules/security.mdc`).
5. Format with `cargo fmt` as you go, not as an afterthought.

### Step 4: Verify

```bash
cargo build --all-targets
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo test
```

Fix findings at the root cause per `rules/security.mdc` and
`rules/coding-style.mdc`; a build/clippy/test failure at this step is a
signal to fix the implementation, not to reach for `rust-build-fix`'s
scope unless the failure is a build/dependency/module-resolution problem
unrelated to the feature logic.

### Step 5: Report

```
Implemented: src/order/service.rs, src/order/error.rs
  - New OrderError enum (thiserror) wraps the downstream client's error
  - cargo build/clippy -D warnings/fmt --check/test all pass
```

## Rules

- ALWAYS propagate a fallible `Result`/`Option` with `?` or an explicit
  match/combinator; NEVER call `.unwrap()`/`.expect()` on one built from
  fallible or untrusted input without a stated, verified invariant that
  makes it truly infallible.
- ALWAYS give an `unsafe` block a `# Safety` doc comment naming the
  invariant it relies on; NEVER widen an `unsafe` block or drop that
  comment to silence a compiler/clippy complaint.
- NEVER call a blocking operation (`std::thread::sleep`, a synchronous
  file/socket read, a `std::sync::Mutex` held across `.await`) inside an
  `async fn` on a multi-threaded runtime; use the async equivalent or
  `spawn_blocking`.
- Match the project's declared `edition`/`rust-version` — do not use a
  language feature newer than what `Cargo.toml` targets.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The borrow checker is fighting me here, I'll just `.clone()` to move on" | A reflexive clone hides an ownership design question (`rules/patterns.mdc`); consider restructuring or borrowing before paying the copy on every call |
| "This `.unwrap()` is fine, the input should always be valid" | "Should" is not "is" — untrusted or fallible input that turns out invalid panics the process; propagate with `?` instead |
| "It's a quick synchronous call inside this async fn, it won't block long" | Any blocking call on a multi-threaded async runtime can stall the executor's worker thread for every other task scheduled on it, not just this one |
| "I'll skip the `# Safety` comment, the unsafe block is obviously fine" | "Obviously fine" is exactly what an unsafe review cannot take on faith; state the invariant so it can be checked |

## Verification

Do not report the work done until all of the following hold:

- `cargo build --all-targets`, `cargo clippy --all-targets -- -D warnings`,
  `cargo fmt --check`, and `cargo test` all exit 0.
- Every new/touched `Result`/`Option` from fallible or untrusted input is
  propagated with `?` or handled explicitly, not `.unwrap()`/`.expect()`'d.
- Every new `unsafe` block carries a `# Safety` doc comment.
- No blocking call was introduced inside an `async fn` without
  `spawn_blocking` or an async equivalent.
