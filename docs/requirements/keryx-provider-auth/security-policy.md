# Security Policy: Keryx Provider Auth
Version: 1.0.0

## Status

Future integration policy. It constrains a future capability to the existing
keryx credential and security boundary; it does not claim the capability exists
today.

## Trust model

- A provider's authorization server is external and its responses are untrusted
  input: error codes, intervals, URLs and token payloads are all validated
  before use.
- A short user code is not a credential. It authorizes one pending grant, is
  single-use and short-lived, and grants nothing on its own.
- A device code **is** confidential. It is the client's half of the grant and is
  never rendered, logged, or sent to a transport.
- The operator's browser talks to the provider directly. keryx never sees a
  password or a subscription session.

## What may and may not leave the process

| Item | May be rendered | Reason |
|---|---|---|
| `user_code` | Yes | Useless without the operator's own authenticated browser session. |
| `verification_uri` | Yes | A public provider URL. |
| `device_code` | **No** | The client half of the grant. |
| Access token, refresh token, API key | **No** | Credentials. |
| Grant state, expiry, refreshability | Yes | Metadata, not secrets. |
| Credential fingerprint | Yes | Non-reversible, and never a prefix of the value. |

Credentials appear in no log, evidence record, session, stream event,
notification, command output, or fixture. `keryx auth list` and `auth status`
report state and expiry and never a secret.

## Storage

Every method's result is written to the existing user-global credential store at
mode 0600. This capability introduces no store of its own and no second copy.
Tokens obtained remotely are stored exactly as locally obtained ones.

## Polling discipline

| Control | Requirement |
|---|---|
| Interval | Never poll faster than the interval the provider returned. |
| Backoff | On `slow_down`, increase the interval as specified and continue. |
| Pending | `authorization_pending` is normal progress, not an error, and is not retried differently. |
| Terminal | `access_denied` and `expired_token` stop polling. No retry. |
| Independent bound | Polling also stops at keryx's own deadline, regardless of what the provider declared, so a misbehaving or stalled grant cannot poll indefinitely. |
| Single flight | One pending grant per provider; a later request supersedes and stops the earlier one. |
| Cancellation | Abandoning a grant stops its polling. |

## Remote rendering

A verification code delivered to a chat is delivered under the transport's
existing rules: authorized sender, resolved binding, bounded message, redaction
applied. Codes are short-lived and single-use, which bounds the consequence of a
message being seen.

An `api-key` or `oauth-pkce-loopback` provider requested remotely is **not**
handed a loopback link that cannot open. It is told plainly that entry requires
the machine. Issuing an unusable link teaches an operator to distrust the
interface, and a distrusted interface gets worked around.

Speaking a verification code aloud is not a supported delivery path. It is
deferred rather than adopted, because a code read out in a room is a code
disclosed to the room.

## Compliance

A provider entry declares only methods its vendor permits for third-party
clients. This is enforced as a property of registry data, so it is reviewable in
one place rather than distributed through code.

Two consequences that are requirements, not guidance:

- keryx does not implement subscription login for a vendor that restricts
  subscription credentials to its own clients, and does not read, borrow, or
  reuse credentials another client obtained.
- When an operator asks for such a login, keryx declines at the point of choice,
  states the reason, and offers the permitted alternative. It does not attempt
  the flow and let the vendor refuse, because the cost of that lands on the
  operator's account rather than on keryx.

The specific vendors, their positions and the sources are recorded in
[decisions.md](decisions.md) §D-01.

## Revocation and rotation

| Event | Response |
|---|---|
| `keryx auth logout` | The stored grant is discarded. Any pending device grant for that provider is cancelled. |
| Refresh failure | Surfaces as an authorization error. Never a silent downgrade to an unauthenticated or differently-authenticated state. |
| Vendor revocation | Detected on use and surfaced; the stored grant is marked revoked rather than retried indefinitely. |
| Suspected compromise | The grant is discarded locally and the operator is directed to revoke at the provider, which is the only place it can be truly revoked. |

## Security validation

Release gates must include offline fixtures for: a device grant returning each
of `authorization_pending`, `slow_down`, `access_denied` and `expired_token`; a
grant that stalls past the independent deadline; two concurrent requests for one
provider; a cancelled grant; an `api-key` provider requested remotely asserting
no loopback link is issued; a request for a forbidden subscription login
asserting refusal before any vendor call; a registry entry declaring a
prohibited method asserting validation failure; a refresh failure asserting a
visible error; and a full-suite scan asserting no credential value appears in
any log, evidence record, rendered message, or fixture.

No fixture may contain a real credential or contact a live vendor endpoint.
