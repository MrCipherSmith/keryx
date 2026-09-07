# Public output boundary integration

MCP tool/resource dispatch now uses the deterministic structural output validator before serialization/transport. Operation JSON retains its own shape; sibling redaction metadata is preserved by the SDK transport in `_meta["keryx/redaction"]`. Declared tool output schemas are checked; unsupported/unsafe representations become constant format-unsafe errors. Unknown tool names and resource exceptions do not echo uncontrolled input.

Mandatory masking remains active when advisory redaction is disabled. Security service and raw-output guard validate serialized JSON structurally. Persistence materialization applies the same floor, including when an earlier advisory guard supplied no redacted representation. Safe outputs and parsed operation values remain compatible; disabling diagnostics no longer disables secret protection.

- Initial adapter RED: 12 pass,5 fail, raw2026-09-06T12-22-31-665Z_run.log.
- Current MCP/guard/materializer suites:56 pass,0 fail,225 assertions, raw2026-09-06T12-32-04-367Z_run.log. Includes actual SDK in-memory round trip and metadata preservation.
- Targeted lint: PASS, raw2026-09-06T12-32-05-642Z_run.log.
- Golden deterministic/offline security controls:2 pass,0 fail, raw2026-09-06T12-32-40-934Z_run.log.

Independent security review, whole-program tests and recursive-scanner integration remain pending. Schema checking supports an explicitly screened subset; it does not claim complete arbitrary JSON Schema support. Real provider/network operations were not used.
