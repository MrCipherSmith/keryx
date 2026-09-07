# MCP HTTP implementation evidence
Version: 0.1.0

Flow 233 T9/T10, AC-03. Root implemented independent HTTP lane while phase0 subagents worked. Numeric host parsed by node:net and classified loopback; hostname all-address resolution is bounded, unambiguous and pinned to one verified numeric bind. Invalid host/port fails before transport connect or listener. Scope IDs/malformed IPv6 produce safe typed errors. Browser Host/Origin and cross-site request headers checked against actual bound port before SDK handling. Listen failure rejects; request failure has safe generic response.

Files: src/mcp/transport/http-sse.ts, loopback-host.ts, http-sse.loopback.test.ts. Optional SDK stays lazy. Existing SAC HTTP denies were not edited; stdio behavior tested alongside HTTP. No real model calls or non-loopback listener opened.

RED: 13 failing cases before implementation, .metaproject/data/gdctx/artifacts/2026-09-06T11-00-26-702Z_run.md. Additional malformed IPv6/header RED: 2026-09-06T11-02-56-884Z_run.md.
GREEN: 34 tests pass / 0 fail across HTTP + existing MCP suite; .metaproject/data/gdctx/artifacts/2026-09-06T11-07-50-758Z_run.md. Includes real local listener refusing bad Host/Origin, trusted request reaching SDK, and occupied-port rejection.

Global type/build/health and independent security/logic review remain pending. Task implementation done does not complete phase1 or assert all transport scenarios verified. Numeric IPv6 parsing tested; actual IPv6 bind platform capability is not asserted by IPv4 live fixture.
