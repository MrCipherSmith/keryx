---
name: nodejs-code-review
description: "Use when reviewing a TypeScript or JavaScript Node.js change (a service, library, or CLI diff) for floating promises, unhandled rejections, `any` leaks, event-loop-blocking sync calls, resource cleanup gaps, and dependency risk. Read-only -- reports findings, never edits code. Not for React component review, general architecture review, or security-only audits (use review-security-code for a broader OWASP pass)."
triggers:
  - "review this Node.js diff before merging"
  - "check this TypeScript diff for floating promises"
  - "review this Node.js route handler change for resource cleanup"
  - "audit this Node service for blocking calls"
  - "review this npm package change for dependency risk"
  - "check this async function for unhandled rejections"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Node.js code review (TypeScript/JavaScript)

Review a TypeScript or JavaScript Node.js change -- server, library, or CLI
code -- for the failure modes generic review misses: floating promises,
unhandled rejections, `any` leaking into a typed codebase, event-loop
blocking, resource leaks, and risky new dependencies. Read-only: this
skill reports findings and never edits code. See `rules/security.mdc` and
`rules/patterns.mdc` for the underlying rule set.

## Workflow

### Step 1: Scope the diff

1. Identify the changed/added files under this pack's extensions
   (`.ts`, `.js`, `.mjs`, `.cjs`) -- skip `.tsx`/`.jsx` component files,
   those belong to the `react` pack's reviewer.
2. Read enough surrounding context (the calling module, the function's
   existing callers) to judge whether a change is actually reachable with
   attacker- or user-controlled input, not just in isolation.

### Step 2: Check each changed file against the focus list

- **Floating promises**: every `Promise`-returning call is awaited,
  returned, or explicitly `void`-ed. A bare `doAsyncThing();` statement
  with no `await`/`return`/`void` and no `.catch()` is a floating promise.
- **Unhandled rejections**: an async chain with no `.catch()`/`try-catch`
  anywhere along it, or a `Promise.all([...])` where one rejection is not
  handled -- especially inside an event handler or a fire-and-forget call.
- **`any` leaks**: a new or widened `any` on a changed exported signature,
  or a cast (`as any`, `as unknown as X`) that erases a narrower type the
  code already had available.
- **Event-loop blocking**: synchronous `fs`/`crypto`/`zlib` calls
  (`readFileSync`, `execSync`, `scryptSync`, `gzipSync`) on a path that
  handles requests or runs in a hot loop, instead of the async/`/promises`
  variant.
- **Resource cleanup**: an opened file handle, DB connection, timer,
  event listener, or child process that is not closed/cleared on every
  exit path, including the error path (missing `finally`, missing
  `close()`/`removeListener()`/`clearTimeout()`).
- **Dependency risk**: a new `package.json` dependency added for
  something Node's built-ins or an existing dependency already cover, or
  with no clear justification in the diff/PR description.

### Step 3: Classify and report findings

For each finding, cite the file, line, and a one-line fix direction (not a
patch -- this skill does not edit code). Group by severity:

- **Blocking**: unhandled rejection reachable from user input, resource
  leak in a long-lived process, sync blocking call on a hot path.
- **Should fix**: floating promise with no downstream effect on
  correctness but silent-failure risk, `any` leak on an internal-only
  signature, an unjustified new dependency.
- **Note**: style-level deviations from `rules/coding-style.mdc` already
  covered by lint but visible in the diff.

### Step 4: Report

```
Reviewed: src/routes/orders.ts, src/lib/orderQueue.ts (2 files)

Blocking (1):
- src/lib/orderQueue.ts:42 -- `processQueue()` called with no await/void/catch
  in the request handler; a rejection here becomes an unhandled rejection
  that can crash the process. Await it or attach `.catch()`.

Should fix (2):
- ...

Note (1):
- ...
```

## Rules

- NEVER edit source files -- this skill only produces findings.
- Cross-check every "blocking" finding against `rules/security.mdc` for
  Node-specific risk (child_process, path traversal, prototype pollution,
  SSRF, eval/vm, ReDoS, secrets in logs) before finalizing severity.
- Do not flag a floating promise that is deliberately `void`-ed with a
  comment explaining why -- that is the correct pattern for genuine
  fire-and-forget.
- Do not re-flag something the project's own lint config already catches
  and enforces in CI (check for an eslint rule covering it) unless the
  diff bypasses it with a disable comment.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This is just a review, I'll fix the obvious floating promise myself" | Review skills are read-only; fixing code here bypasses the author's own review of the change |
| "The `any` cast is only in a test helper, skip it" | Still worth a Note-level finding -- an `any` in shared test infrastructure spreads into every test that imports it |
| "No resource cleanup finding needed, the process restarts often anyway" | A process restart schedule is an operational mitigation, not a reason to skip a genuine leak; report it |
| "The new dependency is small, no need to flag it" | Size is not the risk -- an unvetted dependency (however small) adds a supply-chain surface; flag it and let the author justify it |

## Verification

Do not report the review done until all of the following hold:

- Every changed `.ts`/`.js`/`.mjs`/`.cjs` file in the diff was checked
  against all six focus areas in Step 2.
- Every finding cites a file and line, not a vague "somewhere in this
  file".
- No source file was modified -- `git status` (or the diff tool's own
  state) shows zero changes from this skill's run.
- Findings are grouped by severity (Blocking / Should fix / Note).
