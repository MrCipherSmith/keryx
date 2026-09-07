# MCP HTTP boundary implementation
Version: 0.1.0

Phase1 T9/T10 / AC-03. Validate requested host and port before SDK import, connect or listener. IP parsing uses node:net; accepted numeric addresses must be loopback. Hostname resolution returns one unambiguous loopback address; bind the verified address rather than resolving again. Missing/ambiguous/failed resolution refuses. Preserve transport policy (SAC HTTP denies remain). Add observable startup errors and safe request error handling while preserving lazy optional SDK loading.

Tests use only synthetic numeric addresses and injected DNS results. For invalid hosts, fake connect aborts before any possible listener even on broken current implementation; no external server is opened. Loopback runtime smoke has explicit close handles. Required edge cases: IPv4/IPv6, public/wildcard, misleading localhost suffix, mixed/multiple resolutions, invalid port and listener failure. Root works this independent lane while two phase0 subagents implement; independent reviewer will accept it later, never root self-acceptance.
