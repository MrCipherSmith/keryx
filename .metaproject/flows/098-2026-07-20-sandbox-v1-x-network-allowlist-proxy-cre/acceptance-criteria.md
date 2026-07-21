# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A loopback allowlist proxy enforces a per-domain allowlist (exact + `*.domain` wildcard covering the apex): allowed hosts are tunnelled/forwarded, non-allowlisted hosts are refused, and every decision is auditable.
- AC2: `network: "restricted"` is expressed in the sandbox profile and enforced by the launcher — the contained process reaches ONLY the loopback proxy socket and no other network; on Linux, where that cannot be enforced without a netns+relay, it FAILS CLOSED rather than pretending.
- AC3: The proxy runs off the main thread so it keeps serving while the synchronous `spawnSync` adapter blocks the event loop; end-to-end restricted runs work on the production sync path.
- AC4: Restricted network is reachable from real entry points — `keryx harness exec --allowed-domains` and the agent shell via `KERYX_SANDBOX_ALLOWED_DOMAINS` — with the proxy env injected and the proxy torn down after the run.
- AC5: Credential masking substitutes a per-run sentinel with the real value on the wire to declared inject hosts, never exposing the real credential to the contained process; verified against the real internet. Full suite green and `tsc` clean.
