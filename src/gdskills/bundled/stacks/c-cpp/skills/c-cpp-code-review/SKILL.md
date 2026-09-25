---
name: c-cpp-code-review
description: "Use when reviewing a C or C++ change for memory-safety and undefined-behavior risks -- use-after-free, double-free, buffer overflows, dangling references, iterator invalidation, unchecked allocations, signed overflow, and unsynchronized shared state. Read-only, no edits."
triggers:
  - "review this C++ diff for memory safety"
  - "check this C change for a use-after-free"
  - "review this pull request for buffer overflows"
  - "any dangling references in this C++ change"
  - "check this diff for iterator invalidation"
  - "review this C code for unchecked malloc"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# C / C++ code review

Read-only review of a C/C++ change for memory-safety, undefined-behavior,
and concurrency risks specific to C/C++: use-after-free, double-free,
buffer overflows, dangling references, iterator invalidation, unchecked
allocations, signed overflow, and unsynchronized shared state. This skill
never edits code — it reports findings. `rules/coding-style.mdc`,
`rules/patterns.mdc`, and `rules/security.mdc` are the rule set findings
are checked against.

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only `.c`/`.h`/`.cpp`/`.cc`/`.cxx`/`.hpp`/`.hxx` files in the
   diff, not the whole repository.
2. Read enough of the surrounding, unchanged code to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed function against the focus list

**Ownership and lifetime**
- A pointer or reference returned, stored, or captured that points into a
  local (stack) variable, a temporary, or a since-destroyed object — flag
  it as a use-after-free/dangling-reference risk.
- A raw `new`/`malloc` with no traceable single owner (an RAII type, or a
  `free`/`delete` on every exit path) — flag it; also flag a `free`/
  `delete` that could run twice on the same pointer on different paths
  (double-free).
- A `malloc`/`calloc`/`realloc`/`new` result dereferenced without a
  preceding null/exception check.

**Containers and iterators**
- An iterator, pointer, or reference into a `std::vector`/similar
  container held across an operation that can reallocate or shift storage
  (`push_back` past capacity, `insert`, `erase`) — flag the invalidation
  risk.

**Bounds and undefined behavior**
- An array/buffer index or pointer-arithmetic expression built from
  untrusted input with no visible bounds check before the read/write.
- A signed integer addition/multiplication whose operands could plausibly
  overflow (a size/length/offset computation from untrusted input
  especially) — signed overflow is undefined behavior, not just "wrong
  answer on overflow."
- A pointer cast between incompatible types followed by a dereference (a
  strict-aliasing violation) instead of `memcpy`/`std::bit_cast`.
- `strcpy`/`strcat`/`sprintf`/`gets` on data whose length is not
  statically known to fit the destination.

**Concurrency**
- A variable read from one thread while written from another with no
  mutex/`std::atomic`/`_Atomic` guarding it — flag unsynchronized shared
  access.
- A manual `lock()`/`unlock()` pair instead of `std::lock_guard`/
  `std::scoped_lock`, which skips the unlock on an early return or
  exception thrown between them.

**Interfaces**
- A polymorphic C++ base class (deleted through a base pointer/reference
  somewhere in the diff or its callers) with a non-virtual destructor —
  flag as undefined behavior on delete.
- A memory-safety or UB bug-fix diff whose test/verification step never
  mentions running under ASan/UBSan/TSan.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (UAF, race,
overflow, leak), and the fix direction — but do not apply it.

```
src/parser/token_stream.cpp:88 — std::string_view into a temporary
std::string returned from trim() outlives the temporary once trim()'s
return value goes out of scope. Risk: use-after-free on first access.
Fix direction: return std::string by value, or take the buffer by
reference and return a span into the caller-owned storage.
```

## Rules

- NEVER edit code — findings and fix direction only.
- Flag use-after-free, double-free, buffer overflows, dangling
  references, iterator invalidation, unchecked allocations, signed
  overflow, strict-aliasing violations, and unsynchronized shared state;
  do not report generic style nits already covered by
  `clang-format`/`clang-tidy` (those are noise here).
- Distinguish a finding the diff introduces from a pre-existing one in
  code the diff merely touches.
- When a suspected race or UB is not certain from reading alone, say "run
  under ThreadSanitizer/UBSan to confirm" rather than asserting it exists
  without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The temporary's lifetime probably extends long enough in practice" | "Probably" is not a lifetime guarantee; a dangling reference into a destroyed temporary is undefined behavior the moment it is read, whether or not it happens to work today |
| "It's just a config struct, it's only written once at startup" | If it can be written concurrently with any read (even from an init thread), it needs a guard — "only once" is a claim to verify, not assume |
| "I'll just fix the missing NULL check myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |
| "The overflow can't realistically happen with real-world inputs" | Untrusted input is exactly the case an attacker controls; a signed-overflow bounds check exists for the input that isn't realistic in normal use |

## Verification

Do not report the review done until all of the following hold:

- Every changed C/C++ file in the diff was read, not just files named in
  the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
