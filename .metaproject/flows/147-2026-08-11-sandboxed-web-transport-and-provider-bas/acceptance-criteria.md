# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `web_fetch` and each remote search adapter use only the typed `SandboxedWebTransport` boundary; source-level and behavioral tests prove no direct network fallback.
- AC2: On macOS and Linux a public HTTPS request is launched through the dedicated web sandbox, with no project/home/shell/inherited-environment access; missing/invalid launchers, malformed worker output, overflow, timeout, or cancellation fail closed and leave no child process.
- AC3: The transport rejects non-HTTPS URLs, URL credentials, private/loopback/link-local/metadata/CGNAT/unspecified and mixed DNS answers (including IPv6/mapped forms), and invalid redirects before a connection; accepted remote connections are pinned to a validated address with TLS hostname preservation.
- AC4: Returned remote content observes the redirect/time/size/type limits, is provenance-labelled as untrusted, is redacted before UI/history/logging, and high-confidence prompt injection is blocked.
- AC5: The descriptor-driven catalog exposes configurable SearXNG, Brave, Tavily, and Exa; `/search-provider` lists all providers, `/search-connect` selects only successfully tested providers, and `/search` has no implicit fallback.
- AC6: SearXNG alone supports editable `http://localhost` and port `8080`, shows official self-hosting guidance, safely tests its response shape, and never widens generic fetch or remote-provider loopback access.
- AC7: User-facing documentation, focused tests, full CI, security scan, changed-scope health, and review pass before merge.
