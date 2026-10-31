# React frontend execution journal

## Authorized contract

- Hub Flow: a13d1ce5-720c-444e-b2d0-2b6ee320a77e.
- Frozen specification digest: 36466dff01cee8503cfe6f3d76e4aec14d970729fe3bf281248352835e85179a.
- The owner explicitly instructed the assistant to freeze the current twelve criteria. Following owner-authorized Cloudflare login, Freeze was performed in the authenticated browser session; Hub recorded the verified Cloudflare principal. No browser credential or JWT was extracted.
- Agent API subsequently performed Start with expected version 2; current Flow is in-progress version 3. Final acceptance remains reserved for the owner.

## Work allocation

| Workstream | Owner | State |
|---|---|---|
| W1 app package, API/query/auth/state/i18n/common UI, build and packaging | react_foundation | implemented and verified |
| W2A projects, overview and Flow workflows | react_workflow_screens | implemented and verified |
| W2B documents, proposals, revisions, delivery, history | react_context_screens | implemented and verified |
| Coordination, Hub attempt/Evidence, commits and deployment | main agent | in progress |

Workers have exclusive file ownership, do not commit or mutate the real Hub, and use the shared apps/hub-web/CONTRACTS.md. Frontend dependencies are isolated; the shared root node_modules target must remain unchanged.

## Pending gates

- Focused React behavior tests including actual SSO and authorization-loss regression coverage.
- RU/EN catalog and responsive/accessibility verification.
- Existing Hub backend/connector/delivery regression suite.
- Frontend and root typecheck/lint/build; generated asset freshness and packaged runtime smoke.
- Independent logic/security/parity review, fixes and final verification.
- Geekom backup, Linux candidate verification, limited-scope deployment, real browser smoke in both languages.
- Exact review-only candidate upload and immutable self-reported Evidence; submit for owner review.

No implementation completion or deployment is claimed by this journal until the corresponding results are recorded.

## Review and verification results

- Independent code/security/parity review: APPROVE after fixes.
- Fixed late navigation after an unmounted/project-switched create operation.
- Added a backward-compatible read-only revision metadata projection to avoid fetching all code bytes for counts and pickers; selected file inspection still uses the full single-revision endpoint.
- Fixed all eight mutation forms to clear only the submitted immutable draft snapshot. Newer edits survive success of an earlier POST, including leave/reopen cases.
- Corrected wrapped select labels, hint associations, mobile Refresh naming, identity provenance wording and revision ID labels.
- Final React suite: 56 passing cases. Hub regression suite: 50 passing tests /473 assertions. App/root lint, typecheck, freshness, build and process smoke passed.
- Initial immutable attempt revision: 62b8c278-84fc-46c1-a565-48be22f06354 (review-bundle). Final candidate and Evidence will be a descendant revision.

## Browser checks before deployment

An isolated loopback Hub with disposable data was used, leaving real project approvals and integration lines unchanged. Actual browser checks covered token login, RU/EN switching, safe wiki preview, document import, test Flow freeze/start, Evidence upload and exact-candidate submission, review-only revision inspection, query-parameter navigation, Back/Forward and reload. On 375px, document scrollWidth remained 375px; identity and named Refresh controls remained accessible. English preference and the selected revision survived reload. Browser error/warning log was empty. The temporary Git adapter was a fixture and did not publish any branch.

## Runtime gate

Release 0aed6a7da8b0-react is healthy on geekom. Linux image tests/freshness and public SSO/RU/EN/mobile/desktop checks passed. Public static assets match the committed bytes. Source archive and backup identifiers are in report.md. Final candidate mutations are performed as verified agent:connector inside the Hub container, because the provided local token is a shared operator credential. Final acceptance remains untouched.
