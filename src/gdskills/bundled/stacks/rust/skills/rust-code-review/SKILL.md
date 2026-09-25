---
name: rust-code-review
description: "Use when reviewing a Rust change for ownership, panic, and safety risks -- unwrap/expect on fallible input, unnecessary clone as a borrow-checker workaround, unjustified or oversized unsafe blocks, blocking calls in async fn, unchecked arithmetic/indexing on untrusted data, and error types that lose their source. Read-only, no edits."
triggers:
  - "review this Rust diff for unwrap panics"
  - "check this Rust change for unsafe block safety"
  - "review this Rust patch for blocking calls in async fn"
  - "any unnecessary clones in this Rust change"
  - "check this Rust code for integer overflow on untrusted input"
  - "review this Rust diff for error handling that drops the source"
  - "audit this Rust module for a panic reachable from untrusted input"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Rust code review

Read-only review of a Rust change for ownership, panic, and safety risks
specific to Rust: `.unwrap()`/`.expect()` on fallible or untrusted input,
a borrow-checker `.clone()` workaround, unjustified `unsafe`, blocking
calls in `async fn`, unchecked arithmetic/indexing, and error types that
lose their source. This skill never edits code — it reports findings.
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
are the rule set findings are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `*.rs` files in the diff, not the whole crate.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed function against the focus list

**Panics on fallible/untrusted input**
- `.unwrap()`/`.expect()` on a `Result`/`Option` built from network input,
  file contents, CLI arguments, a map lookup on external data, or any
  other fallible/attacker-influenced source — flag it; the fix is `?`, a
  `match`, or a combinator, not a panic on bad input.
- Raw array/slice indexing (`arr[i]`) on an index derived from untrusted
  input instead of `.get(i)` — flag as a potential panic/DoS.
- Unchecked arithmetic (`a + b`, `a * b`) on values that can be
  attacker-influenced instead of `checked_*`/`saturating_*`/`wrapping_*`
  chosen for the operation's actual semantics.

**Ownership and cloning**
- A `.clone()` added specifically to route around a borrow-checker error,
  with no comment explaining why the duplication is actually needed —
  flag as a possible design smell per `rules/patterns.mdc`; note when
  restructuring ownership or borrowing differently looks feasible from
  the diff alone.

**`unsafe` blocks**
- Any `unsafe` block with no `# Safety` doc comment stating the invariant
  it relies on — flag it.
- An `unsafe` block wider than the specific operation that requires it —
  flag as unnecessarily large audited surface.

**Async and concurrency**
- A blocking call (`std::thread::sleep`, synchronous `std::fs`/`std::net`
  I/O, a `std::sync::Mutex` guard held across an `.await`) inside an
  `async fn` — flag as a potential executor stall.
- A spawned task (`tokio::spawn`) with no visible join (`.await` on its
  `JoinHandle`, or a channel) — flag as fire-and-forget with no stated
  reason.

**Error handling**
- A custom error variant that discards the underlying cause (a bare
  `String` built from `.to_string()` on the source error, with no
  `#[source]`/`#[from]`) — flag as losing information a caller could
  otherwise inspect.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (panic, leak,
unsound `unsafe`, executor stall), and the fix direction — but do not
apply it.

```
src/order/service.rs:58 — .unwrap() on the downstream client's Result,
  which carries a network call's outcome. Risk: a downstream failure
  panics the process instead of propagating. Fix direction: propagate
  with ? into this module's OrderError, or add a #[source]-wrapping
  variant if one doesn't exist yet.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag `.unwrap()`/`.expect()` on fallible/untrusted input, unnecessary
  clones, unjustified/oversized `unsafe`, blocking calls in `async fn`,
  unchecked arithmetic/indexing on untrusted data, and error types that
  drop their source; do not report generic style nits already covered by
  `rustfmt`/`clippy`'s default lint set (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected data race or unsoundness is not certain from reading
  alone, say "run under `cargo miri test` / `loom` to confirm" rather than
  asserting it without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This `.unwrap()` is on input the caller always validates first" | That invariant lives in a different function the diff may not show; flag it and ask for the validation to be visible at this call site, or a comment stating the invariant |
| "It's just a config map, it's only cloned once at startup" | A clone whose need is not stated in a comment is still a design smell worth naming, even if the current call site is cheap |
| "I'll just fix the unwrap myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "The unsafe block is small, it doesn't need a Safety comment" | Size does not establish soundness; the comment is what lets a reviewer (or future maintainer) check the invariant without re-deriving it |

## Verification

Do not report the review done until all of the following hold:

- Every changed `*.rs` file in the diff was read, not just files named in
  the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
