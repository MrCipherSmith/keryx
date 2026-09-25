---
name: nextjs-nuxt-build-fix
description: "Use when resolving a Next.js build/type error ('use client'/'use server' boundary violation, a Server Component importing a client-only hook, an invalid Route Handler export) or a Nuxt build/type error (an auto-imported composable/component that fails to resolve, a nuxi typecheck failure, a hydration-mismatch warning) blocking `next build` or `nuxi build`. Applies the smallest root-cause fix and never silences it with ssr: false, suppressHydrationWarning, or a widened tsconfig. Not for generic tsc/ESM module-resolution errors with no meta-framework cause (use nodejs-build-fix), and not for implementing a new feature (use nextjs-nuxt-implementation)."
triggers:
  - "fix this use client server component boundary error"
  - "next build fails with a Server Component importing useState"
  - "nuxi typecheck fails on this auto-imported composable"
  - "fix this hydration mismatch warning in Next.js"
  - "route handler export is invalid in this Next.js app router file"
  - "nuxt build can't resolve this composable"
  - "fix this Next.js build error about async component"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Next.js / Nuxt build-fix

Resolve a `next build`/`nuxi build`/`nuxi typecheck` failure caused by a
meta-framework-specific boundary or resolution error. Applies the
smallest change that fixes the actual root cause — never a change that
merely makes the build stop complaining. See `rules/patterns.mdc` for the
boundary/composable-context rules a correct fix should restore.

## Workflow

### Step 1: Reproduce the failure

```bash
# Next.js
npx tsc --noEmit
npx next build

# Nuxt
npx nuxi typecheck
npx nuxi build
```

Run the project's own `package.json` scripts if they wrap these
differently. Capture the exact error and file:line before changing
anything.

### Step 2: Classify the failure

- **Server/Client boundary error** (Next.js): "You're importing a
  component that needs `useState`/`useEffect`/an event handler. This
  React hook only works in a Client Component" or similar — a Server
  Component (no `'use client'`) imports something that needs the client
  runtime.
- **Server-only import reaching the client** (Next.js): a build error or
  warning about a Node-only module (`fs`, `node:crypto`) or a
  `'use server'`-only import ending up in a client bundle.
- **Invalid Route Handler shape** (Next.js): `route.ts` exporting
  something other than the recognized HTTP method functions
  (`GET`/`POST`/etc.), or missing the required async signature.
- **Auto-import resolution failure** (Nuxt): `nuxi typecheck`/build
  cannot resolve a composable/component that should be auto-imported —
  usually a naming mismatch, wrong directory, or a missing `export`.
- **Composable-context error** (Nuxt): "must be called within a
  `setup()`" or similar — a composable was invoked outside the
  synchronous setup window.
- **Hydration mismatch warning**: server-rendered HTML text/attributes
  don't match the client's first render.

### Step 3: Find the root cause

- Boundary error: find which import in the Server Component actually
  needs the client runtime, and trace whether it belongs in a smaller
  extracted Client Component, or whether the whole file was mistakenly
  missing `'use client'`.
- Auto-import failure: check the file lives in a directory Nuxt actually
  scans (`composables/`, `components/`, `utils/` by default, or a
  configured `imports`/`components` dir in `nuxt.config.ts`) and exports
  what's being imported under the expected name.
- Hydration mismatch: trace the mismatched text/attribute back to its
  source — usually `Date.now()`, `Math.random()`, `typeof window`
  branching, or a locale-dependent format called during render.

### Step 4: Apply the smallest correct fix

- Boundary error: add `'use client'` to the smallest component that
  actually needs it (extracting it into its own file if it's currently
  bundled with server-only siblings) — not to the whole page/layout.
- Server-only import leak: move the server-only code behind its own
  `'use server'` file or a `server/`-only module, and pass only the
  derived, safe result down as a prop.
- Route Handler shape: export the correct named HTTP method function
  with the framework's expected signature — not a default export or a
  renamed function.
- Auto-import failure: fix the file's location/export name/registration
  — not a hand-added explicit import that routes around Nuxt's
  convention, unless the project has deliberately disabled auto-imports.
- Composable-context error: move the call to the synchronous top level
  of `setup()`/a plugin/middleware — not a workaround that stores the
  composable's return value in a ref before the async point instead of
  fixing the call site.
- Hydration mismatch: make the value deterministic across server and
  client (compute it once and pass it down, or gate the
  client-only-varying part behind a mount-effect check) — not
  `suppressHydrationWarning` or Nuxt's `<ClientOnly>`/`ssr: false` used as
  a blanket cover for the mismatch.

### Step 5: Verify and report

Re-run the exact command from Step 1; confirm it exits 0 with no new
warnings. Report the root cause and the fix, not just "build passes now".

## Rules

- Follow `rules/patterns.mdc` for the boundary/composable-context/
  rendering-mode conventions a fix must restore.
- ALWAYS fix the root cause with the smallest change confined to the
  files the failure actually touches.
- NEVER add `suppressHydrationWarning`, wrap a component in
  `<ClientOnly>`, or set `ssr: false` on a route as a way to silence a
  hydration mismatch instead of fixing the nondeterministic render.
- NEVER move a `'use client'` directive up to a shared layout/ancestor,
  or hand-import around a broken Nuxt auto-import, just to make the
  build pass without understanding why resolution failed.
- NEVER widen `tsconfig.json`'s `strict`/`moduleResolution` or disable a
  Next.js/Nuxt build check globally to route around one file's error.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll add suppressHydrationWarning here, the mismatch is harmless" | Hides the actual nondeterministic render source instead of fixing it; a "harmless" mismatch today can silently grow |
| "Easiest fix: mark the whole layout 'use client', then the boundary error goes away for sure" | Ships the entire subtree to the client and defeats server rendering for content that never needed it |
| "This composable won't auto-import, I'll just hand-import it from a relative path to unblock the build" | Routes around the actual misconfiguration (wrong directory, missing export) instead of fixing it, and drifts from the project's own auto-import convention |
| "I'll set ssr: false on this Nuxt page, that always clears a hydration error" | Turns off server rendering for the route entirely instead of fixing the one nondeterministic value causing the mismatch |

## Verification

Do not report the fix done until all of the following hold:

- The exact command that reproduced the failure in Step 1 now exits 0
  with no new warnings.
- No `suppressHydrationWarning`, `<ClientOnly>`/`ssr: false` used as a
  blanket workaround, or widened `tsconfig.json` setting was added.
- A `'use client'` directive, if added, sits on the smallest component
  that needs it, not a shared ancestor.
- The report states the actual root cause (which import/call needed
  client/setup context, or which directory/export was wrong), not just
  "fixed the build".
