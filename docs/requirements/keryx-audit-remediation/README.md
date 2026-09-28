# Keryx Audit Remediation — 2026-09-27

Version: 0.2.0

## Purpose

Close what the full project audit of 2026-09-27 found and did not fix on the
day. The audit ran the deterministic gates (health, `bun audit`, Metaproject
Standard, wiki validator, graph cycles, secret scan), then three read-only
reviews — security, logic correctness, architecture — over the runtime paths
with the highest complexity, and a managed review round over the first fix PR.
Every finding in this package was confirmed by reading the code path or by a
probe; nothing here is a suspicion.

The findings that were fixed the same day are listed as closed so a reader
sees the whole audit in one place, and are not requirements of this package.

## Status

Updated 2026-09-28 (flow 356). **R1, R2, R3, R4, R5 all implemented.**

- **R1/R2** (flow 354, PR #774, release 0.3.18): the four-adapter stream
  contract, `cached_tokens` accounting, the sequential tool loop's error
  boundary (and `caughtToolErrors` reaching trigger outcomes), `/new`/`/clear`
  resetting `/expand`, bounded completion waiters, `provisionWorktrees`
  cleanup, honest test headers. L-10 was decided by a live probe: the
  ChatGPT-subscription endpoint rejects `max_output_tokens`. L-9 stayed open
  (no Gemini credential on the build machine).
- **R3** (flow 355, releases 0.3.19–0.3.21, three review rounds): entropy-based
  redaction (S-6), injection-detector Unicode-confusable/newline evasion
  (S-7), outbound secret-shaped URL/query screening for `web_fetch`/
  `web_search` (S-8), token-shaped path segments masked in displayed URLs
  (S-9), the Windows browser-open command line no longer re-tokenised through
  a shell (S-10), `isDeniedForMcpChild` moved to a shared core home with its
  case-sensitivity and glued-name-anchoring fixed (R-MIN1/R-I1/R-I2).
- **R4/R5 and the two remaining L/S rows** (flow 356, this release): every
  open architecture-debt row (A-1 through A-8), every open tooling/dogfood
  row (G-2, G-4, G-5 — G-3 stays open, out of this package's frozen scope),
  the deferred compat in-band-error gap (L-16), and the Grok TOML value-echo
  leak (S-11).

Ledger: every row carries `fixed` or `accepted`, with a test name, except
G-3 (`health run`'s `tests`/`coverage` sources on keryx's own tree), which
this package never took on. See [findings.md](findings.md) for the
per-row detail — in particular A-4 (facade loops, accepted, reconfirmed as
the only two left) and G-4 (accepted: not reproducible on a fresh tree, the
original warnings were local runtime-state drift on the audit machine).

Already closed, outside this package:

| Release | PR | What |
|---|---|---|
| 0.3.14 | #766 | `openai-codex` and `gemini` classified as network providers; `spawn_subagent` works on the ChatGPT subscription again. |
| 0.3.15 | #770 | External-agent credential strip, cross-origin redirect credential, sub-agent timeout quarantine, glued MCP secret names, `oauth` in the trust fingerprint, abort propagation to sub-agents, agent-REPL lease/bus `finally`, SIGINT job sweep (flow 352, AC1–AC8). |
| 0.3.16 | #771 | Chat-REPL lease/bus `finally`, wrap-up abort reported as interruption, deep-enrich abort-listener leak (flow 352 review round 1: B-1, M-1, M-2). |
| 0.3.18 | #774 | This package's R1 and R2 (flow 354). |

## Document index

- [README.md](README.md) — this file.
- [prd.md](prd.md) — problem, goal, requirements, success criteria, risks, recommendation.
- [specification.md](specification.md) — per-finding required behaviour, tests and acceptance criteria.
- [findings.md](findings.md) — the audit ledger: every finding, its source, evidence and status.

## Scope

Twenty-two open findings in five groups:

1. **Provider adapters** — truncated streams, in-stream errors, tool-call
   identity, replay of reasoning signatures, cache accounting, a misleading
   comment on the subscription path.
2. **Harness and shell** — the sequential tool loop's missing error boundary,
   an unused worktree helper that leaks, stale `/expand` output after `/new`,
   unbounded completion waiters.
3. **Security depth** — entropy-based redaction, injection-detector evasion,
   outbound URL screening for read-class web tools, tokens in displayed URL
   paths, the Windows browser-open command line, a test that claims coverage
   of code with no callers.
4. **Architecture debt** — the eight import cycles, the duplicated
   `retryableFor`, the `tui-shell.ts` split.
5. **Tooling and dogfood** — the secret scan's byte limit on the repository
   itself, health's `tests`/`coverage` sources missing on keryx's own tree, two
   Standard warnings, stale agent worktrees.

## Non-goals

- Product features (rewind, review as a GitHub Action, remote approval) —
  those are [keryx-p0-improvements](../keryx-p0-improvements/README.md).
- Re-auditing areas the audit marked clean (file confinement, MCP credential
  core, SSRF pre-connect checks, provider instance state, ledger admit/release).
- Changing the security policy's severity model.

## Related modules and packages

- `src/harness/provider/*` — provider adapters (group 1).
- `src/commands/agent.ts`, `src/commands/shell.ts`, `src/harness/child/` (group 2).
- `src/security/`, `src/harness/web/`, `src/mcp-servers/`, `src/lib/oauth/` (group 3).
- `src/security/`, `src/testing/`, `src/wiki/`, `src/cli.ts`, `src/tui/` (group 4).
- `src/security/path-scan.ts`, `src/health/sources/` (group 5).
- Flow 352 and its review package `.metaproject/flows/352-*/reviews/2026-09-27-branch-33a3591b-1/`.
- [keryx-p0-improvements](../keryx-p0-improvements/README.md) — the product side of the same audit.
- `docs/requirements/backlog.md` — item 11 (the shell god-files and their source-text tests) overlaps group 4.
