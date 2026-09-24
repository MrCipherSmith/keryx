---
name: nodejs-esm-migration
description: "Use when migrating a Node.js package or app from CommonJS to ES modules -- package.json type/exports map changes, adding file extensions to relative imports, replacing __dirname/__filename with import.meta.dirname/filename, fixing require() of an ESM-only dependency, dual-package hazards, and the resulting Jest/tsconfig adjustments. Not for a greenfield ESM project (use nodejs-implementation) or a general dependency upgrade (use dependency-update)."
triggers:
  - "migrate this package from CommonJS to ESM"
  - "convert require to import in this Node project"
  - "fix require() of ES module error"
  - "add type module to package.json"
  - "replace __dirname with import.meta"
  - "this package is dual CJS/ESM, fix the exports map"
metadata:
  origin: authored
  category: migrate
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Node.js CommonJS -> ESM migration

Migrate a Node.js package or application from CommonJS to ES modules.
Covers the `package.json` fields that change, the syntax changes each
file needs, and the test/build tooling adjustments the migration usually
breaks. See `rules/coding-style.mdc` for the ESM import conventions the
migrated code should end up following.

## Workflow

### Step 1: Assess the current state

1. Read `package.json`: current `"type"` (absent/`"commonjs"` means CJS),
   `"main"`/`"exports"`, `engines.node`, and every dependency's own module
   type (many packages ship ESM-only in recent majors -- check their
   `package.json` `"type"`/`"exports"` before assuming a `require()` of
   them will keep working).
2. Grep the codebase for `require(`, `module.exports`, `exports.`,
   `__dirname`, `__filename` to size the migration.
3. Check `tsconfig.json` (if TypeScript) for `module`/`moduleResolution`,
   and any Jest/build config that assumes CJS (`babel-jest` CJS transform,
   `ts-jest` with `module: commonjs`).

### Step 2: Plan the `package.json` changes

- Add `"type": "module"` once every file in the package is converted (a
  mixed package needs `.cjs`/`.mjs` extensions instead, see Step 4's
  dual-package note) -- do not flip `"type"` before the conversion is
  done, or every remaining `.js` file with `require()` breaks at once.
- Define an `"exports"` map for anything the package publishes as a
  library, naming exact subpaths rather than relying on the old
  `"main"` fallback resolution -- a consumer importing an undeclared
  subpath now gets `ERR_PACKAGE_PATH_NOT_EXPORTED` instead of silently
  resolving.
- Set `moduleResolution: "nodenext"` (or `"bundler"` if the project is
  bundled rather than run directly by Node) in `tsconfig.json` to match.

### Step 3: Convert each file

1. `require("pkg")` -> `import pkg from "pkg"` (or named imports, matching
   what the dependency actually exports); `module.exports = x` ->
   `export default x`; `exports.foo = ...` -> `export function foo() {...}`
   / `export const foo = ...`.
2. `__dirname`/`__filename` -> `import.meta.dirname`/`import.meta.filename`
   (Node 20.11+/22+; for older targets, derive from
   `fileURLToPath(import.meta.url)`).
3. Add explicit file extensions to relative imports
   (`import { x } from "./util.js"`, even when the source is `.ts` --
   Node's ESM resolver needs the emitted `.js` extension, not the
   source's `.ts`) when `moduleResolution: nodenext` requires it.
4. JSON imports need an import attribute:
   `import data from "./data.json" with { type: "json" }`.

### Step 4: Handle interop hazards

- **`require()` of an ESM-only dependency**: cannot be fixed by import
  syntax alone -- either convert the importing file to ESM too, or use a
  dynamic `await import("pkg")` inside an async context if the file
  genuinely cannot become ESM yet.
- **Dual-package hazard**: if the package must ship both CJS and ESM
  builds simultaneously (a published library with CJS consumers), use
  explicit `.cjs`/`.mjs` extensions per file rather than a single
  `"type"` field, and mirror both in the `"exports"` map's `"require"`/
  `"import"` conditions -- a class exported from both builds must resolve
  to the same instance to avoid `instanceof` failing across the boundary.
- **Named vs default export mismatch**: some CJS packages only interop
  cleanly as a default import (`import pkgDefault from "cjs-pkg"`) even
  when their types suggest named exports -- verify at runtime, not just
  against the type declarations.

### Step 5: Fix the tooling

- Jest: either migrate to Vitest (native ESM) or configure Jest's ESM
  support (`"type": "module"` + `NODE_OPTIONS=--experimental-vm-modules`,
  or `ts-jest` with `useESM: true`) -- check the project's own test
  runner choice before assuming Jest config changes are the right move.
- Update any build script that assumed `require.resolve` or CJS-only
  bundler settings.

### Step 6: Verify and report

```bash
npx tsc --noEmit
node --test   # or the project's configured test command
npx eslint .
```

```
Migrated: packages/order-lib (CommonJS -> ESM)
  - package.json: type: module, exports map for ./client and ./server
  - 14 files converted: require/module.exports -> import/export
  - __dirname replaced with import.meta.dirname in 2 files
  - tsconfig moduleResolution: commonjs -> nodenext
  - tsc --noEmit: clean, tests: 42 passing
```

## Rules

- Follow `rules/coding-style.mdc` for the resulting import conventions
  (`node:` prefix, import ordering, `import type`).
- Convert a package's files together, not incrementally left half-CJS/
  half-ESM with `"type": "module"` already flipped -- that breaks every
  unconverted `.js` file that still uses `require()`.
- Verify a CJS dependency's actual runtime export shape before writing the
  import -- its type declarations can disagree with its runtime
  `module.exports` shape.
- NEVER silently drop a published package's CJS `"exports"` condition
  without confirming no consumer still needs it (check the package's own
  changelog/major-version policy, or ask if unclear).

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add `type: module` first, then convert the files" | Every remaining `require()`-using `.js` file breaks immediately once `type: module` flips; convert first, flip the field last |
| "`__dirname` isn't available in ESM, I'll just hardcode the path" | `import.meta.dirname` (or `fileURLToPath(import.meta.url)` on older Node) replaces it correctly; a hardcoded path breaks the moment the package is installed elsewhere |
| "This dependency's types show named exports, I'll import it that way" | CJS interop can differ from the type declarations at runtime; verify the actual shape before trusting the `.d.ts` |
| "I'll drop the CJS exports condition, ESM is the future" | Breaks every CJS consumer still depending on `require()`; only drop it with confirmation that nothing needs it |

## Verification

Do not report the migration done until all of the following hold:

- No remaining `require(`/`module.exports`/`exports.` in a file the
  migration covers (dynamic `await import()` for a documented interop
  exception is fine and should be called out).
- `package.json`'s `"type"` and `"exports"` reflect the final module shape.
- `npx tsc --noEmit` (or the project's build) exits 0.
- The project's test command exits 0 with every test passing.
- `git status` shows only the files the migration actually touched.
