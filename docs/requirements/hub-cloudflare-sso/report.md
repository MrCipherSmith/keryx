# Cloudflare SSO verification report

Status: implementation verified, deployed to the private geekom test prototype, and browser SSO smoke passed. Independent review: APPROVE. Human Flow acceptance remains reserved for the owner.

## Frozen contract

Flow `ddb407dd-48c0-4271-8d02-e1ed9c0428e2`, specification digest `ab33d6f017772206def6d5b80d357f86621e5e9a71b1fe5d65c32998d64782f3`. See [specification](specification.md) and [plan](plan.md).

## Browser implementation

The shipped `/app.js` is executed in a VM with a bounded browser DOM/fetch fixture. Tests verify actual request sequences and user-visible states rather than checking only source strings.

Command: `bun test src/hub/web.sso.test.ts`.

Initial RED: 6 failures and 1 existing-compatible behavior passed before SSO code. Review-bundle guard added with its own failing regression test before implementation.

Initial browser result: 8 tests passed, 0 failed, 38 assertions. See the final combined results below for the reviewed candidate.

Covered scenarios:

1. Existing session missing → configuration read → exactly one SSO bootstrap → project load and verified email/role.
2. Disabled SSO retains human token login.
3. Denied identity stays visible; explicit retry can succeed after configuration changes.
4. Request-time session expiration clears identity without automatic SSO or operation replay.
5. Logout clears identity and navigates to the fixed Access logout endpoint.
6. External or query-bearing logout destinations are rejected after clearing the Hub session.
7. Configuration network failure does not show an unverified fallback mode; explicit retry can recover.
8. Review bundles remain visible but cannot be selected for integration or used as a complete-snapshot base.

These are client behavior tests, not a claim that a live Cloudflare browser login or server deployment has been performed. Backend, combined quality gates, independent security review and deployment smoke results must be appended by the coordinating agent when actually completed.

AJAX requests send `X-Requested-With: XMLHttpRequest`; the client request-sequence test verifies the header on all authentication and project requests.

## Independent verification of the reviewed candidate

- Combined Hub suite: `bun test src/hub/` — 57 passed, 0 failed, 453 assertions.
- Changed-scope ESLint and TypeScript health: PASS, zero findings.
- Scripts typecheck, application build, isolated real-process HTTP smoke: PASS.
- Documentation links: 1,882 checked, 606 files, zero broken.
- Independent security/correctness review: APPROVE; focused rerun 39 tests / 258 assertions passed.
- Circular-import tool was not configured; no circular-import check is claimed.

The first verification run observed a temporary connector-test type error while a worker was editing it. The corrected method call was checked again; the final health run passed.

Review found and fixed revoked-role browser state retaining the old identity/cache, and role changes not updating the visible role on Refresh. Regression tests exercise both. SSO mode now describes local Bearer API recovery rather than offering an incompatible browser token form.

Raw local evidence references (not trusted CI):

- `.metaproject/data/gdctx/raw/2026-10-25T19-49-12-140Z-12c083_run.log` — combined tests.
- `.metaproject/data/gdctx/raw/2026-10-25T19-49-15-623Z-a6fe39_run.log` — final health.
- `.metaproject/data/gdctx/raw/2026-10-25T19-49-14-364Z-10ed07_run.log` — independent review tests.

## Owner decisions for this attempt

The owner authorized using Code Revision as the prototype's attempt representation, with immutable Evidence attached to that revision. No first-class Attempt entity is claimed. The Keryx tree exceeds the prototype snapshot quota, so this attempt uses an explicitly marked `review-bundle` containing the patch, changed files, and Git base reference. It is not a complete checkout. Server and connector guards prohibit selecting, delivering, or applying it as a snapshot. Existing snapshot behavior is preserved.

Frozen specification content and criteria were not changed. No owner acceptance, project line selection, Git publication, or PR is authorized by this report.

Routing: graph_used (`affected`, refreshed build); wiki_used (index, no Hub-specific coverage); memory_used (search, no relevant Hub entry); ctx_used (read/search/run); raw_rg_used: no.

## Geekom deployment and live smoke

Deployed source commit: `2beda11516283e9c70519babfa6e17025085fbff`. Release: `2beda1151628-sso`. The later report-only commit does not change the deployed runtime.

Source archive SHA256: `f4c3b71c77711279d7d868dbcf24e1e08b5b6d1863b728a28045b010f1b23728`. The archive was generated directly from the committed runtime inputs, excluding unrelated dirty generated Metaproject files.

The candidate was built on geekom before activation. In its actual Bun 1.3.14 Linux image, with an isolated temporary filesystem and no network, all 57 Hub tests / 453 assertions passed. Test sources were mounted read-only because the runtime image intentionally excludes tests. Raw local capture: `.metaproject/data/gdctx/raw/2026-10-25T19-53-49-458Z-6a1dee_run.log`.

A consistent SQLite snapshot was made through SQLite VACUUM INTO and copied through docker exec (docker cp could not see the tmpfs file). The backup is at `/home/<user>/keryx-team-hub/backups/sso-20261025T195235Z/hub.sqlite`; its quick_check returned `ok`. No data volume was removed. Existing services outside the prototype were not restarted.

After activation:

- Local health: 200; SSO mode enabled.
- Missing and forged Access JWT exchange: 401.
- Cross-origin SSO exchange: 403.
- Invalid and empty Authorization with accompanying cookies: 401, no identity fallback.
- Agent token GET of the real Flow: 200, original specification digest preserved.
- Anonymous public request: 302 to the configured Cloudflare Access team.
- Existing in-app browser Access authentication entered Hub automatically without a Hub token prompt; the visible identity was the configured owner email and operator role. No JWT or session cookie was extracted from browser storage.

Live evidence capture: `/tmp/keryx-sso-runtime-checks.json`; browser proof: `/tmp/keryx-hub-sso-working.png`. These are local capture paths; the summarized results are also attached to the Hub candidate as self-reported Evidence.

Logout, role revocation/downgrade, key rotation and persistence were covered by automated HTTP and browser-behavior tests, including the Linux image run. A live Cloudflare logout was not performed because it would end the owner's shared Access session across applications. No claim of a live logout test is made.

Rollback must retain the new review-bundle guards. Disable SSO on the new runtime if needed; do not downgrade to the old binary after storing a bundle. See [deployment preparation](deployment-preparation.md).
