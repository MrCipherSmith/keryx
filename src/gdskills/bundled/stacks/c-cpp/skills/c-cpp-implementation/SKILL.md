---
name: c-cpp-implementation
description: "Use when implementing or extending a feature in C or modern C++ (17/20/23) -- ownership and RAII, smart pointer choice, move semantics, std::span, manual malloc/free lifetime in C, and choosing safe standard-library APIs over unsafe ones."
triggers:
  - "implement this feature in modern C++"
  - "add a function to this C module"
  - "which smart pointer should own this object"
  - "convert this raw new/delete to RAII"
  - "add a std::span-based API for this buffer"
  - "write the malloc/free lifetime for this C struct"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# C / C++ implementation (C++17/20/23, C99/C11+)

Implement or extend a feature in a C or C++ codebase: ownership design,
resource lifetime, memory safety, and modern idiom for whichever of the
two languages the file under change actually is. Scoped to C/C++
specifically — `rules/coding-style.mdc`, `rules/patterns.mdc`, and
`rules/security.mdc` carry the full stack-specific rule set this skill's
checklist is built from; read them before writing code, not just this
summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Identify the build system (`CMakeLists.txt`, `Makefile`, `meson.build`)
   and the C/C++ standard it targets (`CMAKE_CXX_STANDARD`, `-std=`
   flags) — do not use a language feature (`std::span`, `constexpr` on a
   function that needs C++20, a C11-only `_Generic`) the project's own
   declared standard predates.
2. Determine whether the file under change is C or C++ from its
   extension (`.c`/`.h` vs `.cpp`/`.cc`/`.cxx`/`.hpp`/`.hxx`) and match
   that language's idiom — do not introduce C++-only constructs
   (`std::unique_ptr`, exceptions, namespaces) into a `.c` file.
3. Read 1-2 neighboring files for: existing ownership style (smart
   pointers vs. manual `malloc`/`free`), whether the project has a
   `.clang-format`/`.clang-tidy` config, existing error-handling
   convention (exceptions, error codes, `std::expected`), and whether a
   testing framework (GoogleTest, Catch2) is already wired into the
   build.

### Step 2: Design ownership before writing

- For every new heap allocation, decide who owns it and for how long
  *before* writing the allocation: a `std::unique_ptr` (single owner,
  the default), a `std::shared_ptr` (only when ownership is genuinely
  shared across objects with independent lifetimes), a stack/automatic
  object (when it never needs to outlive its scope), or — in C — a
  `malloc`/`free` pair with an explicit, documented ownership contract in
  the header comment.
- Trace every pointer/reference this change returns or stores: does it
  outlive the object it points into? A pointer or reference into a local
  variable, a temporary, or a container element that might reallocate is
  a use-after-free or dangling-reference bug the moment it escapes.
- For concurrent access, decide up front which mutex (or `std::atomic`)
  guards which shared variable — do not add a shared variable first and
  retrofit synchronization after a race shows up.

### Step 3: Implement

1. C++: prefer RAII types (smart pointers, `std::lock_guard`,
   `std::vector`/`std::string`) over manual acquire/release; use
   `std::make_unique`/`std::make_shared`, not a bare `new` handed to a
   smart pointer constructor.
2. C: check every `malloc`/`calloc`/`realloc` return for `NULL`; release
   every acquired resource on every exit path (a `goto cleanup;` pattern
   for functions with more than one early return keeps this from being
   duplicated and missed).
3. Use `std::span` (C++20+) for a non-owning view over a buffer instead
   of a raw `(pointer, length)` pair when the project's standard allows
   it; validate every index/length derived from untrusted input before
   it reaches a read or write.
4. Move rather than copy when transferring ownership (`std::move` into a
   by-value parameter, or an rvalue-ref overload) for anything
   non-trivially-copyable.
5. Use a named cast (`static_cast`/`const_cast`/`reinterpret_cast`) in
   C++, never a C-style cast — it states which conversion is actually
   intended.
6. Format with the project's configured `clang-format` as you go, not as
   an afterthought.

### Step 4: Verify

```bash
cmake --build build   # or the project's own configured build command
ctest --test-dir build --output-on-failure
```

For anything touching manual memory management, buffers, pointer
arithmetic, or concurrency, also build and run under sanitizers before
reporting done:

```bash
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug \
  -DCMAKE_CXX_FLAGS='-fsanitize=address,undefined -fno-omit-frame-pointer -g'
cmake --build build-asan && ctest --test-dir build-asan --output-on-failure
```

A build/test/sanitizer failure at this step is a signal to fix the
implementation, not to reach for `c-cpp-build-fix`'s scope unless the
failure is a build/toolchain/link problem unrelated to the feature logic.

### Step 5: Report

```
Implemented: src/parser/token_stream.cpp, include/parser/token_stream.hpp
  - std::unique_ptr-owned TokenStream, std::span<const char> input view
  - build + ctest + ASan/UBSan build all pass
```

## Rules

- Never write a raw `new`/`malloc` whose matching `delete`/`free` is not
  either in the same RAII destructor or on every exit path of the
  function that allocated it.
- Never return, store, or capture a pointer/reference to a local
  (stack-lifetime) variable, or to a temporary's member.
- Never dereference a `malloc`/`new` result without first checking it for
  `NULL`/an exception path.
- Match the project's declared C/C++ standard — do not use a language or
  library feature newer than what the build configuration targets.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll use `shared_ptr` here so I don't have to think about who owns it" | `shared_ptr` is not a substitute for an ownership decision — reaching for it by default hides a real single-owner relationship behind atomic refcounting and can create reference cycles a `unique_ptr` design would have made obvious |
| "This buffer's length is always correct in practice, I won't re-check it" | "In practice" is not a proof; an unchecked length from untrusted input is exactly how a buffer overflow gets in |
| "I'll return a pointer to this local struct, the caller will use it right away" | "Right away" still means after the function returns, by which point the stack frame is gone; the pointer is already dangling at the call site |
| "malloc can't really fail here, I'll skip the NULL check" | A failed allocation dereferenced as non-NULL is a guaranteed crash or corruption the moment it does happen; the check costs one branch |

## Verification

Do not report the work done until all of the following hold:

- The project's configured build and test commands exit 0.
- For any change touching manual memory management, buffers, or
  concurrency: an ASan+UBSan (and, for threaded code, TSan) build of the
  touched tests also passes clean.
- Every new heap allocation has a traceable single owner (an RAII type,
  or a documented `malloc`/`free` contract) — no bare `new`/`malloc` with
  no visible release path.
- No pointer or reference returned or stored by the change outlives the
  object it refers to.
