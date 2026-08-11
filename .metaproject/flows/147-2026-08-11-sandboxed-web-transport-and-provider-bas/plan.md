# Implementation Plan

Status: selected

## Approach

Create a small typed web boundary under the harness: the tool and provider
adapters issue bounded JSON requests to a platform-contained worker, never to a
network API directly. The worker owns URL/IP/DNS/redirect/content policy and
returns a bounded structured result. This preserves one auditable security
boundary and makes provider adapters thin descriptor-driven clients. It is a
new web-specific launcher/profile rather than a reuse of command containment:
the latter has intentionally incompatible Linux egress and filesystem posture.

## Steps

1. Add RED tests for the transport contract: URL/IP/DNS policy, pinned request
   plumbing, timeout/cancellation, untrusted-content sanitisation, and absence
   of direct web I/O in tools/adapters.
2. Implement the worker protocol and cross-platform launcher integration with
   fail-closed capability detection; migrate `web_fetch` to the port. A remote
   adapter has only descriptor-owned fixed requests; its credential is a scoped
   request field rather than inherited environment data.
3. Add search descriptor/configuration/state services plus SearXNG, Brave,
   Tavily, and Exa adapters. Local loopback is accepted only by SearXNG.
4. Wire descriptor-driven `/search-provider`, `/search-connect`, and `/search`
   agent behavior, including no-active guidance and credentials redaction.
5. Add user-facing SearXNG setup documentation, focused/integration/real-host
   coverage, then run verifier, security scan, health, and review.

## Risks

- True cross-platform network isolation is sensitive to how Seatbelt and bwrap
  expose a worker runtime and DNS/TLS. Do not claim a real-host proof until CI
  confirms both macOS and Linux legs.
- The PRD is broad; every adapter must stay behind the shared port, with no
  direct-fetch compatibility fallback.
- Linux must never claim hostname-level kernel filtering that bwrap alone cannot
  provide. Its enforceable contract is a dedicated purpose-limited worker plus
  application-level pinned connection and fail-closed launcher behavior.
