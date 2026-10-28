# Team Hub Cloudflare Access SSO

Version: 0.1.0

[Specification](specification.md) · [Implementation plan](plan.md) · [Verification report](report.md)

This feature removes the second token prompt for mapped Cloudflare Access users. Hub independently verifies Access identity, creates its existing HttpOnly session, and assigns only an explicitly configured human role. Agent Bearer credentials continue using the local or SSH-tunneled API.

The frozen Hub Flow is `ddb407dd-48c0-4271-8d02-e1ed9c0428e2`. Its imported specification is `specs/hub-cloudflare-sso.md`, version 1, digest `ab33d6f017772206def6d5b80d357f86621e5e9a71b1fe5d65c32998d64782f3`. The local specification is an exact copy, not a new version.

## Configuration

SSO is off unless explicitly enabled. Existing bootstrap operator, reviewer and agent tokens are still required for local recovery and API compatibility.

```dotenv
KERYX_HUB_ACCESS_ENABLED=true
KERYX_HUB_ACCESS_ISSUER=https://example-team.cloudflareaccess.com
KERYX_HUB_ACCESS_AUDIENCE=<CLOUDFLARE_ACCESS_AUD>
KERYX_HUB_ACCESS_ROLES_FILE=/run/keryx-access/roles.json
KERYX_HUB_PUBLIC_ORIGIN=https://hub.example.com
```

The audience is an application identifier, not a credential. Verify it against the intended self-hosted Access application before enabling SSO elsewhere. Do not copy production tokens into source control or chat.

The role file is a JSON array:

```json
[
  { "email": "owner@example.com", "role": "operator" }
]
```

Only `operator` and `reviewer` are valid roles. Addresses are trimmed and lowercased for matching. Duplicate normalized addresses, invalid entries, invalid JSON and missing files must fail closed. There is no default role or automatic registration.

The file is re-read for SSO-authenticated requests so replacing it changes access without restarting Hub. Use a dedicated directory owned by the deployment operator, writable only by that operator, and readable by the container's Hub user. Mount the directory read-only into the container rather than bind-mounting one file: an atomic rename then remains visible inside the container. Write a complete temporary file in the same directory with appropriate permissions, validate its JSON, then rename it over `roles.json`. An unreadable or invalid replacement denies SSO instead of preserving potentially revoked privileges.

The trusted issuer supplies keys at its fixed `/cdn-cgi/access/certs` endpoint. JWT-supplied key URLs are not used. Verification uses bounded key fetching, caching and refresh to support key rotation. Hub limits its session to the shorter of its normal session lifetime and the verified Access JWT expiration. Each SSO session request must also carry a valid Access JWT for the same issuer and subject; a cookie alone does not preserve Access access after revocation or expiry.

## Authentication and browser behavior

- On opening Hub, the browser checks its existing session.
- If no session exists, it reads the public authentication-mode flag. With SSO enabled it attempts the Access exchange once; a successful mapped identity enters the project list without a token prompt.
- AJAX requests identify themselves with `X-Requested-With: XMLHttpRequest`, allowing Access to respond with an authentication error instead of an HTML login redirect. An authentication or network failure stays visible with an explicit retry button. No polling, token fallback or failed-operation replay runs automatically.
- The sidebar displays verified email and effective role. The audit identity uses the stable issuer/subject principal rather than an email display label.
- In SSO mode the sign-in screen describes local or SSH-tunneled Bearer API recovery instead of offering a browser token form. The configured public HTTPS origin does not make an HTTP tunnel browser origin an allowed session-login origin. In SSO mode the public Access route rejects legacy token login and token-based cookies; existing public token sessions transition through the verified SSO bootstrap. Use the local or SSH-tunneled Hub route for recovery; keep the public hostname behind Access.
- Sign out first invalidates Hub's session, then navigates to the fixed same-origin `/cdn-cgi/access/logout`. Arbitrary redirect parameters and external destinations are rejected by the client. Cloudflare logout may invalidate the Access session used by other protected applications in the same account; this is not a Hub-only identity-provider logout.
- Any Authorization header selects Bearer authentication. An invalid Bearer credential cannot fall back to a human session or Access identity.

The Access policy must continue to allow only the intended email identities, and native JWT validation in cloudflared must remain enabled. Hub's independent verification protects the direct loopback API from forged identity headers; the proxy header presence check alone is not signature verification.

## Deployment procedure

1. Keep a tested SSH connection and existing human recovery token available. Do not print the token while checking it.
2. Record the current release, deployment configuration and a consistent SQLite backup using the existing [Geekom runbook](../team-hub-prototype/geekom.md).
3. Build and verify the candidate release. Do not replace unrelated system cloudflared services or other applications.
4. Add the role directory and read-only container mount, provide the configuration above, and confirm Hub's runtime user can read the file.
5. Deploy the candidate Hub release with the existing public-origin, edge and tunnel protections intact. Invalid enabled configuration must stop startup; restore the previous release/configuration instead of weakening authentication to work around it.
6. Check local health and agent API, then run the browser and negative smoke checks below.
7. Record the exact release/commit, configuration hashes without secrets, smoke results and candidate revision in the Flow's Evidence. Human acceptance is a separate action.

## Smoke checks

- Open the public hostname with the mapped owner email. Complete Access authentication if prompted. Verify Hub enters without its old token prompt and shows the email and `operator` role.
- Sign out. Verify the Hub session is invalid and the browser exits Access rather than silently reopening Hub.
- Reopen and authenticate, then temporarily replace a dedicated test mapping with an unmapped or downgraded test identity. Verify the next authenticated request denies access or uses the new role. Restore the intended mapping. Do not accidentally revoke the only recovery route.
- An anonymous public request must still be intercepted by Access; no public bypass policy is needed.
- Direct loopback requests with missing/forged JWTs must not obtain an SSO session.
- An invalid Bearer header combined with a valid browser cookie must return a machine-readable authentication error.
- A dedicated agent token through loopback/SSH must still read its allowed API, while human-only freeze/accept/review actions remain forbidden.
- Existing Flow states, pinned digests and document contents must remain intact.

Automated tests cover issuer/audience/signature/time validation and role/session edge cases without requiring a live identity provider. The browser smoke complements those checks; it does not replace them.

## Rollback and recovery

Restore the previous release and configuration using the existing deployment wrapper. Disable the new SSO mode only as part of a deliberate rollback; keep Cloudflare Access protecting the public hostname. Old human token login remains usable through the local/SSH route. Retain the database backup and candidate evidence for diagnosis; do not rewrite historical principals or delete failed evidence.

## Candidate representation

The current prototype has no separate Attempt entity. By operator decision, this work uses a Code Revision as its attempt and binds Evidence to that exact revision. Because the repository exceeds the full-snapshot quota, the candidate uses `purpose: "review-bundle"`: changed files, patch and Git base identify the proposed implementation, while the complete source stays in the recorded local Git commit.

A review bundle is visibly marked as non-publishable and cannot be selected as the integration line or sent to Git delivery. It must never be presented as a complete repository snapshot. Acceptance of the Flow remains the operator's decision; Git publication and deployment are distinct actions.

## Verified Cloudflare references

- [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access session management and logout](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)

## HTTP integration contract

Paths below are relative to `/hub/v1`.

| Method and path | Behavior |
|---|---|
| `GET /auth/config` | Public mode flag `{cloudflareAccessEnabled:boolean}`; no credentials or role mapping. |
| `POST /session/cloudflare` | Requires matching Origin and independently verified `Cf-Access-Jwt-Assertion`; returns `{principal}` with a session cookie. Any Authorization header selects Bearer validation and cannot create an SSO browser session. |
| `GET /session` | Existing SSO cookie requires the matching, valid Access identity and a current allowed role mapping; returns the effective principal. |
| `DELETE /session` | Same-origin browser request invalidates the session, even when expired or revoked; SSO sessions return a fixed `logoutUrl`. Bearer logout does not revoke an unrelated accompanying browser cookie. |
| `POST /session` | Existing human token login when SSO is disabled; local recovery when enabled and no Access header is present. Public Access requests cannot use token fallback. |
| `POST /projects/:p/revisions` | Optional `purpose: "snapshot"` or `"review-bundle"`; absent means legacy snapshot. Incremental revisions must retain base purpose. |

Review bundles remain valid Flow Evidence subjects but return `409 review-bundle-not-deliverable` on line selection or delivery. Updated connectors also reject them for pull, delivery receipt application, and incremental snapshot submission. Existing old connectors must not be used to apply review bundles by ID.
