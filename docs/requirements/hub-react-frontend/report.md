# React frontend verification report

Status: implemented, independently verified and deployed to the geekom test prototype; public SSO and bilingual browser smoke passed. Final Hub handoff is being recorded; owner acceptance remains pending.

## Frozen contract

Flow: `a13d1ce5-720c-444e-b2d0-2b6ee320a77e`. Specification digest: `36466dff01cee8503cfe6f3d76e4aec14d970729fe3bf281248352835e85179a`. All twelve criteria and the linked specification remain unchanged.

## Stack and build

React/React DOM 19.3.1; TanStack React Query 5.105.0; Zustand 5.0.16; i18next 26.5.11; react-i18next 17.1.9. Tailwind/Vite development versions and the full resolved graph are pinned in the isolated application package and bun.lock. No root dependency declaration or shared root node_modules target was changed.

Frontend source: `apps/hub-web`. The legacy embedded application was replaced with a thin facade and deterministic generated assets. Input digest: `5c9bed9f39ec4e7cbf36532fea0e8c07b38872fdf334dd616401b18c3884ebce`. Assets run without installing frontend dependencies in the Hub runtime.

## Independent final gate

| Check | Result | Raw log under .metaproject/data/gdctx/raw/ |
|---|---|---|
| React behavior tests | 56 passed, 9 files | 2026-10-26T10-41-25-313Z-ee217c_run.log |
| Frontend TypeScript | PASS | 2026-10-26T10-41-25-989Z-8519e0_run.log |
| Frontend ESLint | PASS | 2026-10-26T10-41-26-192Z-b5d6c0_run.log |
| Root TypeScript | PASS | 2026-10-26T10-41-54-601Z-399aea_run.log |
| Changed root ESLint/TypeScript health | PASS, zero findings | 2026-10-26T10-42-16-817Z-0fe7df_run.log |
| Hub API/assets/connector/delivery tests | 50 passed, 473 assertions | 2026-10-26T10-41-35-130Z-0cea9b_run.log |
| Asset freshness | PASS | 2026-10-26T10-41-30-495Z-fa5dc3_run.log |
| Root build | PASS | 2026-10-26T10-41-30-770Z-826557_run.log |
| Real-process smoke | PASS | 2026-10-26T10-42-15-939Z-95c0f9_run.log |
| Documentation links | PASS | 2026-10-26T10-41-30-823Z-8f5f3b_run.log |

Independent security/correctness review approved the final implementation. A subsequent accessibility/metadata-label recheck passed 23 focused tests; evidence logs are `2026-10-26T10-40-44-510Z-5959a2_run.log` and freshness `2026-10-26T10-40-44-159Z-55c5e8_run.log`.

Optional oxlint, dependency audit, Sonar and madge checks were not run; no coverage is claimed for them. Earlier RED regressions and transient failures were used to fix real issues and were followed by the final green runs.

## Browser verification

See [execution journal](implementation.md) for disposable-project browser checks. They used the actual React bundle and actual loopback Hub API, not mocked network calls. Public Cloudflare SSO and actual Linux deployment verification are recorded after activation.

## Compatibility decisions

`GET /projects/:p/revisions?summary=1` returns metadata plus fileCount without files/base64. The default list and single-revision full-tree responses remain compatible. All existing human-only gates, exact-digest checks, idempotency, agent API and review-bundle restrictions remain server-owned. No pending Flow-model enhancement was folded into this frontend migration.

Flow attempt is represented by a review-bundle Code Revision, because the full repository exceeds the prototype snapshot quota. Evidence remains explicitly self-reported, including separate-agent review; it is not trusted CI or owner acceptance. No real project integration line or Git publication is part of these checks.

Routing: graph_used (affected and refreshed build); wiki_used (index, no Hub frontend page); memory_used (no matching entry); ctx_used (read/search/run); raw_rg_used: no.

## Deployed candidate and recovery

Runtime source commit: `0aed6a7da8b0eef48dc3752e0d15fedda559b956`. Physical release: `0aed6a7da8b0-react`. Archive SHA256: `07b111775e708063239e6f31e461e0bb50989ecd15d284ee3279f7fb3ca590b9`. The later report-only commit does not alter the deployed frontend input digest or runtime code.

The consistent database backup is `/home/<user>/keryx-team-hub/backups/react-20261026T104741Z/hub.sqlite`; quick_check returned ok. Previous release `2beda1151628-sso` and its configuration/wrapper were retained for rollback without restoring an older database. No data volume, Access policy, DNS record, tunnel credential, other application or system cloudflared service was changed.

In the actual Linux candidate image (Bun 1.3.14), with no network and a read-only mounted committed source archive:

- All 50 Hub tests /473 assertions passed. Raw log: `2026-10-26T10-48-55-446Z-6b4361_run.log`.
- Frontend freshness passed without any frontend node_modules. Raw log: `2026-10-26T10-49-19-674Z-71d130_run.log`.

After activation, local health returned 200, SSO remained enabled, missing/forged JWT exchange returned 401, cross-origin exchange returned 403, invalid/empty Bearer requests returned 401, and anonymous public requests redirected to Access. All seven live asset responses matched the committed source bytes and MIME types, with restrictive CSP preserved. Revision summaries omitted code bytes and retained file counts; the real project integration line remained unset/version zero.

The actual public browser entered through existing Cloudflare authentication without a second Hub token and displayed the verified owner email/operator role. RU and EN rendered the real Keryx project and existing Flow/approval history; user-authored names, content and technical IDs remained unchanged. At 375px the public document clientWidth and scrollWidth were both 375px. Desktop was checked at 1280px. No browser console errors or warnings were observed.

Public browser checks read real project data; mutating browser lifecycle checks used an isolated disposable loopback project, not real approvals or Git publication. Live Cloudflare logout was not invoked because it would terminate the shared Access session across applications; automated React and HTTP logout cases passed.

## Authentication provenance correction

The provided Mac KERYX_HUB_TOKEN was found to resolve to the shared human:operator principal, rather than the intended agent principal. Earlier read-probe labels were corrected accordingly. Final candidate/Evidence upload and submission use the dedicated agent credential already inherited by the running Hub container and verify agent:connector before mutations. No credentials file is opened, no token value is printed, no historical attribution is rewritten and no real Flow acceptance is performed.

The operator credential in the Mac environment should be replaced with the dedicated agent credential for future agent sessions. This is separate from the working browser SSO and does not require weakening any Hub guard.
