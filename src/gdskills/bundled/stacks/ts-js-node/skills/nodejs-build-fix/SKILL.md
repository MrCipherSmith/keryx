---
name: nodejs-build-fix
description: "Use when resolving `tsc` type errors, module resolution failures (ESM/CJS, moduleResolution nodenext/bundler, `type: module`, exports maps), or lint/test failures blocking a Node.js TypeScript/JavaScript build. Applies the smallest root-cause fix and never silences the checker with @ts-ignore, any, or eslint-disable. Not for Go/Rust/Python build failures, and not for implementing new features (use nodejs-implementation)."
triggers:
  - "fix this tsc type error"
  - "resolve this module not found error in Node"
  - "fix ESM/CJS import error"
  - "the build fails with moduleResolution error"
  - "fix this eslint failure blocking CI"
  - "package.json exports map is breaking the build"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Node.js build-fix (tsc / module resolution / lint)

Resolve a `tsc` type error, module resolution failure, or lint/test
failure blocking a Node.js TypeScript/JavaScript build. Applies the
smallest change that fixes the actual root cause -- never a change that
merely makes the checker stop complaining. See `rules/coding-style.mdc`
for the typing/module conventions a correct fix should restore.

## Workflow

### Step 1: Reproduce the failure

```bash
npx tsc --noEmit
npx eslint .
npm test
```

Run the project's own `package.json` scripts (`build`, `lint`, `test`) if
they differ from the above -- they may wrap these with project-specific
flags (path mapping, project references). Capture the exact error message
and file:line; do not guess at the cause from the symptom alone.

### Step 2: Classify the failure

- **Type error** (`tsc`): a genuine type mismatch, a missing property, an
  incompatible generic instantiation, or a `noImplicitAny` violation.
- **Module resolution error**: `Cannot find module`, `has no exported
  member`, an ESM/CJS interop error (`require() of ES Module`, `Unknown
  file extension`), or an `exports` map mismatch.
- **Lint error**: an `eslint` rule violation -- read the rule name in the
  output, not just the message.
- **Test failure**: an assertion failure or a runner-level error (setup
  crash, timeout).

### Step 3: Find the root cause

**Type errors**: read the actual inferred type at the error site (hover
equivalent: trace the value back to its declaration or the function that
returned it) before changing anything. A type error is usually telling
the truth about a real mismatch, not a checker false positive.

**Module resolution**: check `package.json`'s `"type"` field,
`tsconfig.json`'s `moduleResolution`, and whether the failing import
crosses an ESM/CJS boundary (a CJS package with no ESM build, imported
from ESM code, or vice versa). Check the target package's own `exports`
map in its `package.json` for what subpaths it actually publishes.

**Lint**: read what the specific rule enforces (not just its name) before
changing code to satisfy it -- some rules require a structural change
(e.g. `no-floating-promises` wants an `await`, not a suppression).

**Test failures**: determine whether the test is wrong (asserts stale
behavior) or the source is wrong (behavior regressed) before touching
either -- read the test's intent from its name and assertions first.

### Step 4: Apply the smallest correct fix

- A type error: fix the actual type mismatch (correct the signature, add
  the missing property, narrow the union) -- not a suppression.
- A module resolution error: fix the import path/extension, the
  `tsconfig.json` setting that genuinely matches the project's runtime
  target, or the `package.json` `exports`/`type` field -- not a blanket
  `moduleResolution: "node"` downgrade that papers over the real
  ESM/CJS boundary issue.
- A lint error: change the code to satisfy the rule's actual intent.
- A test failure: fix the source if behavior regressed, or fix the test if
  its expectation was stale -- state which, and why, in the report.

### Step 5: Verify and report

Re-run the exact command from Step 1; confirm it now exits 0. Report the
root cause and the fix, not just "error resolved".

```
Fixed: src/lib/orderQueue.ts:18
  Root cause: `OrderQueue.push` typed its callback parameter as `any`,
  masking a real mismatch where callers passed `OrderEvent` but the queue
  expected `QueueItem`.
  Fix: added the `QueueItem` mapping in `toQueueItem()`, removed the `any`.
  Verified: tsc --noEmit exits 0.
```

## Rules

- Follow `rules/coding-style.mdc` for the typing/module conventions a fix
  must restore, not just silence.
- ALWAYS fix the root cause with the smallest change; never widen the fix
  beyond the file(s) the failure actually touches.
- NEVER use `@ts-ignore`, an undocumented `@ts-expect-error`, a cast to
  `any`, or an `eslint-disable` comment to make an error/warning
  disappear.
- NEVER flip `strict`, `noImplicitAny`, `skipLibCheck`, or widen
  `moduleResolution` in `tsconfig.json` just to make a specific error go
  away -- a tsconfig change is only correct when it fixes a genuine
  project-wide misconfiguration, and it needs to be called out explicitly
  as such in the report.
- NEVER delete or skip a failing test to turn the suite green.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just add `@ts-ignore` above this line, it's probably a false positive" | `tsc` is almost never wrong about a real mismatch; verify the type before assuming the checker is broken |
| "I'll cast to `any` here to unblock the build, someone can type it properly later" | The build-fix skill's whole purpose is the properly-typed fix; `any` defers the real work indefinitely |
| "eslint-disable this line, the rule doesn't apply here" | If the rule genuinely does not apply, that is a project-level rule config change to propose, not a per-line suppression buried in an unrelated fix |
| "This test is flaky, I'll just skip it to unblock CI" | Skipping a failing test does not fix the build, it hides a real signal; find the root cause or report it unresolved |

## Verification

Do not report the fix done until all of the following hold:

- The exact command that reproduced the failure in Step 1 now exits 0.
- No `@ts-ignore`, `@ts-expect-error` (without a linked issue already
  present before this fix), `any` cast, or `eslint-disable` was added.
- No unrelated `tsconfig.json`/`eslint` config was loosened.
- The report states the actual root cause, not just "fixed the error".
- `git status` shows changes confined to the files the root cause
  required.
