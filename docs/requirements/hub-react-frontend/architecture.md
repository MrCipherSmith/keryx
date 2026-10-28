# Hub React frontend architecture

Status: implemented architecture. The owner froze the corresponding Hub Flow; implementation and local independent verification are complete. Deployed-runtime verification is recorded separately in report.md.

Hub Flow: `a13d1ce5-720c-444e-b2d0-2b6ee320a77e`, currently `initializing` and awaiting owner freeze when this planning document was written.

## Scope and stack

Replace the current embedded vanilla browser application with a React and TypeScript application. Preserve the current Hub API, Cloudflare SSO, exact-digest and version checks, human approval boundaries, and review-bundle guards. The migration does not implement the separate Flow-model enhancement or introduce a first-class Attempt entity.

Use Tailwind CSS for the design system, TanStack Query for server state, Zustand for small client-only state, and i18next with react-i18next for English and Russian. Use Vite for the production browser build. Ant Design is not needed for the current forms, navigation, boards and detail panels; native form controls and focused reusable React components keep the styling and interaction model consistent.

Select mutually compatible stable versions when the implementation is initialized, verify their APIs against official documentation, and pin the resolved dependency graph in the application lockfile. A package version is not inferred from this planning document.

## Existing constraints verified in source

- `src/hub/server.ts` imports `webAssets` from `src/hub/web.ts`, looks up the exact URL pathname, and currently serves string bodies with explicit Content-Type and a restrictive same-origin Content-Security-Policy.
- The current browser is a literal HTML/JavaScript/CSS asset map in `web.ts`; it has no runtime frontend dependencies.
- `scripts/package-team-hub.ts` allowlists top-level `src/hub/*.ts` inputs and can compile standalone Linux server and client binaries.
- The Docker image copies `src/hub` and `src/flow`, uses Bun 1.3.14, and has no frontend dependency installation step. `deploy/team-hub/Dockerfile.dockerignore` excludes everything except those source directories and omits Hub test files.
- Root TypeScript checks include `src/**/*.ts`, `scripts/**/*.ts`, and `bench/**/*.ts`; a separate application under `apps/` needs its own explicit checks.
- Root `node_modules` is shared through a symlink in this worktree. Frontend installation must not modify that shared dependency tree.

## Repository and module boundaries

```text
apps/hub-web/
  package.json
  bun.lock
  tsconfig.json
  vite.config.ts
  index.html
  public/favicon.svg
  src/
    main.tsx
    app/                 providers, shell, URL selection, authentication
    api/                 typed HTTP client, query keys, query/mutation hooks
    components/          shared controls, panels, status and feedback primitives
    features/            projects, overview, flows, documents, proposals,
                         revisions, delivery, history
    i18n/                initialization and complete en/ru catalogs
    state/               client-only preferences and in-memory drafts
    styles.css
  tests/                 isolated component and interaction tests
scripts/build-hub-web.ts
src/hub/web.ts           thin asset facade, no duplicate legacy application
src/hub/web-assets.generated.ts
```

The frontend owns its package, lockfile, dependencies, TypeScript and test configuration. Root dependencies and shared `node_modules` are not repurposed. Runtime contracts should be imported with type-only imports from the existing canonical Hub contracts where practical; they must not pull server persistence, crypto or delivery code into the browser bundle.

## Build and asset delivery decision

Use generated embedded assets rather than runtime filesystem reads. This is the smallest change that preserves the existing source release and standalone compiled server contracts.

1. Install the isolated application dependencies from its committed lockfile with a frozen install.
2. Run the application's type checks and Vite production build. Tailwind compiles during that build; no CSS or JavaScript is loaded from a CDN.
3. A bounded generator reads only allowlisted regular files under the application's generated `dist/`, rejects unsafe paths and symlinks, and produces a deterministic `src/hub/web-assets.generated.ts` map. It contains the generated index document, local favicon, and hashed JavaScript/CSS chunks with explicit MIME types.
4. Keep `web.ts` as a thin facade over that map. Remove the old application implementation rather than serving two copies of the product.
5. Check in the generated asset module so an extracted source release and the compiled CLI can run without installing browser dependencies. It is a generated distribution input, not a second source of truth. Record a deterministic digest of relevant frontend sources, configuration and lockfile, and provide a freshness check that fails when this artifact no longer corresponds to them.
6. The root build and release workflow explicitly rebuilds/verifies frontend assets before compiling or packaging the server. Deployment packages the exact committed generated artifact and its source provenance. Existing root builds must not silently package stale UI code.

The freshness input list is sorted relative paths plus exact bytes for application production source (`src/**/*.ts`, `src/**/*.tsx`, `src/**/*.css`, including both localization catalogs), `index.html`, regular files under `public/`, `package.json`, the application lockfile, TypeScript/Vite build configuration, and the asset-generator script itself. Exclude `node_modules`, `dist`, generated assets and test-run output. The generator records the input digest and output-file digests; verification recomputes the input digest and rejects missing or mismatched assets. Use a deterministic encoding and omit wall-clock timestamps. A missing asset module must produce a clear build instruction rather than silently serving the legacy UI.

This choice costs a larger generated text file in Git but avoids new runtime asset-directory discovery, filesystem traversal logic, missing adjacent files for compiled binaries, and container-only behavior. A separate runtime `dist/` directory would require coordinated changes to source packaging, compiled-binary embedding and runtime path resolution; it is not the recommended MVP path.

The current source packager's `*.ts` allowlist already includes the generated module. Extend source/release provenance to include the frontend source and lockfile, or include a separately named reproducible frontend source archive. Do not claim the existing minimal server archive alone is sufficient to regenerate React assets.

HTML must remain `no-store`. Hashed, immutable public code assets may use long-lived immutable caching if the asset contract explicitly carries that policy; otherwise retaining `no-store` is safe. JSON API responses remain `no-store`. Use exact asset lookup rather than arbitrary filesystem access or an unrestricted SPA fallback.

Keep the current CSP: external same-origin scripts and styles, no inline scripts, `eval`, remote fonts, runtime CDN assets or unsanitized inline HTML. Ensure production output respects that CSP; development-only tooling does not determine production policy. JavaScript, CSS and SVG MIME types are verified by HTTP smoke checks.

Set Vite asset inlining to zero so icons and other assets do not become data URLs blocked by the current CSP. Tailwind emits a local external CSS file. Components use stylesheet classes rather than injected `<style>` elements or React `style` attributes that would require weakening `style-src`. Production Vite HTML references local hashed module/CSS files. Disable production source maps unless deliberately included and reviewed; no source-map URL should point at a development server. Verify a real browser has no CSP violations, including when navigating to lazy-loaded views.

## URL navigation

For this migration use typed query-parameter routes on the existing root pathname, for example `/?project=<id>&view=flows&flow=<id>`. Support project, section and selected document/Flow/revision identifiers, with Back/Forward behavior and validation of supported section names. Query parameters select UI context; they confer no authority.

This preserves reloadable/shareable navigation without adding server catch-all routes. An invalid or no-longer-available selection shows a localized missing-item state and a safe return action. It must not silently open an item from another project. Navigation must warn about leaving a dirty form or preserve the draft for that same identity/project/entity, following the specified draft rules.

## Server state and HTTP boundary

TanStack Query is the only cache for server-owned projects, documents, proposals, Flows, Evidence, revisions, delivery and events. Zustand must not duplicate those entities as another persistent server cache.

All project queries include the project ID; detail and Evidence queries additionally include the relevant entity ID. Cache scope also includes a session generation or belongs to a fresh QueryClient per authenticated session. Query functions consume the supplied AbortSignal and pass it to `fetch`. A late response from a previous project or identity cannot update the new view.

The HTTP client uses same-origin cookies and `X-Requested-With: XMLHttpRequest`. It parses the existing `{error:{code,message}}` contract and exposes typed status/code information. Non-JSON responses from an expired Access session become a localized authentication/network failure rather than a JSON parse error or an HTML injection.

GET retries are bounded and exclude authentication, authorization, validation and not-found failures. Mutation retries are disabled by default. Each user operation owns one stable Idempotency-Key for an identical payload; an explicit retry after an ambiguous transport failure reuses that key, while an edited payload gets a new operation identity. Do not automatically replay mutations after SSO refresh, project changes or locale changes.

Mutation success invalidates only affected query families. Sensitive state changes, exact-digest reviews and Flow acceptance wait for the server result; do not optimistically present them as approved. Version-conflict responses keep the user's draft intact and present current canonical state separately. Refreshing query data must not overwrite dirty controlled form inputs.

## Authentication and privacy

Preserve the verified SSO sequence: existing session check, public mode flag if needed, one Cloudflare exchange, then project queries. Failed exchange waits for an explicit retry instead of looping. Preserve non-SSO token login only where the existing server supports it. In SSO mode describe local Bearer recovery rather than offering an incompatible browser token form.

On authenticated `401` or `403 access-denied`, increment the session generation immediately, cancel in-flight private requests, clear QueryClient queries and mutations, clear private drafts/selection, and render the localized sign-in/denied state. An unrelated `403 human-required` or `origin-denied` does not erase a valid identity. Logout clears client state after server revocation and validates the fixed same-origin Access logout destination before navigating. No tokens, JWTs, private entities or drafts are persisted in localStorage, sessionStorage or IndexedDB.

Refresh first obtains the current principal, so a changed effective role appears in the shell. Actual authorization remains server-owned; hidden or disabled buttons are an additional usability guard, not an authorization mechanism.

## Client state and localization

Zustand stores client-only UI choices and in-memory drafts, scoped to the active session/project/entity. Local component state holds transient form interaction where cross-screen ownership is unnecessary. Only the language preference is persisted, under a documented key with allowed values `en` and `ru`; storage failures must not prevent startup.

Select the initial language from the saved allowed preference, otherwise use Russian as the product fallback. The owner can explicitly switch to English. Set the document language and use locale-aware date/number formatting. Switching language updates navigation, labels, descriptions, actions, validation, empty/loading/error states, accessibility labels and status labels without losing the current selection or draft. RU/EN catalogs must have matching keys and no untranslated visible application labels.

Do not translate user-authored specifications, wiki Markdown, acceptance criteria, paths, IDs, digests, code, check commands, raw technical output or audit identity. Map known API error codes to localized user-facing explanations; retain the technical code/details for inspection. Keep wire enum values unchanged and localize their display labels.

## State and event matrix

| State | Navigation/project switch | Refresh or retry | Authentication/permission event | Locale change |
|---|---|---|---|---|
| Initial auth loading | Project queries disabled; no prior private data shown | No concurrent bootstrap; explicit retry after failure | Valid SSO enters one new cache scope; denial stays visible | Loading and retry copy updates |
| Project data loading | Cancel old work; show new project's loading state | Bounded GET retry; no mutation replay | Invalidate scope and clear private data on auth loss | Loading labels update |
| Loaded | Show only selected project's cached data; fetch missing detail | Keep existing data while refetching; obtain current principal first | Role change updates shell; revoked mapping clears private state | Selection and data remain; labels/formatting update |
| Dirty form | Preserve its scoped draft or warn before discarding | Canonical updates do not replace dirty inputs | Auth loss clears private drafts and operations | Draft survives unchanged |
| Mutation submitting | Disable duplicate operation; do not submit into new project context | No automatic retry; explicit same-payload retry keeps operation key | Abort presentation of stale results; never replay after login | Labels update; operation payload remains unchanged |
| Stale-version conflict | Draft remains scoped to original item | Fetch canonical state separately; explicit reconcile/retry | Server decides permissions for each request | Conflict explanation updates; both versions remain intact |
| First load failed | Error does not follow to another project | Explicit retry; no empty-success disguise | Distinguish auth loss from ordinary permission failure | Error/retry copy updates |
| Refresh failed with loaded data | Error remains scoped to its resource | Preserve last loaded content and show refresh failure | Auth loss removes private content rather than retaining a stale authorized view | Error labels update |
| Missing entity | Safe localized missing-item view | Return to list or explicit refresh | No cross-project fallback | Explanation updates |
| Signed out | No private content or pending operations | Explicit sign-in/bootstrap retry only | No authenticated fallback or role inference | Language preference remains |

## Verification and integration tasks

1. Pin the isolated dependency graph; verify no root/shared dependency changes. Check app TypeScript, lint, locale-key parity and production build.
2. Test real React interactions with a dedicated component runner and DOM environment. Account explicitly for root `bun test` discovery: do not add Vitest-only `*.test.tsx` files that the root Bun runner then attempts to execute without the app environment. A custom app-only test suffix and explicit Vitest include configuration is one contained option; document and invoke its command in quality gates.
3. Port current SSO browser behavior coverage to the React application. Do not delete that regression protection merely because the old VM fixture cannot execute a module bundle. Keep server-side auth and human-only tests unchanged.
4. Cover session/project switches with late responses, 401 and revoked-role 403 cache clearing, ordinary 403 identity preservation, duplicate clicks, ambiguous transport retries, stale 409 drafts, locale switching, unknown/missing entities, and review-bundle action guards.
5. Verify exact asset paths/MIME/CSP, generated-asset freshness, extracted source release, standalone compiled server, and Docker image with no runtime frontend installation or external browser requests.
6. Run desktop and mobile browser journeys in both languages. At narrow widths avoid page-wide overflow; Flow lanes may have a deliberate local horizontal scroller. Verify keyboard focus, labels, dialog dismissal and actionable inline errors.
7. Attach build, component/server tests, independent review and deployed browser checks as immutable self-reported Evidence to the exact review-only Hub candidate. The owner performs final acceptance.

## Official references consulted

- [Vite static asset handling](https://vite.dev/guide/assets): build graph, hashed assets and asset inlining.
- [Vite build options source](https://github.com/vitejs/vite/blob/main/docs/config/build-options.md): production manifest generation and output configuration.
- [TanStack Query QueryClient](https://tanstack.com/query/latest/docs/framework/react/reference/QueryClient): cancellation, invalidation and cache clearing.
- [TanStack Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation): passing the supplied AbortSignal to requests.
- [Zustand create](https://zustand.docs.pmnd.rs/reference/apis/create): a typed client state store.
- [react-i18next hooks](https://react.i18next.com/latest/using-with-hooks): initialization and React translation hooks.
- [Tailwind with Vite](https://tailwindcss.com/docs/installation/using-vite): local build integration.

Routing audit: graph_used (`affected src/hub/web.ts`, graph predates this planning document); wiki_used (index; no Hub-specific page); ctx_used (read/outline); raw_rg_used: no.
