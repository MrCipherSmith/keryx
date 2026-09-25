---
name: c-cpp-build-fix
description: "Use when a C/C++ build fails -- CMake configure/link errors, missing headers, template/generic-instantiation errors, ABI/linker mismatches -- or when a sanitizer (ASan/UBSan/TSan) or ctest run reports a memory-safety, UB, or race failure, with the smallest root-cause fix."
triggers:
  - "cmake build is failing"
  - "fix this linker error"
  - "AddressSanitizer reports a heap-buffer-overflow"
  - "UBSan reports signed overflow"
  - "ThreadSanitizer flags an unsynchronized access to this shared counter"
  - "fix this C++ template instantiation error"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# C / C++ build fix

Resolve a C/C++ build/configure/link failure, or a sanitizer/`ctest`
failure — with the smallest change that fixes the actual root cause.
`rules/coding-style.mdc`, `rules/patterns.mdc`, and `rules/security.mdc`
govern what a "correct" fix looks like; this skill never reaches for a
suppression instead of a fix.

## Workflow

### Step 1: Reproduce and classify

```bash
cmake --build build
ctest --test-dir build --output-on-failure
```

Read the exact error text and classify it:

- **Configure error** (CMake cache mismatch, a missing `find_package`
  dependency, a stale `build/` directory from a changed toolchain).
- **Compile error** (undefined symbol, type mismatch, missing header,
  wrong argument count/type).
- **Template/generic-instantiation error** (a template that cannot
  deduce its argument, a constraint/concept that is not satisfied, an
  incomplete type used where a complete one is required).
- **Link/ABI error** (undefined reference, a symbol built against a
  different ABI or ODR-violating duplicate definition across translation
  units, a missing `target_link_libraries`).
- **Sanitizer failure** (ASan `heap-buffer-overflow`/`use-after-free`,
  UBSan `signed integer overflow`/`misaligned address`, TSan
  `data race`) — read the sanitizer's full stack trace; it names the
  exact faulting access and, for TSan, both racing accesses.
- **Test failure** (`ctest` reports a failing case with no sanitizer
  involved).

### Step 2: Fix by category

**Configure/CMake:** re-run configure after a clean `build/` directory
when the cache is simply stale against changed `CMakeLists.txt`. For a
genuine missing dependency, add the correct `find_package`/
`target_link_libraries` rather than hand-pointing at a local path that
happens to work on one machine.

**Compile error:** fix the actual type/signature/missing-include issue
the compiler names. A missing header is fixed by including the header
that actually declares the symbol, not by forward-declaring around it
unless the project's own convention already does that intentionally.

**Template/generic-instantiation:** check whether the call site can
supply the type argument explicitly, or whether a concept/`static_assert`
is correctly rejecting an unsupported type (in which case the fix is at
the call site, not the template). Do not loosen a constraint just to make
an unrelated instantiation compile.

**Link/ABI:** an undefined reference usually means a missing
`target_link_libraries` entry or a translation unit not compiled into
the target — fix the CMake target graph. An ODR violation (the same
symbol defined differently in two translation units) is fixed by
unifying the definition, never by reordering link order to hide it.

**Sanitizer failure (ASan/UBSan):** read the exact faulting access from
the report (allocation site, free site if UAF, faulting instruction) and
add the actual missing check/ownership fix at that point — a bounds
check, a lifetime fix (return by value instead of a reference into a
temporary), or a `NULL` check. Never rebuild without the sanitizer to
make the failure "go away"; that hides the bug, it does not fix it.

**Sanitizer failure (TSan):** add synchronization (mutex, atomic, or a
join/wait) at the specific shared-state access TSan names for both
racing accesses — do not just serialize the whole test or add a `sleep`
to hide the timing window.

**Test failure (no sanitizer):** fix the assertion or the code it tests,
whichever is actually wrong per the spec — never loosen an assertion just
to make it pass.

### Step 3: Verify

```bash
cmake --build build
ctest --test-dir build --output-on-failure
```

Re-run under the sanitizer that originally caught the failure (ASan+UBSan
or TSan) if the failure came from one — the fix is not verified until the
sanitizer run is also clean, not just the plain build.

### Step 4: Report

```
Fixed: src/parser/token_stream.cpp — heap-buffer-overflow in
TokenStream::peek() (ASan)
  - Root cause: peek() read one byte past the buffer on the last token
    boundary; missing bounds check before the trailing-byte read
  - Build + ctest + ASan/UBSan re-run all pass
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER disable, narrow the scope of, or suppress a sanitizer finding
  instead of fixing the underlying memory-safety/UB/race bug it caught.
- NEVER reintroduce an unsafe API (`strcpy`, `sprintf`, `gets`) while
  resolving an unrelated failure.
- NEVER loosen a template constraint, a `static_assert`, or a test
  assertion just to make a failure disappear without understanding why
  it was there.
- NEVER change the project's declared C/C++ standard just to make an
  error disappear without understanding why the code needs it.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just turn off ASan for this test so CI goes green" | Silences the finding without fixing the memory-safety bug it caught; fix the bounds/lifetime issue at the site ASan names instead |
| "This data race is rare, I'll add a sleep to make it stop happening" | A `sleep` narrows the timing window without removing the race; TSan will still be correct that the access is unsynchronized, and the race can still fire under different scheduling |
| "I'll widen this concept/constraint so more types compile" | Loosening a constraint to silence one instantiation failure can let a genuinely unsupported type instantiate the template incorrectly elsewhere |
| "sprintf is fine here, the buffer is 'probably' big enough" | "Probably" is exactly the assumption that turns into a buffer overflow the first time an input is bigger than expected; use `snprintf` |

## Verification

Do not report the fix done until all of the following hold:

- `cmake --build build` and `ctest --test-dir build --output-on-failure`
  both exit 0.
- If the original failure came from a sanitizer, the sanitizer build/run
  is re-verified clean, not just the plain build.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched.
- The report states the root cause in one sentence, not just "build now
  passes."
