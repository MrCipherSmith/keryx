# Keryx Team Hub browser application

React + TypeScript, Tailwind CSS, TanStack Query, Zustand and i18next. The RU/EN message catalogs are local build inputs. No runtime CDN or remote font is needed.

## Install and develop

This package has its own lockfile and node_modules. Do not install its dependencies into the repository's shared root node_modules symlink. The frontend toolchain was verified with Node 24 and Bun 1.4.2; the bundled server runtime is verified separately with Bun 1.3.14.

```sh
bun install --cwd apps/hub-web --frozen-lockfile
bun run --cwd apps/hub-web dev
```

For development only, run a local non-SSO Hub with `KERYX_HUB_PUBLIC_ORIGIN=http://127.0.0.1:5173`; the Vite proxy targets `http://127.0.0.1:8787` by default. `HUB_DEV_ORIGIN` can choose another local backend. Preserve the browser Origin through the proxy; do not rewrite it or disable CSRF to make development work. Bootstrap token values belong in the developer's environment, not source control. The Vite dev server binds loopback only. Do not disable the deployed Access policy for development.

## Verify and build

```sh
bun run check:hub-web
bun run build:hub-web
bun scripts/build-hub-web.ts --check
```

When changing production inputs, build before the freshness check. `check:hub-web` runs this package's TypeScript, ESLint and Vitest checks and then checks the embedded artifact. Tests use the `.case.ts` / `.case.tsx` suffix so root Bun tests do not execute them without the app DOM runner.

The build embeds exact generated HTML, hashed JavaScript/CSS chunks and favicon in `src/hub/web-assets.generated.ts`. Keep that generated module with its source change. `web.ts` is only a facade. No frontend dependency installation is required to run an extracted server archive, standalone binary or the runtime Docker image. The source package includes frontend inputs and lockfile for regeneration.

`--check` verifies a deterministic source/configuration/lockfile digest and asset content digests. Root build and source packaging refuse stale assets. Runtime assets use exact allowlisted paths; query parameters implement reloadable navigation without a server catch-all route. Production builds contain no source maps or data-URL assets and retain the existing CSP.

## State and authentication

- TanStack Query owns server payloads. Keys include authenticated session scope and project/entity identifiers.
- Zustand holds in-memory drafts only. Dirty drafts retain their original base version; query refresh does not rebase them.
- Only non-sensitive RU/EN and appearance preferences are persisted, under `keryx.hub.locale` and `keryx.hub.theme`; private data and credentials are never written to browser storage.
- 401 and revoked-role 403 clear identity, drafts, operation keys and query cache. Ordinary permission denial preserves the valid identity.
- Mutation retries are explicit. An identical uncertain operation retains its idempotency key; capacity fails closed rather than evicting unresolved keys.
- Cloudflare bootstrap occurs once per attempt; failures require explicit retry. SSO-disabled deployments retain token login. Legacy shared-token principals are labeled as shared token access rather than verified personal profiles.

## Workspace presentation

Global Machines and Flows views keep authorized project ownership. Machine cards aggregate paginated session reads; a plus sign marks incomplete session counts. Flow context is the active run association, never an assumed permanent session property. Criterion counts and human acceptance are shown separately; per-criterion evidence coverage is not available in the current API.

Light/dark/system themes share semantic tokens; theme changes do not alter private caches, drafts or authority. Global remote views subscribe to each authorized project, reconcile on connection, and retain scoped invalidation/coalescing. Project Flow views keep list and board layouts.
