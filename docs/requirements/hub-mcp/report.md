# Shared Hub MCP — verification and handoff

Implementation runtime commit: `840fb1ba82c71fd3ee2d68038f76433f250f7da5`.
Canonical Flow: `0cce9652-6bbe-4ee9-89bc-92e275a8d3e4`; frozen specification `specs/hub-mcp.md` v1, digest `ddb89ea0c5aa3dd1c150f00dfcda20c094c6fff4fcb003d9de7d92d62209c855`. All twelve criteria are unchanged.

Status: implementation and independent checks complete; exact-candidate handoff is being recorded. Owner acceptance remains pending. Live Hub deployment, public Cloudflare Service Auth activation and native client installations are not claimed.

## Result

- One authenticated stateless `/mcp` endpoint with fifteen fixed, closed-schema tools over Streamable HTTP, original agent identity, same-application REST dispatch, explicit operation keys and existing domain/concurrency guards.
- Named digest-backed agent credentials, project filtering/allowlists, read-only access, request-time revocation and queued-operation reauthentication. REST and MCP share the authorization boundary; legacy bootstrap keys remain compatible and unscoped.
- `keryx hub mcp --url ... [--token-env NAME]` stdio bridge, independent of checkout/binding, with environment-backed Hub and optional paired Cloudflare headers, HTTPS/loopback validation, no redirects/unsafe retries, bounded shutdown/timeouts and sanitized protocol-only output.
- Isolated exact SDK1.32.1 runtime and minimum-Bun-compatible lock, Docker/source/standalone packaging, npm optional dependency pin and four-client examples. Shared root node_modules remains untouched.

No freeze/accept, token administration, integration selection, delivery or arbitrary HTTP tool is exposed. Successful Evidence is self-reported, not trusted CI or owner approval. Code Revision is the prototype Attempt representation; review bundles are technically blocked from integration/delivery.

## Independent final gate

Raw logs are retained under `.metaproject/data/gdctx/raw/` and packaged with the final review candidate where referenced by Evidence.

| Check | Result | Raw log |
|---|---|---|
| Release Hub/MCP/bridge regressions, SDK1.32.1 + Bun1.3.14 | 111 passed, 771 assertions, 13 files | `2026-10-26T22-20-48-818Z-5fc135_run.log` |
| Development Hub/CLI/boundary aggregate | 181 passed, 3748 assertions, 17 files | `2026-10-26T22-20-49-266Z-5fb5af_run.log` |
| Scoped ESLint and root TypeScript | PASS, zero findings | `2026-10-26T22-21-15-938Z-9a948f_run.log` |
| Compiled npm and standalone client interoperability | PASS: initialize, 15 tools, scoped reads, named mutation attribution/replay and project denial; valid stdout, empty stderr | `2026-10-26T22-20-57-012Z-8cb2a5_run.log` |
| Release SDK-facing strict TypeScript | PASS | `2026-10-26T22-20-55-311Z-579ed3_run.log` |
| Scripts TypeScript | PASS | `2026-10-26T22-18-27-584Z-cc95e7_run.log` |
| Root build and generated frontend freshness | PASS | `2026-10-26T22-20-42-216Z-904365_run.log` |
| Isolated runtime dependency audit | SDK1.32.1: 91 packages, zero findings | `2026-10-26T22-17-21-026Z-c58dea_run.log` |
| Final source/Linux standalone packaging | PASS, frozen install/compile from isolated release runtime | `2026-10-26T22-20-07-998Z-268572_run.log` |

These test totals overlap: release regressions are repeated with the production runtime, not additional distinct tests. Optional whole-project dependency audit, oxlint, Sonar and madge checks were not run; no coverage is claimed for them. Initial source/compile probes had temporary harness path/quoting corrections, explicitly separated from production code fixes.

## Independent security review

Final verdict: APPROVE at the runtime commit. Two reproduced defects were repaired and retested:

- F-MCP-001: credential redaction could corrupt escaped JSON. Redaction now operates on decoded values and preserves outer/nested JSON; ordinary request IDs are preserved and credential-bearing IDs fail before execution.
- F-MCP-002: Evidence idempotency hashed the sanitized body. It now hashes the original payload before redaction while persisting only sanitized Evidence and an opaque digest. Changed payload returns409; unchanged retry after stable-ID key rotation returns200.

Both original reviewer probes and regressions passed independently. Final security recheck: 44 tests /241 assertions in both working tree and isolated release source. No unresolved blocker/major/minor remains. One INFO limitation is inherited: some large individual base64 payloads can be rejected by the existing domain validator before the nominal total quota. This Flow does not redesign that validator; do not interpret the quota as a guaranteed supported single-file size.

## Release artifacts

Generated from isolated SDK1.32.1 and Bun1.3.14. All packaged runtime code files were compared against the runtime commit; later report-only changes do not change runtime code.

| Artifact | SHA256 |
|---|---|
| Source archive | `6122b054ce269e7c8df868c3e0ac8601d8f9f5633fbb420f9ce1925c5e400696` |
| Linux standalone server | `8c7734dfacfda291b44e2711d8ba37cf8d7b8c0781c32c0d0dcab2d3cb2f032a` |
| Linux standalone client | `1b82f9b60c44d52d3aa32e00ee576520395940d2caaa78181b114ce5f9a50128` |

Candidate image on <server>: `keryx-team-hub-hub:mcp-validation-840fb1ba`; image config digest `sha256:86fa79b7467a24af829146309c24c243310d4fe533f1e0fbaafc577b6e244369`. Build log `2026-10-26T22-23-11-109Z-5ccaa7_run.log`. This is an isolated validation image, not the running Hub release. The installed Hub and cloudflared were left healthy/active, without policy or data changes.

## Pending operator setup

See [deployment](deployment.md) and [client configuration](clients.md). Public machine access needs a scoped Cloudflare Service Auth policy and individual Hub agent key provisioning, followed by actual client configuration/discovery. Preserve browser SSO and existing tunnel audience/JWT/edge guards. No Cloudflare account-management key, real credentials file, human browser credential or chat token exchange was used for this implementation. Tests used disposable credentials/data; only canonical planning/handoff operations target the real Hub under the existing agent principal.

No Git/npm publication, live runtime activation, human acceptance or real integration-line change is part of this handoff.

Routing: graph_used, wiki_used, memory_used (no matching decision), ctx_used; raw_rg_used: no.

## Final Linux proof on geekom

Built the actual Dockerfile from the checksummed final source archive, with SDK1.32.1 frozen production install and Bun1.3.14. Ran the image with no external network, read-only filesystem, dropped capabilities and disposable tmpfs/data; production volumes were never mounted.

- All111 Hub tests /771 assertions across13files passed in Linux, log `2026-10-26T22-25-11-539Z-3fadf8_run.log`.
- Actual Linux standalone server AND standalone stdio client passed SDK interoperability:15tools, scoped project reads, read-only mutation denial, request-time revocation, empty bridge stderr. Log `2026-10-26T22-23-33-728Z-a8f0c7_run.log`.
- No production data or credentials were used. Test containers used --rm; the candidate image/archive remain available for review.
- An initial suite invocation lost shell quoting at the SSH boundary and failed before tests ran. It was replaced by a fixed script mounted read-only; the successful suite above is the executed gate. No product code change was needed.

Live Hub health remained healthy and system cloudflared remained active. This proof is not public machine-access activation or native client installation.
