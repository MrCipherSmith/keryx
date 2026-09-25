---
name: nextjs-nuxt-upgrade-migration
description: "Use when migrating a Next.js project from the Pages Router to the App Router, upgrading a Next.js major version, or migrating a Nuxt 2 project to Nuxt 3+ (Options API to Composition API, the Vuex-to-Pinia move, module/plugin API changes). Covers rewriting data-fetching (getServerSideProps/getStaticProps to Server Components and route rendering config; asyncData/fetch to useAsyncData/useFetch), routing conventions, and rendering-mode equivalents between the old and new APIs. Not for a same-version bug fix or new feature (use nextjs-nuxt-implementation/nextjs-nuxt-build-fix), and not for a plain React/Vue version bump with no meta-framework routing change (use react-upgrade-migration or the vue pack's migration skill)."
triggers:
  - "migrate this Next.js app from pages router to app router"
  - "upgrade this Next.js project to the latest major version"
  - "migrate this Nuxt 2 project to Nuxt 3"
  - "convert getServerSideProps to the app router equivalent"
  - "move this Nuxt 2 asyncData to useAsyncData"
  - "migrate Vuex store to Pinia in this Nuxt project"
  - "replace this Options API component with script setup during the Nuxt 3 migration"
metadata:
  origin: authored
  category: migrate
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Next.js / Nuxt upgrade & migration

Migrate a Next.js project between the Pages Router and App Router (or
between major versions), or a Nuxt 2 project to Nuxt 3+. Covers rewriting
the old data-fetching/rendering APIs to their current equivalents. See
`rules/patterns.mdc` for the target-state idiom this migration moves
toward.

## Workflow

### Step 1: Establish the current and target state

- Confirm the exact starting point (Next.js Pages Router version, or Nuxt
  2 with which major module versions) and the target (App Router on
  which Next.js version, or Nuxt 3/4) — the concrete API mapping differs
  by version, so check the project's `package.json` before assuming a
  mapping.
- Migrate route-by-route or module-by-module, not the whole app in one
  pass — both frameworks support the old and new router/API coexisting
  during a transition (Next.js: `pages/` and `app/` side by side; Nuxt:
  incremental Nuxt Bridge or a full-rewrite branch per module), so land
  working, tested increments.

### Step 2: Migrate Next.js data-fetching and routing (Pages Router -> App Router)

- `getServerSideProps`/`getStaticProps` in a page -> fetch directly in
  the now-Server Component (`app/.../page.tsx`); the per-request vs.
  static choice becomes the route's default (dynamic) vs. `export const
  revalidate = <seconds>` (ISR) rather than a separate exported function.
- `getStaticPaths` -> `generateStaticParams` in the App Router page.
- `_app.tsx`/`_document.tsx` -> `app/layout.tsx` (root layout) plus
  nested `layout.tsx` files per route segment.
- `next/head`'s `<Head>` -> the `metadata` export or `generateMetadata`
  function in `page.tsx`/`layout.tsx`.
- An API route under `pages/api/*.ts` -> a Route Handler under
  `app/api/.../route.ts` exporting named HTTP method functions
  (`GET`/`POST`/etc.) instead of a single default-exported handler.
- Any component using `useState`/`useEffect`/browser APIs needs an
  explicit `'use client'` once moved into `app/` — it was implicitly
  client-rendered before; the App Router defaults to server rendering.

### Step 3: Migrate Nuxt 2 to Nuxt 3+

- Options API components (`export default { data() {...}, methods:
  {...} }`) -> `<script setup lang="ts">` with `ref`/`reactive`/
  `computed`/defined props — rewrite behavior, don't just wrap the old
  object export.
- `asyncData`/`fetch` (Nuxt 2 page hooks) -> `useAsyncData`/`useFetch`
  called in `<script setup>`.
- Vuex store modules -> Pinia stores (`defineStore`) — Nuxt 3 has no
  built-in Vuex integration; a large store migrates incrementally,
  module by module, with both coexisting only as a deliberate bridge
  step, not a long-term end state.
- `nuxt.config.js` module/plugin registration syntax changed
  substantially between Nuxt 2 and 3 — re-check each module's own current
  docs for its Nuxt 3 registration shape rather than assuming the old
  config key still works.
- Middleware (`middleware/*.js` global-by-filename in Nuxt 2) ->
  `defineNuxtRouteMiddleware` in `middleware/`, explicitly referenced per
  page via `definePageMeta({ middleware: [...] })` unless it is global.

### Step 4: Verify each migrated increment

- Run the target framework's build/typecheck after each route/module
  migrates, not only at the end — a broken increment is much cheaper to
  isolate immediately than after the whole app has moved.
- Confirm the migrated route's rendering mode (static/dynamic/ISR, or
  Nuxt's `ssr`/`routeRules`) matches what the original page actually
  needed, not just "still compiles" — a migration can silently flip a
  page from dynamic to accidentally-static or vice versa.

### Step 5: Report

State what moved, the API mapping applied to each piece, and what still
needs a follow-up pass (e.g. remaining Pages Router routes, remaining
Vuex modules) rather than claiming the whole migration complete when only
part landed.

## Rules

- Follow `rules/patterns.mdc` for the target Server/Client boundary,
  rendering-mode, and data-fetching idiom each migrated piece should end
  up in.
- Migrate incrementally with the old and new systems coexisting during
  the transition; never a single unreviewable mass-rewrite commit.
- NEVER leave a migrated component silently missing `'use client'` when
  it uses state/effects/browser APIs — the App Router's default flipped
  from the Pages Router's implicit client rendering.
- NEVER migrate a Vuex module to Pinia by wrapping the old store object
  unchanged inside `defineStore` — rewrite it to Pinia's actual API
  (state/getters/actions as the store's own functions), not a shim.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll migrate the whole pages/ directory to app/ in one commit, faster than route by route" | A single mass-rewrite is unreviewable and all-or-nothing to roll back; migrate and verify route by route instead |
| "This component doesn't obviously use state, I'll skip adding 'use client' and see if the build complains" | The App Router's build error for a missing boundary is not guaranteed to catch every case (e.g. an indirect browser-API use); check explicitly rather than relying on the compiler to catch it |
| "I'll wrap the old Vuex module object inside defineStore so both APIs sort of work" | Produces a store that satisfies neither Vuex's nor Pinia's actual API contract; rewrite to Pinia's state/getters/actions shape |
| "The old getServerSideProps page worked fine, I'll just call it from inside the new Server Component instead of rewriting the fetch" | Keeps a Pages Router API alive inside App Router code instead of completing the actual migration to the framework's current data-fetching model |

## Verification

Do not report a migrated piece done until:

- The target framework's build/typecheck passes for the migrated
  route/module.
- Every migrated component that needs client interactivity has an
  explicit `'use client'` (Next.js) or is confirmed to run correctly
  under Nuxt 3's Composition API context (Nuxt).
- The migrated route's rendering mode matches the original's actual data
  freshness need, checked explicitly, not assumed from "it still
  builds".
- The report names exactly what migrated and what remains, not a blanket
  "migration complete" for a partial pass.
