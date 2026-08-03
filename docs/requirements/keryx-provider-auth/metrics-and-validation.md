# Metrics and Validation: Keryx Provider Auth
Version: 1.0.0

## Status

Future validation plan. No measurement here has been taken, and this package
makes no performance or availability claim about any provider.

## Success metrics

| ID | Metric | Target | Source |
|---|---|---|---|
| M-01 | Registry entries declaring exactly one authentication method | 100% | Registry validation |
| M-02 | Registry entries declaring a method their vendor prohibits | 0 | Compliance fixtures |
| M-03 | Device-grant authorizations completed with no loopback listener and no browser on the keryx machine | 100% of device-grant fixtures | Fake authorization server |
| M-04 | Polls issued faster than the provider's declared interval | 0 | Polling fixtures |
| M-05 | Grants still polling after their terminal response or after the independent deadline | 0 | Stall and denial fixtures |
| M-06 | Concurrent pending grants for one provider | 0 | Single-flight fixtures |
| M-07 | Credential values appearing in a log, evidence record, session, stream event, notification, command output, or fixture | 0 | Secret-leak scan |
| M-08 | `device_code` values rendered to a transport | 0 | Rendering fixtures |
| M-09 | Unusable loopback links issued for remotely-requested `api-key` providers | 0 | Remote-presentation fixtures |
| M-10 | Forbidden subscription logins attempted against a vendor endpoint | 0 | Compliance fixtures |
| M-11 | Refresh failures resolving to anything other than a visible authorization error | 0 | Refresh fixtures |
| M-12 | New registry entries requiring a change outside the registry to appear in the picker, the remote surface, and a transport menu | 0 | Projection test |
| M-13 | Local `none` providers affected by absent credentials | 0 | Offline fixtures |

M-02 through M-13 are zero-tolerance: any non-zero result is a release blocker,
not a trend to watch.

## Fake authorization server

Required before any live endpoint is contacted. It must drive every path
offline, with no real credential:

| Capability | Purpose |
|---|---|
| Issue a device grant with configurable `interval` and expiry | AC-03, AC-04 |
| Return `authorization_pending` for a configurable number of polls | AC-06 |
| Return `slow_down` | AC-05 |
| Return `access_denied` | AC-07 |
| Return `expired_token` | AC-08 |
| Never respond, to exercise the independent deadline | AC-09 |
| Accept two grant requests for one provider | AC-10 |
| Support cancellation mid-poll | AC-11 |
| Issue a refreshable grant, then fail the refresh | AC-16 |
| Serve an authorization-code + PKCE flow | Local-flow coverage |

## Test layers

| Layer | Scope |
|---|---|
| Registry validation | Every entry validates against the provider-entry schema, declares one method, and declares no prohibited method. |
| Contract | Every schema validates its fixtures; every documented grant error code is handled by some path. |
| Scenario | Each acceptance criterion in [specification.md](specification.md) has at least one scenario against the fake authorization server. |
| Presentation | Each method requested locally and remotely, asserting the remote treatment of non-remote-capable methods. |
| Secret scan | The full suite scanned for credential values in every output surface. |
| Offline | The whole suite runs with no network and no real credential. |

## Release evidence

A release must publish:

- the registry validation result, including the count of entries per method;
- the zero-tolerance results for M-02 through M-13, each naming the scenario
  that proved it;
- the compliance check: every entry's declared methods against the vendor terms
  recorded in [decisions.md](decisions.md), with the date checked;
- the secret-scan result;
- an explicit statement of what was not tested — in particular, whether any
  live vendor endpoint was contacted at all;
- the health gate result at the merge commit.

## Explicit non-claims

- No claim that any provider's endpoint, pricing, model list, or terms are
  as documented at any date other than the one recorded in
  [decisions.md](decisions.md). Vendor terms change; the compliance check is
  dated for exactly that reason.
- No claim that a subscription-based provider will remain available to
  third-party clients.
- No latency or throughput claim about authorization.
- No claim that the device grant protects against a compromised local machine,
  which already holds the credential store.
- The enterprise cloud credential chains (Bedrock, Vertex, Azure) are listed as
  `cloud-credentials` but their integration is deferred and unvalidated by this
  package.
