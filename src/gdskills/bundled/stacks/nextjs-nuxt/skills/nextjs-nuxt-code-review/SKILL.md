---
name: nextjs-nuxt-code-review
description: "Use when reviewing a diff that touches Next.js App Router files ('use client'/'use server' directives, Route Handlers, revalidatePath/revalidateTag) or Nuxt files (composables, server/api routes, nuxt.config.ts routeRules/runtimeConfig) for meta-framework-specific risk: a misplaced Server/Client boundary, a composable called outside setup context, a hydration-mismatch-prone render, a rendering-mode choice that doesn't match the data's actual freshness need, or an unauthenticated Server Action/server route. Does not edit code. Not for general React/Vue component review with no App Router/Nuxt-specific concern (use review-frontend or a react/vue pack review skill), and not for NestJS backend review (use review-backend)."
triggers:
  - "review this Next.js server action for auth issues"
  - "check this diff for use client boundary mistakes"
  - "review this Nuxt server/api route"
  - "does this Nuxt composable get called outside setup"
  - "review the rendering mode choice on this Next.js route"
  - "check for hydration mismatch risk in this component"
  - "review this nuxt.config routeRules change"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Next.js / Nuxt code review

Review a diff touching Next.js App Router or Nuxt files for
meta-framework-specific risk. This skill reviews and reports; it does not
edit code. See `rules/patterns.mdc` and `rules/security.mdc` for the full
rationale behind each check below.

## Workflow

### Step 1: Scope the diff by framework

- Identify which files are Next.js (`app/**`, `'use client'`/`'use
  server'` directives, `route.ts` handlers) vs. Nuxt (`pages/**`,
  `composables/**`, `server/api/**`, `nuxt.config.ts`) — apply the
  matching checklist below to each; a monorepo diff may need both.

### Step 2: Check the Server/Client boundary (Next.js)

- Every `'use client'` is on the smallest component that actually needs
  browser state, an event handler, or a browser API — not on a shared
  layout, a page, or an ancestor of the component that needs it.
- No Server Component reads `cookies()`/`headers()` and then passes the
  raw session/auth data down as a prop to a Client Component
  unnecessarily — pass only what the client actually needs to render.
- No server-only import (a DB client, an API key read, a `'use server'`
  file) is reachable from a file that lacks its own server boundary and
  could end up in a Client Component's import chain.

### Step 3: Check composable/context usage (Nuxt)

- Every composable (`useX`) call sits at the synchronous top level of
  `<script setup>`, a plugin, or middleware — not inside an `async`
  callback, after an `await`, or inside `setTimeout`/an event handler
  where Nuxt's injection context is no longer available the same way.
- `runtimeConfig` secrets stay out of the `public` block; a component
  never reads a value from `public` that should have been server-only.

### Step 4: Check rendering-mode and data-freshness fit

- A route/page marked static or ISR (Next's `revalidate`, Nuxt's
  `prerender`/`isr` routeRule) doesn't actually need per-request data
  (auth-gated content, a `searchParams`-dependent result) — that
  combination silently serves stale or wrong data to different users.
- A mutation (Server Action, Nuxt server route) that changes displayed
  data calls `revalidatePath()`/`revalidateTag()` (Next.js) or otherwise
  invalidates the relevant cached data (Nuxt) — a missing revalidate
  leaves the UI showing stale data after a successful write.

### Step 5: Check hydration-mismatch risk

- No component renders `Date.now()`, `Math.random()`, or
  locale/timezone-dependent formatting directly in its render path
  without a client-only guard or a stable server-computed value — flag it
  even if the diff's own tests pass, since a mismatch often only shows up
  as a console warning in a real browser, not in a unit test.

### Step 6: Check Server Action / server route auth

- Every `'use server'` action and `server/api/**` handler checks
  auth/authorization and re-validates its own input inside the
  action/handler — not only relying on a middleware check or the
  client-side form validation that called it. See `rules/security.mdc`.

### Step 7: Report

List each finding with file:line, what's wrong, and the concrete fix
(quote `rules/patterns.mdc`/`rules/security.mdc` by name where relevant).
Do not modify the code under review.

## Rules

- This is a review skill: report findings, do not edit the reviewed
  files.
- Follow `rules/patterns.mdc` for boundary/rendering-mode/data-fetching
  checks and `rules/security.mdc` for auth/env-var checks.
- Flag a missing auth check on a Server Action/server route as a
  correctness-blocking finding, not a style nit.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "'use client' is on the page, but that's fine, it's simpler to review as one unit" | A page-level 'use client' ships the whole subtree to the browser; it is exactly the finding this review exists to catch, not something to wave through for simplicity |
| "The server action's caller already validates the form, so the handler check can be skipped in review" | The handler is a directly reachable endpoint regardless of what called it; flag the missing server-side check |
| "The composable is called inside onMounted, that still runs after setup so it's probably fine" | onMounted callbacks run after Nuxt's synchronous setup-time context resolution window for some composable patterns; flag it for verification rather than assuming it's safe |
| "Date.now() in the render is just a display nicety, not worth flagging" | It is a concrete hydration-mismatch source (server render time vs. client render time differ); flag it regardless of how minor the visual impact looks |

## Verification

Before finishing the review, confirm:

- Every `'use client'`/`'use server'` directive in the diff was checked
  against its actual placement, not assumed correct.
- Every new/changed Nuxt composable call site was checked for
  synchronous setup-context placement.
- Every new/changed Server Action or `server/api/**` handler was checked
  for its own auth/validation, independent of client-side checks.
- The report names file:line for each finding and the concrete fix, not
  just "check the boundary here".
