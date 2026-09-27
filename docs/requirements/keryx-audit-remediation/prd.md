# PRD: Keryx Audit Remediation — 2026-09-27

Version: 0.1.1

## Problem

The 2026-09-27 audit confirmed twenty-two defects that were not fixed on the
day ([findings.md](findings.md)). They share one shape: a guard that exists on
one path and not on its sibling. The native OpenAI adapter flags a truncated
tool call and the compat adapter emits it as complete (L-1). The concurrent
tool path has an error boundary and the sequential one does not (L-12).
Anthropic and OpenAI handle an in-stream error event and Gemini does not (L-2).
The MCP HTTP client refuses redirects with credentials; the web transport did
not until #770. A user sees these as intermittent: a run that ends without an
error and without a result, a retryable outage reported as permanent, a cancel
that half-worked, a tool result attributed to the wrong call.

The security findings are second-layer. The first layer — file confinement,
credential isolation for MCP servers, SSRF pre-connect checks — was audited
clean. What remains is depth: redaction that recognises only known secret
shapes, an injection detector that a newline defeats, read-class web tools
that can carry a secret out in a URL. Each is a gap between what the docs
promise ("every tool output is scrubbed before it reaches the model") and what
the scrubber can see.

The architecture findings cost nothing at runtime today and something on every
change: eight import cycles, four copies of one function, an 8 838-line file
that the source-text tests pin in place.

The tooling findings mean keryx does not pass its own gates on its own tree:
the secret scan cannot cover the repository, and health reports the test
source as missing.

## Goal

Every open finding in the ledger is either fixed with a test that fails
without the fix, or recorded as accepted with a reason a reader can check.
Sibling paths behave the same way for the same situation. keryx's own gates
run to completion on keryx's own tree.

## Users

- **Operators running keryx on a provider other than Anthropic** — Gemini,
  OpenRouter, DeepSeek, a local OpenAI-compatible endpoint. They meet L-1,
  L-2, L-3 and L-9 first, and cannot tell a provider fault from a keryx fault.
- **Operators on the ChatGPT subscription** — L-10 decides whether their output
  budget reaches the wire.
- **Operators who cancel** — L-12 and L-14 are what Ctrl-C and `/new` leave
  behind.
- **Security reviewers of keryx** — S-6 to S-10 are what an adversarial page or
  a prompt-injected tool can still do.
- **Contributors** — A-1 to A-8 are what every change to the security, testing,
  CLI and TUI modules pays.
- **keryx's own CI** — G-2 and G-3 are why the audit had to be run by hand.

## Requirements

### R1 — Provider adapters agree with each other

- R1.1 A stream that ends mid tool-call is a malformed-stream error on every
  adapter, never a completed call with truncated JSON (L-1).
- R1.2 An in-stream error envelope is classified with the same
  `classifyGeminiError` used before the 2xx, so a 503 stays retryable (L-2).
- R1.3 A tool call without a provider id gets a unique synthetic id; two calls
  to one tool in one response never share an id (L-3).
- R1.4 Replaying an assistant message with several thought signatures keeps
  every signature on the wire (L-9), or the adapter documents why Gemini
  accepts only one and drops the rest deliberately.
- R1.5 The subscription request path either sends `max_output_tokens` or the
  comment beside it says it does not and why (L-10). Verified against the
  endpoint, not inferred.
- R1.6 `cached_tokens` from the Responses API reaches usage accounting (L-11),
  or `promptCaching` is advertised `false`.

### R2 — Harness and shell fail closed and clean

- R2.1 The sequential tool loop has the same error boundary as the concurrent
  path: a throwing tool or approval callback yields an error tool result, the
  turn continues or ends normally, and the `Stop` hook fires (L-12).
- R2.2 `provisionWorktrees` removes what it created when a later create
  throws (L-13), or is deleted if it stays unused.
- R2.3 `/new` and `/clear` reset the last tool output, so `/expand` never shows
  the abandoned session (L-14).
- R2.4 `completionWaiters` is bounded: resolved or superseded waiters are
  dropped (L-15).
- R2.5 `credential-boundary.test.ts` states what it covers. Either the guarded
  functions gain a production caller or the test says the boundary is
  exercised only by itself (R-M3).

### R3 — Security depth

- R3.1 `redactSensitiveText` runs the entropy detector after the pattern pass,
  with the same thresholds `keryx security scan` uses (S-6). False positives on
  hashes and ids are measured on the committed eval corpus before the change
  ships.
- R3.2 The injection phrase detectors match across a newline and after Unicode
  confusable folding (S-7); the eval corpus gains both cases.
- R3.3 A `web_fetch` URL or `web_search` query that contains secret-shaped
  content is refused before any connection, with the finding recorded (S-8).
- R3.4 `displayUrl` masks path segments that look like tokens (S-9).
- R3.5 The Windows browser-open plan does not pass the URL through `cmd`
  re-tokenisation (S-10), or validates the URL's scheme and character set
  first.
- R3.6 `isDeniedForMcpChild` moves to a shared module both subsystems import
  (R-MIN1); the first-pass name check is case-insensitive (R-I1);
  `GLUED_SECRET_RE` is anchored to name boundaries (R-I2).

### R4 — Architecture debt

- R4.1 The security ↔ testing ↔ metrics cycle is cut by removing the
  `impact-evidence` re-export from `security/service.ts` and importing from
  `security/impact-evidence` at the one caller, with an import-zone entry so the
  import policy accepts it (A-1).
- R4.2 `CLI_ROUTES` and `printCommandHelp` move to a registry module both
  `cli.ts` and `commands/help.ts` import (A-2).
- R4.3 `keyFilesForPage` moves to a leaf module (A-3).
- R4.4 `parseJsonTolerant` moves to a shared module (A-5).
- R4.5 `retryableFor` lives once, in `provider-port.ts`; `mergeUsage` gets a
  shared helper the four adapters call with their own field names (A-6).
- R4.6 A-4 is recorded as accepted (facade loops, hoisted, documented) unless
  R4.1–R4.4 make the cut trivial.
- R4.7 `gdgraph query orphans` knows `bunfig.toml` preloads (A-8).
- R4.8 `tui-shell.ts` is split along the four seams (A-7) after the
  source-text tests are converted (`backlog.md` item 11); this package records
  the seams, not the split.

### R5 — keryx passes its own gates on its own tree

- R5.1 `keryx security scan .` on the keryx repository reports coverage
  `complete` at the default limits (the `--max-bytes`/`--max-files` flags
  already exist): the scan skips paths the repository's own ignore rules
  exclude and lists them (G-2).
- R5.2 `keryx health run` on the keryx repository reports `tests` and
  `coverage` as available or explains in the report why not, in words a first
  user can act on (G-3). Binary resolution already searches PATH; the gap is
  in the adapter's detection scope.
- R5.3 The `tasks` and `mcp` modules stop declaring data directories they do
  not create, or create them (G-4).
- R5.4 Stale agent worktrees under `.claude/worktrees/` are listed by
  `keryx doctor`-class tooling or pruned by `keryx update` with a confirmation
  (G-5). Cross-reference: `keryx doctor` is W5 of
  [keryx-p0-improvements](../keryx-p0-improvements/prd.md).

## Success criteria

- Every open ledger row has a status of `fixed` (PR, test name) or `accepted`
  (reason) in [findings.md](findings.md).
- The four provider adapters share one behaviour table for: EOF mid tool-call,
  in-stream error, missing call id — and a test per adapter per row.
- `keryx gdgraph query cycles` on `main` reports at most the A-4 facade loops.
- `keryx security scan . --json` on the keryx tree: `coverage.status:
  "complete"`.
- `keryx health run` on the keryx tree: no `missing` optional source without an
  actionable note.
- The security eval corpus (`keryx security eval`) does not regress on the
  redaction and injection sets after R3.1 and R3.2.

## Risks

- **R3.1 false positives.** Entropy detection on tool output will flag git
  hashes, UUIDs and base64 blobs that are not secrets. Mitigation: allow-shapes
  for known identifiers, the corpus measurement before shipping, and a
  per-session `/redact strict|normal` switch if the rate is above 1 in 200
  outputs.
- **R1.4 may be a Gemini constraint.** If the API accepts one signature per
  part, the fix is documentation, not code. Decide by probing the endpoint.
- **R4 touches files with source-text tests.** `cli.ts` and `tui-shell.ts` are
  read as text by tests (`backlog.md` item 11). R4.2 must move code without
  changing the audited literals or convert the tests first.
- **L-10 depends on OpenAI behaviour.** Sending `max_output_tokens` to the
  Codex endpoint may 400. The requirement is to know, not to guess.
- **Scope creep from R5.4** into the `keryx doctor` product work. Keep the
  listing here, the command there.

## Recommendation

Three flows, in this order:

1. **Providers and harness (R1, R2)** — user-visible correctness; each item is
   small and independently testable; ship as one release.
2. **Security depth (R3)** — needs the corpus measurement first; ship behind the
   measurement.
3. **Architecture and gates (R4, R5)** — mechanical moves and tooling; R4.8
   waits for the source-text test conversion.

Do not open a fourth flow for A-4; record it.
