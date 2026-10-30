# Cloudflare SSO implementation plan

Status: implementation in progress; human acceptance remains pending.

## Frozen source

- Hub project: `fcb56bb6-6eb6-4c2e-b154-1d682432a778`
- Hub Flow: `ddb407dd-48c0-4271-8d02-e1ed9c0428e2`
- Specification: [specification.md](specification.md), imported from `specs/hub-cloudflare-sso.md` version 1.
- SHA256: `ab33d6f017772206def6d5b80d357f86621e5e9a71b1fe5d65c32998d64782f3`.
- The operator selected Code Revision as the prototype's attempt representation. Evidence must reference the exact candidate revision. A separate Attempt entity is deferred.

## Work and boundaries

1. Independently verify Access JWTs in Hub using configured issuer, audience, RS256 and trusted JWKS; test failure paths before implementation.
2. Extend persisted sessions and principals without rewriting legacy records. Re-read an explicit role mapping file on every SSO-authenticated request.
3. Bootstrap browser SSO once after a missing session, show verified email and role, and implement bounded retry/logout behavior.
4. Run targeted security, API compatibility, client behavior, typecheck and lint checks, then independent review.
5. Attach the candidate and actual verification output in Hub. Do not accept the Flow or publish a delivery on the operator's behalf.

## State × event matrix

| Browser state | Open / reload | Explicit retry | Sign out | API request returns 401 |
|---|---|---|---|---|
| No Hub session, valid mapped Access identity | Read config, bootstrap SSO once, load projects | Repeat one bootstrap attempt | Not available | Show sign-in state; never silently repeat the failed operation |
| No session, SSO disabled | Show existing token form | Recheck session/config | Not available | Preserve sign-in form and visible error |
| No session, unmapped identity | Show access-denied error; no automatic token fallback | Retry once after operator changes mapping | Not available | Remain denied |
| No session, invalid or expired Access credential | Show authentication error and retry | Retry once; Cloudflare may require authentication on navigation | Not available | Remain unauthenticated |
| Session valid | Read session and load projects | Normal refresh | Invalidate Hub cookie/session, clear client state, navigate only to same-origin Access logout | Clear identity/project data, show explicit sign-in control |
| Session expired or mapping revoked | Show explicit authentication error | Recheck session and bootstrap only by explicit action | No automatic sign-in | Clear identity/project data without an automatic login loop |
| Authentication network failure | Show retryable error, no token form while SSO mode unknown | Recheck session/config once | Not available | No polling or repeated automatic mutations |
| Logout response has unsafe redirect | Not applicable | Not applicable | Hub session remains cleared; reject navigation and show error | Not applicable |

## Interface contract

- `GET /hub/v1/auth/config` returns `{cloudflareAccessEnabled:boolean}`.
- `POST /hub/v1/session/cloudflare` requires matching Origin and verified Access JWT, and returns `{principal}` plus the existing session cookie.
- `DELETE /hub/v1/session` invalidates the session and optionally returns the fixed same-origin `logoutUrl` for an SSO session.
- Principal gains optional verified `email`, `issuer`, `subject`; existing token principal IDs remain unchanged.
- Authorization always selects Bearer authentication; an invalid header must never fall back to browser identity.

## Configuration decision

Role mappings use an explicit JSON array file rather than process environment JSON, allowing atomic file replacement without restarting Hub. Normalize emails by trimming and lowercasing; reject duplicate normalized addresses. Mount the containing directory read-only when atomic replacement is used, so a replaced file is visible inside the container.

## Routing audit

- graph_used: `keryx gdgraph affected src/hub/web.ts`; existing graph predates newly added SSO files, so source is authoritative.
- wiki_used: `.metaproject/wiki/index.md`; no Hub-specific wiki page exists.
- ctx_used: file outlines, bounded source reads, search and verification summaries.
- raw_rg_used: no.
