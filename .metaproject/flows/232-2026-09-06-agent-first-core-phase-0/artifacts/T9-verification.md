# T9 Phase 0 Integrated Verification

Version: 0.1.0  
Snapshot completed: 2026-09-06T11:30:55Z  
Branch: `codex/agent-first-core`  
HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`

## Verdict

- Global quality gate: **INCOMPLETE** — ESLint is configured as required but is unavailable/skipped.
- Source snapshot verdict: **FAIL** — the pre-fix HTTP/SSE request boundary accepts a configured arbitrary DNS hostname in the Host allowlist, enabling a DNS-rebinding path to the unauthenticated loopback MCP endpoint.
- TypeScript targets: **PASS**.
- Full test execution: **FAIL in the captured pre-sync snapshot**, with one isolated contract-mirror failure. The exact mirror was then synchronized and its focused recheck passed. Per orchestration instruction, the full suite was not repeated.

The `keryx health run --strict` command printed PASS, but its generated report simultaneously records required ESLint as skipped. `.metaproject/health.config.json` sets `eslint.required: true` and `failOnMissingRequiredSource: true`; therefore that tool result cannot establish a complete global gate.

## Tooling

| Check | Availability | Command |
|---|---|---|
| Root TypeScript | available | `bun run typecheck` |
| Scripts TypeScript | available | `bun run typecheck:scripts` |
| Full tests | available | `bun test` |
| ESLint | unavailable, required | no lint script, dependency, or root config |
| Circular imports | unavailable, optional | `madge` absent |

## Check results

### Root TypeScript — PASS

`bun run typecheck` exited 0. Capture: `.metaproject/data/gdctx/artifacts/2026-09-06T11-23-18-700Z_run.md`.

### Scripts TypeScript — PASS

`bun run typecheck:scripts` exited 0. Capture: `.metaproject/data/gdctx/artifacts/2026-09-06T11-23-26-095Z_run.md`.

### Full tests — one pre-sync failure, then isolated repair verified

The combined `bun run check` exceeded the verifier’s 120-second command ceiling and was terminated. The components were then run separately so the timeout source was observable. Both TypeScript targets completed normally; the full Bun suite itself requires longer than 120 seconds when run across the repository.

One diagnostic `bun test` execution was allowed to finish without duplication:

- 6,843 passed.
- 18 skipped.
- 1 failed.
- 51,930 assertions across 561 files.
- Bun-reported duration: 138.41 seconds.
- Diagnostic log SHA-256: `20947728b2138bedef17502e74f220e9d8f4c833e114139b371321db71545d01`.
- Captured compact evidence: `.metaproject/data/gdctx/artifacts/2026-09-06T11-28-36-539Z_read.md`.

The only failure was:

```text
src/gdskills/install.test.ts
this repo's installed contracts are byte-identical to their sources
task-implementer-input-contract.schema.json: source and installed copy differ
```

This reproduced independently in the initial focused boundary/install run: 7 passed, 1 failed. Capture: `.metaproject/data/gdctx/artifacts/2026-09-06T11-20-25-405Z_run.md`.

After the exact registered filename was synchronized, the focused install suite passed 5/5 with 26 assertions. Capture: `.metaproject/data/gdctx/artifacts/2026-09-06T11-29-32-482Z_run.md`. The source, skill-local copy, and registered installed copy now share SHA-256 `279cff73f746f05a9c1bcb961a8cca25d7ff0fcaabbf82acad45a20ba07f25a6`; the mistakenly named extra copy is absent.

The full suite was not rerun because the failure was isolated, reproduced, and verified by its owning focused test, and orchestration explicitly prohibited another broad run without a new concern.

### MCP import boundary — PASS for its stated contract

All three `src/mcp/boundary.test.ts` tests passed in the focused run. The resolved-target guard permits nested `src/lib/*` imports as intended.

### HTTP request security — FAIL in the captured pre-fix snapshot

Snapshot file: `src/mcp/transport/http-sse.ts`, SHA-256 `79c7ad4c41b5a9d944ac68d64d8c58cc9d05770d98ab1dd0f4cb620d895c91a5`.

`startHttpTransport` passes `[host, options.host, "localhost"]` to `isTrustedMcpHttpRequest`. `host` is the verified numeric loopback binding, but `options.host` may be an arbitrary configured DNS name that resolved to loopback only during startup. The request boundary later accepts that original DNS name from the Host header without binding it to the verified address.

A pure local reproduction returned `accepted: true` for:

```text
isTrustedMcpHttpRequest(
  { host: "attacker-controlled.example:43210" },
  ["127.0.0.1", "attacker-controlled.example", "localhost"],
  43210,
)
```

Under DNS rebinding, a browser can retain same-origin semantics for the attacker-controlled hostname after it resolves to loopback. Because this endpoint has no authentication, the configured DNS name must not become a trusted Host alias merely because it resolved to loopback once.

Required repair: construct the request Host allowlist from the verified numeric bound address and explicitly safe loopback literals/names only. Do not include an arbitrary original DNS hostname. Add a regression that configures a DNS hostname resolving to loopback and proves its Host header is refused while the numeric bound address remains accepted.

Root released the source freeze after this snapshot and began the HTTP repair. This T9 report records the pre-fix evidence and does not claim that later source is verified.

### Shell subprocess observation — no Keryx defect established

The separately reported real help/error smoke passed 4/4. The only write was Bun’s development-source transpiler cache; no Keryx session or configuration file was written. This external observation was not used to accept another lane.

### Health — tool PASS observed, global gate INCOMPLETE

`keryx health run --strict` exited 0 and printed PASS with score 93 and 236 P2 complexity findings. Its normalized report records:

```text
eslint | skipped | auto | required: yes
typescript | available | auto | required: yes
```

Because required ESLint is unavailable, the global quality gate remains INCOMPLETE regardless of the command’s printed PASS. Capture: `.metaproject/data/gdctx/artifacts/2026-09-06T11-28-59-666Z_run.md`.

### Other checks

- Circular imports: skipped; `madge` is unavailable.
- Diff whitespace: PASS (`git diff --check`, exit 0).
- External model/network calls: none.
- Verifier source, git index/branch, flow state, and frozen acceptance criteria edits: none.

## Acceptance assessment

- Root and scripts TypeScript targets pass: **MET**.
- Current full tests pass or every failure is explicitly reported with scope and reproduction: **MET**. The one captured failure is fully identified and its exact focused recheck passes after synchronization.
- Required checks unavailable are INCOMPLETE, never PASS; source/schema parity correct: **MET** for reporting and current schema parity. Global completion remains blocked by missing required ESLint.

## Routing audit

- `graph_used`: not-relevant; the dispatch supplied exact files and commands, and this task verified execution rather than navigating dependencies.
- `wiki_used`: not-relevant; no architecture or domain inference was needed.
- `ctx_used`: yes; typechecks, tests, health, and the large diagnostic log used gdctx captures.
- `raw_rg_used`: no.
