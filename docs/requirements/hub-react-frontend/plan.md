# React frontend implementation plan

Status: proposed; awaiting owner freeze in Hub before implementation.

## Decisions

1. Replace the browser UI, preserving the current backend wire contract and approval model.
2. React + TypeScript, Tailwind CSS, TanStack Query, Zustand, i18next/react-i18next and Vite. No Ant Design initially.
3. Isolate frontend dependencies and lockfile under `apps/hub-web`; do not modify the shared root node_modules target.
4. Server state belongs to TanStack Query; Zustand stores small UI preferences/selections only. Private drafts and query payloads stay in memory.
5. Retain Russian/English message catalogs, use Russian fallback, and never translate user content or technical values.
6. Embed Vite build assets behind a thin `web.ts` facade for source, compiled CLI and Docker compatibility. Record a frontend input digest and verify generated asset freshness; no runtime CDN or arbitrary filesystem serving.
7. Use the existing real keryx Hub project and a new specification-linked Flow. Freeze and final acceptance remain owner actions. Agent submission and Evidence use the dedicated agent token.
8. Use a non-deliverable review-bundle Code Revision for the candidate if the full repository exceeds snapshot quota; no fake complete snapshot.

## Waves and dependencies

| Wave | Deliverable | Verification |
|---|---|---|
| P0 | Current behavior inventory, architecture, specification, proposed criteria, Hub Flow | API/field parity and owner freeze |
| W1 | Isolated package/build, typed API layer, query policies, authentication, i18n, shared components and shell | Typecheck, lint, auth/cache/idempotency tests, asset build |
| W2A | Projects/overview, Flow board/detail/forms/Evidence/actions | Existing lifecycle and human-only boundaries; draft preservation |
| W2B | Document explorer/import and proposal diff/review | Required provenance, safe rendering, exact digest/version and 409 |
| W2C | Revision inspector/forms, delivery and history | Bundle guards, actual receipts/conflicts and cursor pagination |
| W3 | Compose frontend, RU/EN completeness, responsive and accessibility pass | Integrated frontend tests and real browser checks |
| W4 | Independent logic/security/parity review and fixes | Reproduction tests for findings, full relevant green checks |
| W5 | Committed release, geekom backup/candidate build/deployment and smoke | Same-origin SSO, real API data, both locales, recovery/rollback |
| W6 | Exact candidate upload, immutable Evidence, submit for review | Owner acceptance remains pending |

W2 workers may run in parallel only after W1 publishes stable shared API, query and component contracts. The coordinating agent owns commits and Hub state transitions. Workers have exclusive file ownership and must not alter credentials or unrelated project data.

## State × event matrix

| State | Event | Required behavior |
|---|---|---|
| No Hub session | Open application with valid Access identity | One SSO exchange, then authenticated project view; no second token |
| Authentication denied/expired | Retry or navigate after error | Explicit retry; do not replay a pending mutation automatically |
| Authenticated | 401 or revoked-role 403 | Clear identity, drafts and private caches; cancel/ignore old responses |
| Authenticated | Ordinary permission denial | Show localized error; keep valid identity and unsent draft |
| Project A loading | Switch to project B or Back/Forward | Abort/ignore A response; show B state without A payload |
| Existing data loaded | Refresh | Reload effective role and relevant resources; preserve current unsent draft |
| Dirty form | Locale change/refetch | Preserve entered content; update only application messages/formatting |
| Dirty form | 409 stale version | Keep draft and show reload/reconcile guidance; no overwrite |
| Mutation pending | Response lost | Show uncertain outcome; retain the operation key for an identical explicit retry |
| Frozen Flow | Edit or approval action | No unsupported edits; server-enforced current versions, subject and human acknowledgment |
| Review bundle | Select/deliver/apply | Visible review-only state; prohibit unsupported operation |
| Any section | Small viewport/long content | Controls remain reachable; board/code overflow stays in its own region |
| Any authenticated state | Sign out | Revoke Hub session, clear private client state, use fixed Access logout path |

## Verification tasks

- Pin installed library versions and verify calls against official documentation.
- Test query keys, AbortSignal, authentication epoch/cache reset, revoked-role handling and ordinary permission errors.
- Test exact request payloads, idempotency keys, conflict drafts, form validation and RU/EN catalog parity.
- Test rendered React behavior; do not preserve obsolete VM tests as if they exercised React.
- Run existing Hub API, SSO, review-bundle, connector and delivery regression suites.
- Build assets and packaged Hub; verify CSP, MIME types and URL navigation after reload.
- Use a separate disposable test project for mutations. Read real keryx data for navigation; do not alter existing proposals, criteria, integration line or acceptance states for smoke tests.
- Check browser console, real SSO, desktop/mobile, language switching, logout boundaries and exact self-reported Evidence acknowledgment.
- Build and run the deployed Linux candidate, verify backup and limited-scope rollback. Retain new review-bundle guards.

## Source references

- React: https://react.dev/learn/build-a-react-app-from-scratch
- Tailwind/Vite: https://tailwindcss.com/docs/installation/using-vite
- TanStack Query cancellation: https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation
- Zustand TypeScript: https://zustand.docs.pmnd.rs/learn/guides/beginner-typescript.html
- react-i18next hooks: https://react.i18next.com/latest/usetranslation-hook

Routing: graph_used (`affected src/hub/web.ts`); wiki_used (index, no Hub frontend page); memory_used (no matching Hub frontend entry); ctx_used (read/search/run); raw_rg_used: no. The graph predates proposed frontend files and will be refreshed after they exist.
