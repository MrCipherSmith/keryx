---
name: nextjs-nuxt-implementation
description: "Use when implementing a new page, route, or data-fetching feature in a Next.js App Router or Nuxt 3+ project: choosing Server vs. Client Components ('use client' placement), a Nuxt composable/page fetching data with useFetch/useAsyncData, a Server Action ('use server') or Nuxt server/api route, or a route's rendering mode (static/ISR/revalidate vs. Nuxt's ssr/routeRules). Not for plain React component logic with no meta-framework routing/data concern (use react-implementation), plain Vue SFC logic outside Nuxt's routing/server layer (use vue-implementation), or fixing an existing build/type error (use nextjs-nuxt-build-fix)."
triggers:
  - "add a new page to this Next.js app router project"
  - "should this be a server component or a client component"
  - "fetch this data with useFetch in my Nuxt page"
  - "write a Next.js server action for this form"
  - "add a Nuxt server API route under server/api"
  - "set up ISR revalidation for this Next.js route"
  - "this Nuxt composable needs to hit the API on page load"
  - "configure routeRules for this Nuxt route to prerender it"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Next.js / Nuxt implementation

Implement a new page, route, or data-fetching feature in a Next.js App
Router or Nuxt 3+ project. Covers both frameworks: use the Next.js
sections for `app/`-directory work, the Nuxt sections for `pages/`/
`server/` work, and the shared sections for the routing/rendering/
data-fetching decisions that apply to either. See `rules/patterns.mdc` for
the underlying idiom and `rules/coding-style.mdc` for naming/typing.

## Workflow

### Step 1: Identify the framework and the project's own conventions

- Detect which meta-framework the project uses (`next.config.*` +
  `app/` directory, vs. `nuxt.config.ts` + `pages/`/`server/`) — a
  monorepo may have both in different packages, so confirm which package
  you are actually working in before writing anything.
- Read the nearest existing page/route/composable of the same kind
  (another `page.tsx`, another `server/api/*.ts`, another composable) for
  the project's own patterns: how it fetches data, where it puts types,
  what error-handling shape it uses. Match that shape rather than
  inventing a new one.

### Step 2: Choose the Server/Client boundary (Next.js) or composable context (Nuxt)

- Next.js: default to a Server Component (no directive). Add
  `'use client'` only on the smallest leaf that needs `useState`,
  `useEffect`, a browser API, or an event handler — never on a shared
  layout or an ancestor of that leaf.
- Nuxt: call composables (`useFetch`, `useRoute`, a custom `useX`)
  synchronously at the top level of `<script setup>`, a plugin, or
  middleware — not inside an async callback or after an `await`, since
  Nuxt resolves their injection context synchronously at call time.

### Step 3: Fetch data where the framework already renders

- Next.js: fetch inside the Server Component with `fetch()` (deduplicated
  and cached per render pass) or the project's server-side data layer;
  pass the result down as serializable props to any Client Component that
  needs it. Do not re-fetch the same data client-side after mount unless
  the requirement is genuinely post-interaction (a search box, a
  paginated "load more").
- Nuxt: use `useFetch`/`useAsyncData` with an explicit, stable key for any
  data the page needs during SSR — they dedupe across server and client
  and hydrate without a second request. Reserve a plain `$fetch` call
  inside `onMounted`/an event handler for genuinely client-only,
  post-interaction calls.

### Step 4: Choose the rendering mode deliberately

- Next.js: leave the route static (default) unless it reads
  `cookies()`/`headers()`/`searchParams` or needs fresh data every
  request. When data can tolerate staleness, set
  `export const revalidate = <seconds>` for ISR instead of forcing full
  dynamic rendering.
- Nuxt: set per-route behavior in `nuxt.config.ts`'s `routeRules` (`isr`,
  `prerender`, or `ssr: false` for one route) rather than flipping the
  app-wide `ssr` flag for a need that is local to one route.

### Step 5: Write the mutation path (Server Action / server route)

- Next.js: a Server Action (`'use server'`, file-level or inline) is
  called from a form's `action` prop or a Client Component's handler.
  After the mutation, call `revalidatePath()`/`revalidateTag()` for the
  routes that show the changed data, so the same request cycle serves
  fresh data — don't hand-roll a client refetch when revalidate already
  covers it.
- Nuxt: a `server/api/*.ts` handler reads the request via `defineEventHandler`,
  validates/authorizes inside the handler itself (it is a public HTTP
  endpoint), and returns the result; call it from the page via
  `useFetch`/`$fetch`, not by importing server-only code into a component.
- Both: re-validate every input inside the action/handler server-side —
  client-side form validation is UX, not a trust boundary. See
  `rules/security.mdc`.

### Step 6: Verify

Run the commands in Verification below before reporting the feature done.

## Rules

- Follow `rules/patterns.mdc` for the Server/Client boundary, rendering
  mode, and data-fetching idiom.
- Follow `rules/security.mdc` for env-var scoping and Server
  Action/server-route auth.
- Follow `rules/coding-style.mdc` for naming, typing, and Nuxt
  auto-import conventions.
- ALWAYS keep server-only code (secrets, DB clients, `'use server'`
  files, `server/api/**`) out of any import chain a Client Component or
  browser bundle can reach.
- NEVER widen a `'use client'` boundary or flip a route/page to `ssr:
  false` just to make an implementation easier — fix the actual
  server/client data flow instead.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just mark the whole page 'use client', then I don't have to think about the boundary" | Ships the entire subtree's JS to the browser and loses server rendering for content that never needed it; isolate the directive to the interactive leaf |
| "I'll call useFetch inside this onMounted callback so it definitely has the DOM ready" | Nuxt composables need synchronous setup-time invocation to resolve their context; moving it into an async callback breaks that, not fixes it |
| "I'll just refetch client-side after the Server Action instead of figuring out revalidatePath" | Server Actions + revalidate already deliver fresh data in one round trip; a manual refetch is an unnecessary second request and a source of stale-UI bugs |
| "The client already validates the form, so the server action doesn't need to check again" | A Server Action/server route is a directly reachable HTTP endpoint; client validation is UX only |

## Verification

Do not report the feature done until:

- The project's type-check passes (`tsc --noEmit`, or `nuxi typecheck`).
- `next build` or `nuxi build` completes without new warnings about a
  missing `'use client'` boundary, an invalid composable call, or an
  unresolved auto-import.
- Every new Server Action/server route validates and authorizes its own
  input, independent of client-side checks.
- No secret was exposed by an incorrect `NEXT_PUBLIC_`/`runtimeConfig`
  placement (`rules/security.mdc`).
