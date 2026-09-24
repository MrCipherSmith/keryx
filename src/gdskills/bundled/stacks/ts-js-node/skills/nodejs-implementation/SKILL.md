---
name: nodejs-implementation
description: "Use when implementing or extending a feature in a Node.js service, library, or CLI written in TypeScript or JavaScript -- covers tsconfig strictness, ESM/node: protocol imports, async/await with AbortSignal, error handling with cause, and input validation at process boundaries. Not for UI markup/rendering code (use the matching UI framework pack) or writing/fixing tests (use nodejs-testing)."
triggers:
  - "implement this Node.js endpoint"
  - "add a feature to this TypeScript service"
  - "write a CLI command in Node"
  - "build this Node.js library function"
  - "implement async handler with AbortSignal"
  - "add input validation to this API route"
  - "implement this Express route handler"
  - "build this Node.js order processing function"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Node.js implementation (TypeScript/JavaScript)

Implement or extend a feature in a Node.js service, library, or CLI written
in TypeScript or JavaScript -- server-side and shared/library code, not
UI markup/rendering code (that is the matching UI framework pack's job
once it extends this one). See `rules/coding-style.mdc` and
`rules/patterns.mdc` for the full rule set this skill draws its checks
from.

## Workflow

### Step 1: Discover the project's own conventions

1. Read `tsconfig.json` (or `jsconfig.json`): `strict`, `moduleResolution`
   (`nodenext` vs `bundler`), `target`, path aliases (`paths`/`baseUrl`).
2. Read `package.json`: `"type"` (`module` vs `commonjs`, or absent =
   commonjs), `engines.node`, the `exports` map if the project publishes a
   package, and which HTTP/validation/DB libraries are already dependencies
   -- reuse them rather than introducing a competing one.
3. Read 1-2 neighboring modules that already do something similar (a sibling
   route handler, a sibling exported function) for import order, error
   handling shape, and whether the project favors classes or plain
   functions.

### Step 2: Plan the change

- Identify every external input the new code touches (HTTP body/query/
  params, CLI args, env vars, a file, a queue message) -- each one gets
  validated at the point it enters the function, per `rules/patterns.mdc`.
- Identify every async boundary (a DB call, an outbound `fetch`, a
  filesystem read) and decide how it is cancelled/timed-out: pass an
  `AbortSignal` through rather than adding a bespoke timeout mechanism.
- Decide the error contract: does a failure throw, or return a
  discriminated result? Match what the surrounding code in the same module
  already does.

### Step 3: Implement

1. Use `node:` prefixed imports for Node built-ins
   (`import { readFile } from "node:fs/promises"`).
2. Type every new/changed exported function signature; use `unknown` (not
   `any`) for data whose shape is not yet validated, and narrow it with a
   validator or a type guard before use.
3. Use `async`/`await`; thread an `AbortSignal` into `fetch` and any other
   cancelable call (`AbortSignal.timeout(ms)` for a fixed budget, or a
   caller-supplied signal for a request-scoped one).
4. On failure, throw an `Error` (or a project error class) with a message
   naming what failed and the relevant identifier; chain the original
   cause with `new Error("...", { cause })` when wrapping a lower-level
   error.
5. Validate external input at the boundary (schema library if the project
   has one, explicit checks if not) before it reaches business logic.

### Step 4: Verify

```bash
npx tsc --noEmit
npx eslint .
```

Run the project's own build/lint scripts from `package.json` if they
differ from the above. Do not hand test-writing to this skill -- once the
feature compiles and lints clean, hand off to `nodejs-testing` for test
coverage, or write tests yourself following `rules/testing.mdc` if asked to
do both in one pass.

### Step 5: Report

```
Implemented: src/routes/orders.ts
  - POST /orders handler, validates body with zod, calls OrderService.create
  - tsc --noEmit: clean
  - eslint: clean
```

## Rules

- Follow `rules/coding-style.mdc` for typing, module shape, naming, and
  import order; `rules/patterns.mdc` for validation-at-boundary, DI, and
  the anti-patterns to avoid.
- NEVER introduce a new runtime dependency for something the project's
  existing dependencies (or Node's own built-ins) already cover.
- NEVER leave a floating promise -- await it, return it, or `void` it
  explicitly when fire-and-forget is genuinely intended.
- NEVER do synchronous filesystem/crypto work on a request-handling path;
  use the `fs/promises`/async variant.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll type this as `any` for now and fix it later" | `any` disables the type checker for everything downstream of it; use `unknown` and narrow instead, even under time pressure |
| "This fetch doesn't need a timeout, the server is reliable" | An unbounded outbound call with no `AbortSignal` can hang the request indefinitely if the dependency stalls |
| "I'll validate the input inside the service layer, not the route handler" | Unvalidated data crossing into business logic is the boundary rule's whole point -- validate where it enters the process, not two layers deeper |
| "console.log the error and move on, it's not critical" | Swallowing an error without rethrowing or returning a typed failure hides the failure from every caller |

## Verification

Do not report the work done until all of the following hold:

- `npx tsc --noEmit` (or the project's own type-check script) exits 0.
- `npx eslint .` (or the project's own lint script) exits 0 with no new
  `any`, no new eslint-disable comments added to silence a real finding.
- Every external input the new code accepts is validated before use.
- Every `Promise` created by the new code is awaited, returned, or
  explicitly `void`-ed.
- `git status` shows only the files the change actually needed.
