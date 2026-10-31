# Single Sign-On to Team Hub through Cloudflare Access

## Problem

Users already authenticate through Cloudflare Access before reaching
Team Hub, but Hub then requires a separate human access token.

This duplicates authentication and makes browser onboarding confusing.
Hub should recognize an authorized Cloudflare identity while preserving
its own roles, session security, and human-only approval rules.

## Expected Outcome

An authorized human opens Hub, authenticates through Cloudflare Access,
and enters the application without providing a Hub token.

Hub verifies the identity and assigns a role using an explicit
server-side mapping. Agents continue using their dedicated Bearer tokens.

## Outcome Criteria

- The configured owner can open Hub after Cloudflare authentication
  without entering a second token.
- Hub records the authenticated person's identity in new audit events.
- An unmapped email cannot obtain a Hub session.
- Local agent access and existing human-only approval restrictions
  continue working.

## Scope

- Optional Cloudflare Access authentication for the browser interface.
- Server-side verification of Cloudflare Access JWTs.
- Explicit email-to-role configuration.
- Integration with the existing Hub session mechanism.
- Login, access-denied, session-expired, and logout behavior.
- Deployment documentation and authentication tests.

## Functional Requirements

### 1. Explicit Configuration

Cloudflare SSO must be explicitly enabled through server configuration.

Configuration must include:

- The trusted Cloudflare Access issuer.
- The expected application audience.
- An explicit mapping from allowed email addresses to existing
  human Hub roles.

The initial deployment maps:

- owner@example.com -> operator

Email matching must use a documented normalization rule.
Duplicate or conflicting mappings must be rejected.

There must be no implicit operator role, domain-wide default role,
or automatic registration of unknown users.

Invalid enabled configuration must fail startup with a clear error
that does not disclose secrets.

### 2. Verified Identity

Hub must independently verify the Cloudflare Access JWT received
through the configured authentication path.

Verification must include:

- Signature verification using the configured issuer's public keys.
- An explicit allowlist of supported signing algorithms.
- Exact issuer validation.
- Expected application audience validation.
- Expiration and applicable not-before validation.
- Required subject and email claims.

Unsigned tokens and tokens with unsupported algorithms must be rejected.

Hub must not trust an email header or the presence of a JWT header alone.

The issuer and key endpoint must come from trusted server configuration,
never from an unverified token or request parameter.

Key retrieval must use HTTPS, bounded timeouts, and a bounded cache.
Key rotation must be supported without restarting Hub.
Verification must fail closed when no suitable trusted key is available.

JWTs, cookies, Bearer tokens, and authorization headers must never
appear in application logs, error messages, or audit event payloads.

### 3. Human Identity and Roles

A verified email must match an explicit server-side role mapping
before Hub creates a human session.

Hub must retain the verified issuer and subject as the external
identity and associate the mapped email and role with the session.

Display labels must not replace the stable identity used for auditing.

Clients must not choose or override their identity or role.

Cloudflare identities must never receive an agent role through
this browser authentication mechanism.

### 4. Browser Login

When Cloudflare SSO is enabled, an authorized request with a valid
Access JWT must be able to establish a Hub session without entering
a Hub token.

The UI must show the signed-in email and effective role.

A valid but unmapped identity must receive a clear access-denied page
without exposing other users or the role mapping.

Missing or invalid authentication must not create a session or expose
project data.

Authentication failures must not produce infinite redirect loops.

When SSO is disabled, existing human token login must continue working.

### 5. Sessions and Logout

Reuse the existing server-side Hub session mechanism.

Browser session cookies must remain HttpOnly, Secure for the public
deployment, and protected by the existing SameSite and CSRF controls.

An SSO session must not remain valid beyond the verified Access
credential's expiration or Hub's own session lifetime, whichever
comes first.

Role mappings must be rechecked for authenticated requests.
Removing a mapping or changing its role must take effect on the
next authenticated request without restarting Hub.

Logout must invalidate the Hub session and clear its cookie.
The browser logout flow must also use the configured Cloudflare
Access logout mechanism so the remaining Access session does not
immediately sign the user back into Hub.

Logout destinations must be fixed or validated against an explicit
allowlist. Arbitrary return URLs must not be accepted.

### 6. Agent and API Compatibility

Dedicated agent Bearer tokens must continue working through the
existing local or SSH-tunneled API path.

SSO must not make the public Bearer API accessible through an
Access bypass policy.

An agent token must never become a human session or inherit
Cloudflare human privileges.

API requests must preserve existing machine-readable authentication
errors rather than redirecting agents to an HTML login page.

Authentication precedence must be explicit and tested:

- A request containing Authorization uses Bearer authentication.
- An invalid Bearer credential must not fall back to a browser cookie
  or Cloudflare human identity.
- Browser authentication must not silently replace an agent principal.

SSO must not weaken the existing human-only restrictions for freezing
Flow criteria, accepting results, or approving proposals.

### 7. Audit and Existing Data

New SSO-authenticated actions must record the verified human identity
and effective role using the server-selected principal.

Existing records attributed to shared operator or reviewer principals
must retain their original attribution.

The implementation must not rewrite historical authorship, reset
Flow states, modify pinned specifications, or change document content.

### 8. Deployment and Recovery

Document:

- Required Hub configuration.
- The trusted issuer and application audience.
- Email-to-role mapping.
- The Cloudflare Access application and policy requirements.
- Key retrieval and rotation behavior.
- Session expiration and logout behavior.
- Verification steps and rollback instructions.

Keep native JWT validation in cloudflared as an additional protection.
Hub verification must also reject forged headers on the direct
loopback endpoint.

Preserve a documented recovery path through SSH and existing local
human token authentication. Do not expose that recovery path through
a public Access bypass.

## Acceptance Criteria

1. A mapped operator signs in through Cloudflare Access and enters
   Hub without providing a Hub token; the UI shows the correct
   email and role.

2. Valid JWTs are accepted only after signature, algorithm, issuer,
   audience, time, subject, and email validation. Forged headers,
   expired tokens, and tokens for another application are rejected,
   including requests sent directly to the loopback endpoint.

3. Valid but unmapped identities cannot access project data.
   Missing or invalid SSO configuration cannot grant a default role.

4. Removing or changing a role mapping takes effect on the next
   authenticated request without a restart. SSO sessions cannot
   outlive the verified Access credential or Hub session limit.

5. Logout invalidates the Hub session and initiates Cloudflare
   Access logout without an immediate silent Hub sign-in loop
   or an arbitrary redirect destination.

6. Agent Bearer authentication, local recovery access, and existing
   human-only approval rules remain functional. Invalid Bearer
   credentials cannot fall back to a human identity.

7. New audit events identify the verified human principal.
   Historical attribution, existing Flows, pinned specifications,
   and documents remain unchanged.

8. Automated tests cover verification failures, role mapping,
   session lifetime, logout, authentication precedence, and
   compatibility. A deployment smoke test demonstrates successful
   browser SSO and rejection of unauthorized requests.

## Out of Scope

- Hub-managed usernames and passwords.
- User registration, invitations, and a user-management interface.
- New roles or per-project permission models.
- Additional identity providers.
- Public agent access through Cloudflare service tokens.
- Changes to Flow creation fields or lifecycle behavior.
- Reattribution of historical actions.