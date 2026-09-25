# Keryx Jev Router — Implementation Plan

Version: 0.1.0 (draft)
Base: `origin/main` @ `e04715a2`, keryx `0.2.161`

This plan splits the PRD (`PRD.md`) into flows sized the way recent flows in
this repo are sized (`.metaproject/flows/300-*` through `303-*`: one
coherent, independently-shippable slice each, with its own acceptance
criteria file). No flow is opened by this package — flow numbers below are
placeholders (`Flow A`..`Flow E`); the operator runs `keryx flow start` (or
the flow-orchestrator skill) to assign real ids when ready to build.

Acceptance criteria are drafted below in keryx style: `- ACn: <criterion>`,
one line, verifiable, naming files/functions/tests, matching the register
used in `.metaproject/flows/300-2026-09-23-tui-sidebar-and-modals-for-the-governanc/acceptance-criteria.md`.

## Flow split

### Flow A — `DecisionPort` + `JevDecisionPort` (foundation, no wiring)

Ships the new seam in isolation, reachable only from its own tests and
`keryx route explain` (a thin CLI, no TUI yet). Nothing in the existing
subagent/review-tier path calls it yet — this flow is pure addition.

Draft acceptance criteria:

- AC1: `src/harness/decision/decision-port.ts` defines `DecisionQuestion`,
  `DecisionAnswer`, and `DecisionPort` with a single `decide(state,
  questions): Promise<{answers, usage}>` method, structurally independent
  of `ProviderPort` (`src/harness/provider/types.ts:345`) — no shared
  method name, no import of provider types into the new file.
- AC2: `src/harness/decision/jev-decision-port.ts` implements
  `JevDecisionPort`, constructed with `{fetch, apiKey}` (mirrors
  `AnthropicProvider`'s `{fetch, grant}` shape,
  `src/harness/provider/anthropic/anthropic-provider.ts`). `decide()` makes
  exactly one `POST https://openrouter.ai/api/v1/systemone` call with
  `Authorization: Bearer <apiKey>` and body `{model, state, questions}`,
  parses `{id, model, provider, answers, usage}`, and never retries. Proven
  by tests with an injected `fetch` stub asserting the exact request body
  and a parsed-response round trip; zero real network calls anywhere in the
  test file.
- AC3: `src/harness/decision/fake-decision-port.ts` implements
  `FakeDecisionPort` (mirrors `src/harness/provider/fake-provider.ts`),
  always resolving with a scripted or "no recommendation" answer set — the
  default whenever routing is off or misconfigured, never a guessed value.
- AC4: `JevDecisionPort.decide()` enforces the 64k combined `state`+
  `questions` token budget client-side (approximate character-based
  estimate is acceptable, documented as such) — over-budget calls return a
  named refusal (`{ok: false, reason: "state+questions exceed 64k token
  budget"}`) rather than sending a request TypeSafe would reject.
- AC5: `decide()` accepts a `timeoutMs` (default 2000) and aborts via
  `AbortSignal` on expiry; a timeout is reported as a distinct failure
  reason (`"timeout"`), not folded into a generic network-error message.
- AC6: `keryx route explain "<task>"` (new subcommand in
  `src/commands/route.ts`) builds a `state` from the task text plus the
  connected-provider catalogue (`configuredProviders`,
  `src/commands/providers.ts:1031`), asks the two-question design from
  PRD §5.3 (`tier` choice, `confidence` noul), and prints tier, confidence,
  usage, latency, and — on failure — the fallback reason. `--json` prints
  the same fields machine-readably. Constructed with `FakeDecisionPort` in
  tests (no real network); wired to `JevDecisionPort` only when
  `OPENROUTER_API_KEY` is present and routing is enabled (AC-Flow-E-2).
- AC7: CI is green on the branch; `keryx health run` passes.

Tasks (sizes: S ≤ half day, M ≤ 2 days, L > 2 days):
- T1 (S): `decision-port.ts` types + `fake-decision-port.ts`.
- T2 (M): `jev-decision-port.ts` — request/response mapping, budget guard,
  timeout/abort.
- T3 (S): `src/commands/route.ts` — `route explain` subcommand + `--json`.
- T4 (M): tests for T2/T3 (injected fetch fixtures covering success,
  malformed response, HTTP error, timeout, over-budget).
- T5 (S): docs stub in this package + `docs/docs/cli-reference.md` entry
  for `route explain`.

### Flow B — Redaction, opt-in config, and privacy gate

Wraps Flow A's port behind the opt-in and redaction requirements before
anything downstream is allowed to call it with real task text.

Draft acceptance criteria:

- AC1: A `routing` config block (new `.metaproject`-adjacent
  `routing.config.json` or an addition to the existing project config
  loader — same pattern as `security.config.json`/`health.config.json`)
  carries `enabled`, `confidenceThreshold` (default 0.6), `timeoutMs`
  (default 2000), `spendCeilingUsd`, and per-surface toggles
  (`subagentSpawn`, `reviewTier`). `KERYX_ROUTING_ENABLED=1` is an
  equivalent quick-trial override, read the same way other env escape
  hatches are (e.g. `KERYX_SUBAGENT_MODEL`, `model.ts:97`).
- AC2: A routing entry point (a new `resolveRoutingDecision(...)` in
  `src/harness/decision/route.ts`) never constructs a real
  `JevDecisionPort` unless `routing.enabled` (or the env override) is true
  AND `OPENROUTER_API_KEY` resolves — otherwise it returns
  `FakeDecisionPort`'s "no recommendation" without attempting network,
  proven by a test with the key present but `enabled: false`.
- AC3: Every `state` string passed to `decide()` is built by a single
  `buildRoutingState(...)` function that runs
  `redactSensitiveText` (`src/security/redact.ts:128`) over the task text
  and the context summary before concatenation — proven by a test that
  plants a secret-shaped and a PII-shaped string in the task text and
  asserts neither appears verbatim in the constructed `state`.
- AC4: `state` construction never includes file contents, tool output, or
  more than the immediate task description + the structured signal summary
  (PRD §5.2) — proven by a test asserting the built `state`'s size and
  shape are bounded regardless of how large the ambient session context is.
- AC5: A per-project routing spend ceiling
  (`routing.spendCeilingUsd`) is tracked with the same
  `spendFromTokens`/ceiling-status shape `keryx review budget` uses
  (`src/review/caps.ts:270-334`), exposed as `keryx route budget`, and once
  exceeded `resolveRoutingDecision` fails closed to "no recommendation"
  (never blocks the caller's own turn) with a named reason.
- AC6: Documentation (this package's README + `docs/docs/`) states the
  privacy boundary (PRD §8) in plain language: what leaves the process,
  to which two vendors, and how to turn it off.
- AC7: CI is green; `keryx health run` passes.

Tasks:
- T1 (M): config schema + loader + `KERYX_ROUTING_ENABLED` override.
- T2 (M): `resolveRoutingDecision` gate (enabled check, key check,
  fallback wiring to Flow A's `JevDecisionPort`/`FakeDecisionPort`).
- T3 (M): `buildRoutingState` + redaction integration + tests.
- T4 (S): `keryx route budget` (mirrors `keryx review budget`'s reporting
  shape, own ceiling).
- T5 (S): docs.

### Flow C — Subagent-spawn routing (Scenario B)

Wires Flow B's `resolveRoutingDecision` into the one live decision point
this version auto-applies: `spawn_subagent`.

Draft acceptance criteria:

- AC1: `SpawnSubagentToolDeps` (`src/harness/tool/builtin/spawn-subagent-tool.ts:209`)
  gains an optional `decisionPort`/`resolveRouting` seam; when routing is
  enabled (Flow B) and the dispatcher named no explicit provider/model/tier
  (`ChildModelRequest`'s `kind` is absent or `"inherit"`,
  `src/harness/child/model.ts:43-46`), the tool calls
  `resolveRoutingDecision` with the child's task text and, on a confident
  recommendation, constructs a `{kind: "tier", tier}` request instead of
  falling through to inherit.
- AC2: The resulting `ChildModelRequest` — whatever its `kind` — is passed
  to `resolveChildModel` (`src/harness/child/model.ts:156`) completely
  unmodified in its gate logic: G1 (allowlist), G2 (network/trust), G3
  (classifiable) all still run exactly as they do for an explicit or
  hand-authored tier request. Proven by a test where routing recommends a
  tier that resolves to a provider outside `allowedProviders`, and the
  spawn is denied with the SAME reason text an explicit out-of-allowlist
  request produces today (regression-pinned against the existing
  `model.test.ts` denial cases).
- AC3: An explicit `ChildModelRequest` (`kind: "explicit"` or `"tier"` from
  the dispatcher, or `KERYX_SUBAGENT_MODEL`) is never overridden by
  routing — `resolveRoutingDecision` is not even called in that case
  (short-circuit before the network-adjacent seam), proven by a test
  asserting zero calls to the injected decision port when an explicit
  request is present.
- AC4: A routing recommendation below the confidence threshold, a timeout,
  or a decision-port error all fall through to plain inheritance
  (`{kind: "inherit"}`) — the pre-existing default — with the reason
  recorded on the child's provenance/summary the same way other model-
  resolution sources already are (`source: "env"|"explicit"|"tier"|
  "inherited"`, extended with `"routed"` for the new source and
  `"routed-fallback"` for a fallen-back attempt).
- AC5: The size/scope floor from PRD §10 (skip routing for trivially small
  dispatches) is implemented as a check against the same signals
  `assignTier`'s `LIGHT_MAX_FINDINGS`/`LIGHT_MAX_DIFF_LINES`
  (`src/gdskills/model-tier.ts:625-627`) already use, so a one-line task
  never pays for a routing round-trip.
- AC6: CI is green; `keryx health run` passes; existing
  `spawn-subagent-tool.test.ts` and `model.test.ts` suites are unmodified
  in their pre-existing assertions (additive tests only).

Tasks:
- T1 (M): `resolveRouting` seam wired into `spawn-subagent-tool.ts`,
  short-circuit for explicit requests (AC3).
- T2 (M): tier->`ChildModelRequest` mapping + confidence/timeout fallback
  (AC1, AC4).
- T3 (S): size/scope floor check (AC5).
- T4 (M): tests — allowlist-denial-preserved (AC2), explicit-skips-routing
  (AC3), fallback-to-inherit (AC4).
- T5 (S): provenance/source label plumbing (`"routed"`/`"routed-fallback"`).

### Flow D — `review tier` signal integration (Scenario D)

Adds Jev as an additional, clearly-labeled signal to the existing
rule-based tier command, without changing its output when routing is off.

Draft acceptance criteria:

- AC1: `runTier` (`src/commands/review.ts:767`) accepts an optional routing
  signal (behind the same `routing.enabled` gate as Flow C) and, when
  present and confident, adds `"jev:<tier>@<confidence>"` to
  `decision.tier_reasons` alongside the existing rule-based reasons
  (`assignTier`, `model-tier.ts:656`) — it never replaces `assignTier`'s
  own computed tier; the two are reported side by side.
- AC2: With routing disabled (the default) or the decision port
  unavailable, `runTier`'s output — text and `--json` — is byte-for-byte
  identical to today's, proven by a snapshot/regression test run with
  `routing.enabled: false`.
- AC3: A visible disagreement between `assignTier`'s tier and Jev's
  recommended tier is surfaced as an explicit reason string
  (`"jev-disagrees: rule=<x> jev=<y>"`), never silently resolved one way —
  the rule-based tier still wins for the actual dispatch (§Non-goals: this
  version does not let Jev override the review pipeline's own arithmetic).
- AC4: CI is green; `keryx health run` passes.

Tasks:
- T1 (M): `runTier` signal plumbing + `tier_reasons` formatting.
- T2 (S): disagreement-reason formatting.
- T3 (M): tests (routing-off snapshot parity, routing-on additive reason,
  disagreement case).
- T4 (S): docs update for `keryx review tier --help`/CLI reference.

### Flow E — TUI visibility (sidebar + modal) and `keryx route explain` polish

Makes routing observable the way the project's standing TUI rule requires,
across whichever of Flow C/D is live by the time this ships.

Draft acceptance criteria:

- AC1: A `Routing` row is mounted in `sidebarTop` immediately after the
  existing `Model` row (`sb-model-k`/`sb-model-v`,
  `src/tui/tui-shell.ts:3857-3858`), via an exported
  `mountRoutingPanel(otui, renderer, parent, opts) -> {refresh, dispose}`,
  matching `mountGovernancePanel`'s shape
  (`.metaproject/flows/300-.../acceptance-criteria.md` AC1). States: `off`,
  `idle`, `deciding…`, `<tier> (<pct>%) — click for why`,
  `unavailable — fallback used`, `error — click for reason`. Row text stays
  within `SIDEBAR_TEXT_WIDTH`; colours are theme roles only. Proven by a
  panel test over fixtures, one per state.
- AC2: Clicking the row (any non-`off` state), or running `/routing`,
  opens a list+detail modal through `modal-host` showing, per recent
  decision (most recent N, newest first): the redacted `state` sent, both
  questions/answers, resolved tier->model mapping, usage (tokens + cost),
  latency, and accept/override/fallback status. Esc closes; ↑/↓/j/k
  navigate the list; matches the Governance/Triggers modal keyboard
  contract (`.metaproject/flows/300-.../acceptance-criteria.md` AC3/AC5).
- AC3: From the modal, an operator can force a tier/model override for the
  next call of the same kind (subagent spawn or review tier) — recorded
  and honored by Flow C/D's explicit-request short-circuit (Flow C AC3),
  never silently dropped on the next automatic recommendation.
- AC4: The `Usage` row already under `Model`
  (`tui-shell.ts:3877-3890`) folds in routing's own token/cost, visually
  distinguished (e.g. a `route:` prefix or a separate sub-line) from
  generation spend — proven by a test asserting both numbers are present
  and distinct after a routed decision.
- AC5: `/routing` is registered in `AGENT_SLASH_COMMANDS`
  (`src/commands/agent-commands.ts`) as agent-mode (TUI) only, listed in
  `ACP_TUI_ONLY_COMMANDS`, and classified read-only in
  `classifyBusyDispatch` (matching the Governance/Triggers precedent,
  `.metaproject/flows/300-.../acceptance-criteria.md` AC8).
- AC6: `keryx route explain` (Flow A) gains the same `usage`/latency/
  fallback-reason fields the modal shows, so the CLI and TUI never
  disagree about what a decision contained — proven by a test asserting
  CLI JSON output and the modal's data source share one formatter.
- AC7: With a fixture project holding routing decisions, the existing
  shell smoke test (`shell-pty-launch.smoke.test.ts`) still finds `Model`,
  `Context`, `Tools`, `Status`, `Ready` on an 80x24 pty — the new section
  does not push the existing chrome off a small terminal.
- AC8: Documentation (`docs/docs/cli-reference.md`, `README.md`, docs
  site, and this package's own docs) covers the `Routing` sidebar section,
  its modal, `/routing`, and `keryx route explain`.
- AC9: CI is green; `keryx health run` passes.

Tasks:
- T1 (M): `mountRoutingPanel` + state derivation from the routing log.
- T2 (L): routing modal (list+detail, keyboard nav) via `modal-host`.
- T3 (S): override affordance wired to Flow C/D's short-circuit.
- T4 (S): `Usage` row split (generation vs. routing spend).
- T5 (S): `/routing` command registration + busy-dispatch classification.
- T6 (S): shared CLI/modal formatter (AC6).
- T7 (M): tests for all of the above (panel states, modal keyboard flow,
  smoke-test non-regression).
- T8 (S): docs.

### Flow F (stretch, not scheduled) — unattended-run routing

Explicitly deferred (PRD §5.1, §11): auto-applying routing inside a live,
unopposed unattended dispatch (Scenario C) is the one place a wrong or
hallucinated recommendation is hardest to catch before money/time is
spent. This flow is named here only so it is not silently forgotten — it
should not be scheduled until Flow A–E have field evidence (PRD §12)
showing the recommendation is trustworthy, and until the sandbox
network-allowlist question (open question 4 below) has an operator
decision.

## Cross-flow dependencies

Flow A -> Flow B -> {Flow C, Flow D} -> Flow E. Flow D does not depend on
Flow C or vice versa; they can run in either order or in parallel once
Flow B ships. Flow E depends on whichever of C/D is live (it can ship
against Flow C alone and add Flow D's data source later).

## Test strategy

- **No real network calls anywhere in this package's tests.** Every
  `JevDecisionPort` test injects `fetch` (a stub returning scripted
  responses/errors/timeouts), matching the existing pattern in
  `src/harness/provider/anthropic/anthropic-provider.test.ts` and
  `src/commands/providers.cross-family.test.ts`.
- Redaction (Flow B AC3) is tested with planted secret/PII fixtures against
  the existing `src/security/detect/*` test fixtures' shapes, not new ad
  hoc patterns.
- Subagent-spawn wiring (Flow C) reuses `model.test.ts`'s existing
  fail-closed gate test fixtures (`allowedProviders`, `policy`,
  `providerClass`) so the new "routed" source is tested against the SAME
  denial cases as `"explicit"`/`"tier"`, not a parallel fixture set.
- TUI panel/modal tests follow `governance-panel.test.ts`/
  `triggers-panel.test.ts`'s fixture-project + `otui.testing` pattern.
- A `route explain` snapshot test with `routing.enabled: false` must
  reproduce byte-identical output to a hypothetical pre-routing baseline
  wherever this plan touches existing commands (`review tier`), guarding
  against silent behavior change for operators who never opt in.

## Open questions for the operator

1. **Auto-apply scope**: Is Scenario B (subagent spawn) actually the right
   first place to auto-apply a routing recommendation, or should even that
   ship explain-only for a first release, with Flow C reduced to "compute
   and log the recommendation, apply nothing" until there is field data?
2. **Confidence threshold default (0.6)**: chosen arbitrarily in this
   draft — is there a preferred starting value, or should it start
   conservative (e.g. 0.8) and be tuned down as trust builds?
3. **Config surface**: should `routing` live in a new
   `routing.config.json` (sibling to `security.config.json`/
   `health.config.json`), or fold into an existing config file? This plan
   assumes a new file; either is a small change to Flow B T1.
4. **Sandbox network allowlist for unattended routing** (relevant even
   before Flow F, if Flow C's routing call itself ever runs inside a
   sandboxed subagent child): should `openrouter.ai` be added to a
   project's default unattended allowlist, or must every project add it
   explicitly per PRD §8.4? This plan assumes explicit-only (fail closed,
   named refusal) — confirm before Flow C ships if subagent children can
   themselves run sandboxed.
5. **Spend ceiling default**: PRD §10/Flow B AC5 propose a routing-specific
   ceiling separate from the generation ceiling. What should the default
   be, given Jev's own price is a small fraction of a cent per call?
6. **Jev version pin**: `jev-1.13` vs. `jev-latest` — this plan does not
   pin one in Flow A; recommend defaulting to `jev-1.13` (a fixed version)
   for reproducible routing behavior, with `jev-latest` as an opt-in
   override. Confirm this default is acceptable.
7. **`review tier` disagreement handling** (Flow D AC3): when Jev disagrees
   with the rule-based tier, is a logged reason string sufficient for a
   first release, or should a persistent disagreement (tracked over many
   calls) eventually feed back into tuning `assignTier`'s own thresholds?
   Out of scope for this plan either way, but worth naming as a Flow D
   follow-up.
