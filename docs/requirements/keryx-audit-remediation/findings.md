# Audit ledger — 2026-09-27

Version: 0.1.2

Source keys: `L` logic review, `S` security review, `A` architecture review,
`G` deterministic gates, `R` flow 352 review round 1. Line numbers are as of
`main` at `0143740a` (audit) or `33a3591b` (review round); functions are named
so the reference survives drift. Severity is the reviewer's, confirmed by the
orchestrator reading the path unless marked *probe* (confirmed by a runnable
`bun` probe).

## Closed the same day

| Id | Sev | Where | Finding | Closed by |
|---|---|---|---|---|
| L-4 | high | `spawn-subagent-tool.ts` `invoke` | `ctx.signal` never read; parent abort did not reach the child. | #770 AC6 |
| L-5 | high | `agent.ts` `finishWithBudgetSummary` | `undefined` signal to `streamWrapUpRound`. | #770 AC6, #771 M-1 |
| L-6 | high | `agent.ts` `runConcurrentSpawnBatch` | No signal parameter; children ran to their own timeout. | #770 AC6 |
| L-7 | high | `shell.ts` `runAgentRepl` | Thrown turn skipped `releaseLease()`/`leaveBus()`. | #770 AC7 (agent), #771 B-1 (chat) |
| L-8 | high | `shell.ts` `closeAndExit` | SIGINT/SIGTERM did not sweep background jobs. | #770 AC7 |
| S-1 | high | `harness/external/env.ts` | External agent children inherited SSH agent, cloud credential files, other providers' keys. | #770 AC1 |
| S-2 | high | `harness/web/sandboxed-web-transport.ts` | Search credential re-sent on cross-origin redirect. | #770 AC2 |
| S-3 | high | `spawn-subagent-tool.ts` timeout exit | Partial output bypassed `foldChildSummary`. | #770 AC3 |
| S-4 | high | `mcp-servers/spawn-env.ts` `isDeniedForMcpChild` | `PRIVATEKEY`, `REFRESHTOKEN`, `DBPASS` … passed through. *probe* | #770 AC4 |
| S-5 | med-high | `mcp-servers/trust.ts` `serverFingerprint` | `oauth` block not hashed. | #770 AC5 |
| R-M2 | major | `wiki/deep-enrich.ts` outer catch | Composed abort signal not disposed on throw. | #771 |
| G-1 | — | `src/harness/child/model.ts` | `openai-codex`/`gemini` "not classifiable". | #766 |

## Open — provider adapters

| Id | Sev | Where | Finding |
|---|---|---|---|
| L-1 | high | `compat/openai-compat-provider.ts` ≈1306–1321 `flushPendingToolEnds` | Stream EOF mid tool-call: the partial JSON is emitted as a completed `tool_call_end`, `model_end` is gated on `sawFinish` and never fires, no error. The native adapter (`openai-provider.ts` ≈1044–1050) flags the same case as a malformed stream. |
| L-2 | high | `gemini/gemini-provider.ts` ≈933–1014 streaming loop | No branch for an in-stream `{"error":{…}}` envelope. A 200 stream carrying a 503 envelope ends as `provider_error {kind:"malformed", retryable:false}` — the retryable cause is lost. *probe* |
| L-3 | high | `gemini/gemini-provider.ts` ≈968 | `callId = functionCall.id ?? callName`: two calls to the same tool without ids share one id; `linkToolCalls` pairs results by occurrence and can attribute a result to the wrong call. *probe* |
| L-9 | medium | `gemini/gemini-provider.ts` ≈381–389 `toGeminiContents` | Several text-target thought signatures on one replayed message overwrite one `thoughtSignature`; only the last survives. *probe* |
| L-10 | medium | `openai/openai-provider.ts` ≈558–565 | The comment says `max_output_tokens` is "always sent, unconditionally"; the Codex (subscription) branch never sends it. Decide whether the endpoint accepts it; either send it or fix the comment. *probe* |
| L-11 | medium | `openai/openai-provider.ts` ≈914–928 | Advertises `promptCaching: true` but never reads `usage.input_tokens_details.cached_tokens`; cost accounting loses cache hits. |

## Open — harness and shell

| Id | Sev | Where | Finding |
|---|---|---|---|
| L-12 | medium | `agent.ts` sequential tool loop ≈3314–3332 vs concurrent path ≈4059–4076 | No try/catch around `executeCall`; a throwing tool or `requestApproval` crashes the turn and skips the `Stop` hook. The concurrent path is hardened. |
| L-13 | medium | `harness/child/worktree.ts` ≈116–129 `provisionWorktrees` | Earlier worktrees leak when a later `create()` throws. No production callers today. |
| L-14 | medium | `shell.ts` `/new`, `/clear` | `lastToolOutput`/`lastToolName` not reset; `/expand` after `/new` prints the abandoned session's output. |
| L-15 | low-med | `shell.ts` `completionWaiters` | One closure per operator line, never pruned when completions rarely fire. *probe* |
| R-M3 | major | `mcp-client/credential-boundary.test.ts:16` | The header claims AC1 credential-boundary coverage, but the guarded functions (`gatedSuperviseCodexMcpRun`/`superviseCodexMcpRun`) have no non-test callers. Green by vacancy. |
| R-I3 | info | `shell-bus.test.ts` AC7 test | A source-text audit that duplicates a runtime assertion which already exists. |

## Open — security depth

| Id | Sev | Where | Finding |
|---|---|---|---|
| S-6 | medium | `security/redact.ts` ≈132 `redactSensitiveText` | Pattern-only; never calls `security/detect/entropy.ts`. Opaque bearer tokens and bare hex keys in tool output reach the model unredacted. This is the one scrubber on every tool output (`agent.ts` ≈3337) and on web content. |
| S-7 | medium | `security/detect/injection.ts` :11,17,23,29 | `[^.\n]{0,N}` gaps and ASCII-only words: a newline inside the phrase or one Cyrillic homoglyph defeats `isUnsafeExternalInstruction` (`harness/web/web-content.ts` ≈21–25). Partial mitigation: the content is still marked untrusted. |
| S-8 | medium | `web-fetch-tool.ts` ≈37–47, `web-search-tool.ts` ≈39–45 | Read-class tools; the model-supplied URL/query is checked only for a public host, never for secret-shaped content leaving the machine. |
| S-9 | low | `mcp-servers/http-headers.ts` ≈364 `displayUrl` | Path segment printed verbatim: `https://host/v1/<token>/mcp` shows the token in `mcp list`, `mcp doctor --json`, and the trust prompt. |
| S-10 | low | `lib/oauth/open-url.ts` ≈29–30 win32 | `cmd /c start "" <url>` re-tokenises; a `verification_uri` with `&` can run a second command. Reachable only through the hard-coded catalog endpoints. |
| R-MIN1 | minor | `harness/external/env.ts` | `isDeniedForMcpChild` lives in `mcp-servers/spawn-env.ts` and is reached cross-subsystem; a shared home would say what it is. |
| R-I1 | info | `harness/external/env.ts` | First-pass by-name check is case-sensitive; the shape check behind it catches the rest. |
| R-I2 | info | `mcp-servers/spawn-env.ts` `GLUED_SECRET_RE` | Unanchored; no false positive found. |
| S-11 | low | `mcp-servers/compat.ts` `parseGrokToml` | An unsupported TOML value form is echoed raw into the problem message — a Bearer token in an inline-table `headers` field would print in `mcp list --json` warnings, `mcp doctor` and the `/mcp` panel. Pre-existing; found by the flow 353 review round (S1). |

## Open — architecture debt

| Id | Sev | Where | Finding |
|---|---|---|---|
| A-1 | P1 | `security/service.ts` ≈93–108 | Re-exports `./impact-evidence` it never calls, which closes three cycles through `testing/related-report.ts`, `testing/service.ts`, `metrics/lifecycle.ts`, `testing/coverage-map.ts` back to `security/guard.ts`. One caller: `commands/security-impact-evidence.ts:21`. |
| A-2 | P2 | `cli.ts:151,675` ↔ `commands/help.ts:16` | `CLI_ROUTES`/`printCommandHelp` imported back by the help command; the cycle grows with every command. |
| A-3 | P2 | `wiki/collect.ts:200` → `provenance.ts:28` → `describes.ts:26` → `collect.ts` | `keyFilesForPage` (four lines) lives in `collect.ts` only because that file builds the index it reads. |
| A-4 | P3 | `security/audit-harness/index.ts:62` ↔ `proposals.ts:14`; `testing/service.ts:16–20` ↔ `related-report.ts:9` | Facade re-export loops; runtime-safe (hoisted declarations), documented. |
| A-5 | P3 | `mcp-servers/config.ts:154,548` ↔ `compat.ts:36` | `parseJsonTolerant` shared through a cycle. |
| A-6 | P2 | four adapters (`anthropic-provider.ts:344,350`, `openai-provider.ts:247,259`, `gemini-provider.ts:460,472`, `openai-compat-provider.ts:226,232`) | `retryableFor` byte-identical in all four; `mergeUsage` structurally identical. |
| A-7 | P3 | `tui/tui-shell.ts` (8 838 lines) | Four visible seams: approval, pickers (≈1 500 lines), panels, format utils. Blocked by the source-text tests (`backlog.md` item 11). |
| A-8 | P3 | `lib/test-preload.ts` | Reported orphan; loaded by `bunfig.toml` `preload`. False positive to encode. |

## Open — tooling and dogfood

| Id | Sev | Where | Finding |
|---|---|---|---|
| G-2 | medium | `security/path-scan.ts:55` `maxBytes: 8 MiB` | `keryx security scan .` on the repository stops at the byte limit and reports coverage `incomplete`; the audit had to scan `src`, `scripts`, `.github` separately. `--max-bytes`/`--max-files` exist (`commands/security.ts`); the traversal does not consult ignore rules, so `.claude/worktrees` and similar count against the limit. |
| G-3 | medium | `health/sources/tests.ts` `detect`, coverage source | On keryx's own tree `keryx health run` reports `tests` and `coverage` as `missing` while `bun test` exists. `resolveBin` (`health/sources/helpers.ts`) already falls back to `Bun.which`, so binary lookup is not it; the candidates are `compatibleReportForHealth` and `hasTestFiles` over `ctx.sourceFiles`. Root cause to establish. |
| G-4 | low | `keryx standard validate` | Warnings: modules `tasks` and `mcp` declare `.metaproject/data/{tasks,mcp}` which do not exist. |
| G-5 | low | `.claude/worktrees/` | Eight stale agent worktrees on the audit machine; nothing prunes them. |
