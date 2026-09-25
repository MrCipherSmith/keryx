# Keryx Jev Router — PRD

Version: 0.1.0 (draft)
Base: `origin/main` @ `e04715a2`, keryx `0.2.161`

## 1. Problem

An operator who has connected several providers today (Anthropic, OpenAI,
Gemini, Ollama, and any OpenAI-compatible gateway — OpenRouter, DeepSeek,
Z.AI, Cerebras, Groq, Moonshot, Grok, …, per `OPENAI_COMPAT_PROVIDERS` in
`src/commands/providers.ts:310`) has, in effect, a fleet of models of very
different strength, speed and price. Keryx already lets a human pick one of
them per session (`/model`, `/provider`, `/connect` —
`src/commands/agent-commands.ts:61-115`) and it already has ONE mechanical,
rule-based assignment of task-to-tier: `assignTier`/`decideDispatchModel` in
`src/gdskills/model-tier.ts:656-767`, surfaced as `keryx review tier`
(`src/commands/review.ts:767-808`). That assignment is a hand-written
decision tree over signals an orchestrator already has in hand (diff size,
finding count, verifier method, "forced strategy change", "has a security
finding" — `TierSignals`, `model-tier.ts:591-613`). It works, but it is
opaque to tune (raising a threshold means editing and re-shipping code), it
only covers the review pipeline's dispatch decision, and it cannot use
anything it was not explicitly coded to read.

The operator's actual ask: when several providers and models of different
strength and cost are connected, something should decide **which model
handles which task**, using TypeSafe's Jev model — a small, fast,
non-generative "System One" classifier purpose-built for exactly this kind
of triage decision (see §3, "What Jev is").

## 2. Goals

1. Add a **routing decision** that, given a task description and the set of
   currently connured providers/models, recommends a tier (and optionally a
   concrete provider/model) using Jev, wherever keryx already has a
   task-to-model decision point.
2. Make the decision **visible and explainable** in the TUI before and
   after it is used — not a silent background reassignment.
3. Make it **opt-in**, **overridable**, and **safe to lose** — Jev being
   slow, wrong, unreachable, or disabled must never block a turn; it must
   degrade to exactly what keryx does today.
4. Keep the decision **separate from the provider abstraction**: routing is
   "which model for this task", not "how do I talk to a model" — those are
   different concerns and should not share an interface (see §6).
5. Give the operator a way to **inspect and reason about** a routing call
   from the CLI (`keryx route explain`) without spending it inside a live
   session.

## Non-goals (this version)

- Replacing `assignTier`'s rule-based tiering. It stays; Jev is an
  additional, optional signal source layered beside it (§4.5), not a
  rewrite of `src/gdskills/model-tier.ts`.
- Routing *within* a single provider's own model family beyond what the
  tier catalogue already resolves (`rankDiscoveredModels`,
  `model-tier.ts:314-421`) — Jev picks a tier/provider preference; ranking a
  concrete model id inside that tier is left to the existing ranking logic.
- Fine-tuning or training a custom router (RouteLLM-style matrix
  factorization/BERT classifiers — see §12). Jev is a hosted, pre-trained
  decision model reached over the network; keryx does not train anything.
- Routing `/delegate`'s external-agent-CLI dispatch
  (`src/commands/agent-commands.ts:255-263`) — that command hands a task to
  a *different agent binary*, not a model choice within keryx's own
  provider layer, and is out of scope.
- A general-purpose "ask an LLM a structured question" framework. The new
  port (§6) is scoped to routing/tiering questions; broader structured-
  decision use cases are a possible future extension, not this version's
  job.

## 3. What Jev is (researched 2026-09-25; verify before build — see §13)

TypeSafe's Jev is a "System One" **structured-decision** model, not a
generative one. Versions `jev-1.13` and `jev-latest`, released 2026-09-15.

- It never writes prose. It takes a `state` (free text describing the
  situation) and `questions` (a map of question objects), and returns typed
  `answers`.
- A question is `noul` (returns a probability 0..1) or `choice` (picks one
  of the question's named `criteria`). A `Score` question type is mentioned
  by the vendor without a documented shape.
- Endpoint: `POST https://openrouter.ai/api/v1/systemone`,
  `Authorization: Bearer <OPENROUTER_API_KEY>`.
  Request: `{ model, state, questions: { key: { type, instructions,
  criteria? } } }`. Response: `{ id, model, provider, answers: { key: {
  type, noul|choice } }, usage: { input_tokens, output_tokens, cost } }`.
  Confirmed against OpenRouter's own TypeSafe SDK guide
  (`https://openrouter.ai/docs/guides/community/typesafe-sdk`) on
  2026-09-25. TypeSafe also has its own API; `TYPESAFE_BASE_URL` is an env
  var some integrations expect for that path — not used by this design,
  which only speaks OpenRouter's `/systemone` route (§6).
- Budget: 64k tokens per request, `state` + `questions` combined
  (independently reported by `ayautomate.com`, not on OpenRouter's own
  pages — treat as vendor-adjacent, not primary-source).
- Price: $0.042 per million input tokens; output is free (no text is
  generated). Same source.
- Latency: vendor claims 70–500 ms; an independent measurement (791 calls
  via OpenRouter) found a 0.33 s median and a 1.42 s max. Same source.
- Vendor use cases: routing, classification, triage, agent tool-call
  gating, context filtering. Explicitly **not** suited to generation, code
  review, long documents, or open-ended reasoning — the vendor's own
  wording: it "does not write text, it does not read images."

## 4. Users and scenarios

**Primary user**: the operator running keryx interactively (TUI or
readline) or unattended (scheduled tasks, `flow-next` dispatch), who has
connected 2+ providers of different cost/strength and wants keryx to stop
defaulting every turn to whatever model the session happened to start on.

### Scenario A — interactive main-agent turn
The operator is chatting in the TUI on `anthropic/claude-...`. They type a
one-line "rename this variable everywhere" task. Routing (if opted in)
proposes `light` tier / a cheaper connected model; the operator sees the
proposal in the sidebar before the turn dispatches and can accept, ignore,
or override.

### Scenario B — subagent spawn
The main agent calls `spawn_subagent` for a bounded, well-scoped
sub-task. Today the child inherits the parent's model
(`ParentModelContext`, `src/harness/child/model.ts:32-36`) unless the
dispatcher names an explicit provider/model or tier
(`ChildModelRequest`, `model.ts:43-46`). Routing supplies a `tier` (or
`explicit`) `ChildModelRequest` computed from the child's own task
description, going through the *same* fail-closed gates
(`resolveChildModel`, `model.ts:156-` — G1 allowlist, G2 network/trust, G3
classifiable) that every other model request already passes through.

### Scenario C — unattended run (schedule / flow-next / trigger)
A scheduled task or `flow-next` dispatch carries its own provider and model
today (`src/trigger/config.ts`, `src/commands/trigger-dispatch.ts`) —
including its own `rates.inputUsdPerMTok`/`outputUsdPerMTok` for spend
accounting (`trigger/config.ts:561-564`). Routing can propose a
tier/model at dispatch-authoring time (`keryx route explain`, §9) for the
operator to bake into the dispatch document — it does not run live inside
an unattended dispatch in this version (§5, "fallback" and §11 risks).

### Scenario D — review-pipeline dispatch
`keryx review tier` already computes a tier per round. This version adds
Jev as one more `tier_reason` input alongside the existing signals (§4.5),
never as a silent replacement of the existing arithmetic.

## 5. The routing decision

### 5.1 What is routed (this version)

- **In scope**: `spawn_subagent` dispatches (Scenario B), and
  `keryx review tier`'s dispatch-model computation (Scenario D) as an
  additional signal.
- **Advisory / explain-only in this version**: the interactive main-agent
  turn (Scenario A) and unattended dispatch authoring (Scenario C) get a
  visible recommendation (`keryx route explain`, TUI proposal) that the
  operator or orchestrator acts on manually. Auto-applying a routing
  decision to a *live, already-started* main-agent session or to an
  unattended run with no human in the loop is deferred (§11, §14 open
  questions) — those are exactly the two places a wrong or hallucinated
  routing call is hardest to catch before money and time are spent.

### 5.2 The "state" sent to Jev

The `state` string is built from: the task/prompt text for the unit being
routed (subagent dispatch instructions, or the text passed to
`keryx route explain`), plus a compact, structured summary of context
signals keryx already computes for the existing tier logic — `TierSignals`
equivalents: diff size, finding count, verifier method, security-finding
flag, tree depth — NOT the full transcript, tool outputs, or file
contents. Building `state` is the redaction boundary (§8): only text the
operator has explicitly opted to route ever leaves the process.

### 5.3 The question design

Two Jev questions per call, mirroring the existing `ModelTier` vocabulary
(`MODEL_TIERS = ["light", "standard", "deep"]`, `model-tier.ts:87`) so the
result composes with the existing tier machinery instead of inventing a
parallel vocabulary:

- `tier` (`choice`, criteria = `light`/`standard`/`deep`): "How much
  reasoning capability does this task need?"
- `confidence` (`noul`): "How confident are you in that tier assignment?" —
  used for the fallback threshold (§5.4) and shown in the TUI (§9).

A `catalogue` fact (the connected providers/tiers, from `configuredProviders`
+ `familyOf`, `src/commands/providers.ts:1031-1044` and
`rankDiscoveredModels`, `model-tier.ts:314-421`) is folded into `state` as
plain text, not asked as a `choice` over provider names — Jev's `criteria`
are fixed at request time and the operator's provider set changes, whereas
the three-tier vocabulary is stable and provider-agnostic. Mapping the
chosen tier onto an actual connected model is done by the *existing*
`resolveTierModel`/`rankDiscoveredModels` code, not by Jev.

### 5.4 Fallback when Jev is unavailable

Fail-closed to "no change": on any error, timeout, malformed response, or
`confidence` below a configurable threshold (default 0.6), the router
returns `{ tier: undefined, reason: "<why>" }` and the caller falls back to
whatever it does today — `assignTier`'s rule-based tier for review dispatch,
plain inheritance for subagent spawn. A degraded Jev call must never
retry against a different model, never block past a short timeout (default
2s, well above the 1.42s worst case measured independently — §3), and
never be treated as equivalent to an explicit operator choice.

### 5.5 Explicit operator override

An explicit `tier`/`provider`/`model` from the caller — a `--tier`/
`--provider`/`--model` flag, a dispatch document's own `model` block
(`DispatchModelBlock`, `model.ts:120-125`), or `KERYX_SUBAGENT_MODEL` — always
wins over a Jev recommendation, at the same resolution-order rung
`resolveChildModel` already uses (env override -> explicit -> tier ->
inherit, `model.ts:161-`). Routing only ever fills the `tier` rung when
nothing more specific was said.

## 6. A new "decision port" — separate from `ProviderPort`

`ProviderPort` (`src/harness/provider/types.ts:345-353`) is "stream a
model's normalized text/tool-call output for a request" — an SDK-free
adapter over a chat/completion wire protocol. Jev answers a completely
different question shape (typed multiple-choice/probability answers, no
streaming, no messages, no tool calls) over a completely different wire
protocol (`POST /api/v1/systemone`, not chat completions). Bolting it onto
`ProviderPort` would mean either inventing a fake `NormalizedEvent` stream
for a non-streaming, non-text response, or leaving most of the interface
unimplementable — both wrong.

Keryx already has a naming and structural convention for exactly this kind
of narrow, injectable seam: `McpClientPort`
(`src/mcp-client/types.ts:152`), `MetaprojectPort`
(`src/harness/tool/metaproject-port.ts:725`), `ManagedFlowPort`
(`src/harness/flow/managed-flow-port.ts:81`), `ExternalSpawnPort`
(`src/harness/external/supervise.ts:108`), `WorktreePort`
(`src/harness/child/worktree.ts:105`). This version adds one more:

```ts
// src/harness/decision/decision-port.ts (new)
export interface DecisionQuestion {
  type: "noul" | "choice";
  instructions: string;
  criteria?: Record<string, string>; // choice only
}

export interface DecisionAnswer {
  type: "noul" | "choice";
  noul?: number;      // 0..1
  choice?: string;
}

export interface DecisionPort {
  decide(
    state: string,
    questions: Record<string, DecisionQuestion>,
  ): Promise<{
    answers: Record<string, DecisionAnswer>;
    usage: { inputTokens: number; outputTokens: number; costUsd: number };
  }>;
}
```

`JevDecisionPort` (the one implementation this version ships) constructs
this over `fetch` + `OPENROUTER_API_KEY`, injected the same way
`AnthropicProvider`/`OllamaProvider` are (`opts.fetch`,
`make-provider.ts:42-58`) — never a real network call in a unit test. A
`FakeDecisionPort` (mirrors `FakeProvider`,
`src/harness/provider/fake-provider.ts`) is the default when routing is
off or unconfigured, and always returns "no recommendation" rather than a
guessed answer.

## 7. Configuration and opt-in

- Off by default. Enabled per project via `.metaproject`/keryx config (a
  `routing` block, sibling to `security.config.json`/`health.config.json`)
  or `KERYX_ROUTING_ENABLED=1` for a quick trial — same "config file, env
  var escape hatch" pattern the rest of keryx uses
  (`gdctx.config.json`, `security.config.json`).
- Requires `OPENROUTER_API_KEY` to be present (the same credential
  `openrouter` compat-provider entries already use,
  `providers.ts:312-321`, `shell-config.ts:253-254`) — routing does not
  introduce a second OpenRouter credential, and is simply unavailable
  (falls back per §5.4) when the key is absent, exactly like every other
  OpenRouter-backed feature today.
- A confidence threshold, a per-call timeout, and a session/project spend
  cap for routing calls are all configurable (defaults in §10).
- Which surfaces route (subagent spawn / review tier / explain-only) are
  independently toggleable, since §5.1 already scopes Scenario A/C to
  explain-only for this version.

## 8. Privacy and redaction

The task text in `state` leaves the process and goes to OpenRouter, which
routes to TypeSafe. This is new data-egress the operator must consent to
separately from a normal model call, even for someone who already sends
task text to Anthropic/OpenAI/etc., because:

- It is a *second* vendor relationship per turn (OpenRouter + TypeSafe)
  the operator may not have reasoned about.
- It runs even for turns whose primary model is fully local (Ollama) —
  routing would otherwise leak a task description off-box for a session
  the operator chose specifically to keep local.

Policy:

1. Opt-in is required (§7) and is separate from any existing provider
   credential — connecting `openrouter` for chat use does not implicitly
   enable routing.
2. `state` is passed through the existing redaction pipeline before it
   ever reaches `JevDecisionPort` —
   `redactSensitiveText(text)` (`src/security/redact.ts:128`, backed by
   `detectSecrets`/`detectPii`/`detectExfil`) runs on the task text and the
   context summary before assembly, not after.
3. `state` never includes file contents, tool output, or transcript beyond
   the immediate task description and the small structured signal summary
   (§5.2) — this is a stricter subset of what a normal model turn sends,
   by construction, not an afterthought.
4. An unattended run (Scenario C) sending `state` off-box crosses the same
   network boundary the sandbox's egress allowlist already governs
   (`network: "allowlist"`, `src/harness/process/sandbox/unattended.ts:59-68`)
   — `openrouter.ai` must be an explicit allowlist entry for a sandboxed
   run to reach it at all; routing does not get a silent bypass of that
   allowlist.
5. Every `state` payload and the resulting `answers`/`usage` are logged
   locally (governance-report-adjacent, §10) so the operator can audit
   exactly what was sent, after the fact, per call.

## 9. TUI visibility

Per the standing project rule that every feature is visible in the TUI
with both a sidebar element and a modal:

- **Sidebar**: a `Routing` row, mounted in `sidebarTop` after the existing
  `Model` row (`sb-model-k`/`sb-model-v`, `src/tui/tui-shell.ts:3857-3858`),
  following the same `mount*Panel(otui, renderer, parent, opts) ->
  {refresh, dispose}` shape as `mountGovernancePanel`/`mountTriggersPanel`
  (`.metaproject/flows/300-.../acceptance-criteria.md` AC1/AC4). States:
  `off` (routing disabled), `idle`, `deciding…`, `<tier> (<confidence>%) —
  click for why`, `unavailable — fallback used`, `error — click for
  reason`.
- **Modal**: opened from the sidebar row or a `/routing` command. Shows,
  per recent decision: the `state` sent (redacted), both questions and
  answers (`tier` choice + `confidence` noul), the resolved tier -> model
  mapping, `usage` (tokens + cost), latency, whether it was accepted,
  overridden, or fell back, and the reason when it fell back. This is the
  same shape as the Governance/Triggers modals
  (`.metaproject/flows/300-.../acceptance-criteria.md` AC3/AC5) — list +
  detail, keyboard-navigable, closed with Esc.
- **Override affordance**: from the modal, the operator can force a
  different tier/model for the next call of the same kind (subagent spawn
  / review tier), recorded as an explicit override (§5.5) — never silently
  discarded on the next automatic recommendation.
- The `Usage`/`Balance` rows already under `Model`
  (`tui-shell.ts:3877-3890`) get routing's own token/cost folded into the
  session's running total, distinguished from generation spend the same
  way `spendFromTokens` already separates in/out rates
  (`src/review/caps.ts:319-334`).

## 10. Cost and latency budget

- Jev's own price ($0.042/M input, output free) is negligible next to a
  single generation call, but it is not zero, and it is a *second* network
  round-trip added to the critical path of whatever it advises. Default
  policy: routing runs only for dispatches expected to cost more than the
  routing call itself would (a size/scope floor mirroring `assignTier`'s
  existing `LIGHT_MAX_FINDINGS`/`LIGHT_MAX_DIFF_LINES` thresholds,
  `model-tier.ts:625-627`) — routing a trivial one-line subagent task is
  not worth the extra round trip.
- Default timeout: 2000 ms (comfortably above the 1.42 s worst case
  independently measured, §3); on timeout, fall back per §5.4.
- Default per-project routing spend cap, tracked the same way the review
  budget's `spend_ceiling`/`spend_status` are (`src/review/caps.ts`,
  `keryx review budget`) — a separate, small ceiling from the generation
  spend ceiling, since the two have very different unit costs.
- 64k-token `state`+`questions` budget (§3): the router truncates/errors
  rather than silently dropping context past that limit; a truncated
  `state` is flagged in the modal (§9), never presented as a full-context
  decision.

## 11. Risks and honest limits

- **Vendor claims, not verified by keryx**: latency and pricing in §3 are
  vendor and third-party-blog figures as of 2026-09-25, not measured
  against a live key by this team. Confirm before committing to the
  latency/timeout defaults in §10 (§13, §14).
- **Routing mistakes have a different failure mode than a wrong model
  guess today**: a bad Jev call could pick `light` for a task that needed
  `deep`, silently degrading output quality rather than failing loudly.
  Mitigation: confidence threshold + fallback (§5.4), visible in the TUI
  (§9), and Scenario A/C stay explain-only (§5.1) until there is field
  evidence the tier recommendation is trustworthy enough to auto-apply.
- **Prompt injection in `state`**: task text can contain content the
  operator did not author (a subagent's inherited context, a scheduled
  task's templated description). `state` is assembled from
  keryx-controlled fields (§5.2), redacted (§8), and Jev's own response
  shape is a closed enum/probability — there is no free-text field an
  injected instruction could steer beyond nudging the `tier`/`confidence`
  values themselves, which the fallback threshold already treats as
  untrusted advisory input, not a command.
- **A second vendor dependency** for a core control-flow decision:
  OpenRouter's and TypeSafe's own availability now sits on the path of a
  turn that opted into routing. §5.4's fallback is the mitigation; routing
  must never become a hard dependency for any turn to proceed.
- **`Score` question type is unspecified**: the vendor's own materials
  mention it without a documented shape (§3). Not used in this version's
  question design (§5.3); do not add it speculatively.
- **Scope creep risk**: it is tempting to route every main-agent turn
  automatically. This PRD deliberately keeps Scenario A/C explain-only
  (§5.1) until metrics (§12) show the recommendation is worth auto-
  applying to a live, already-paid-for session.

## 12. Metrics

Whether routing helps, evaluated per project once enabled:

1. **Tier-agreement rate**: how often Jev's recommended tier matches what
   `assignTier`'s rule-based path would have picked, and how often it
   diverges — surfaced from `tier_reasons` already logged today
   (`review.ts:784`) plus the new Jev reason.
2. **Override rate**: how often the operator overrides a routing
   recommendation (§5.5, tracked from the modal) — a high override rate is
   a direct signal the recommendation is not trusted or not good.
3. **Cost delta**: total generation spend with routing enabled vs. a
   comparable window without it, using the existing `spendFromTokens`
   accounting (`src/review/caps.ts:319-334`) already wired for review/
   trigger spend.
4. **Routing overhead**: added latency (routing call time) and added cost
   (Jev's own usage.cost) per routed decision, from the TUI modal log (§9).
5. **Fallback rate**: how often §5.4's fallback fires (timeout, error, low
   confidence) — a high rate means routing is not usable in practice for
   this operator's network/environment, independent of whether its
   *decisions* are good when it does answer.

This is intentionally modest and reuses existing accounting rather than
building a new analytics surface — cf. the "prior art" caution in §14
about not over-building before the first real usage signal.

## 13. Prior art (brief)

- **RouteLLM** (`lm-sys/routellm`, arXiv:2406.18665) — trains small
  binary/matrix-factorization routers on human preference data to decide
  strong-vs-weak model per prompt; reports ~40% fewer GPT-4 calls at <5%
  MT-Bench degradation. Keryx's approach differs in kind: Jev is a hosted,
  pre-trained decision model reached over the network, not a
  locally-trained classifier — no training data or pipeline to maintain,
  at the cost of a per-call network dependency RouteLLM's local router
  does not have.
- **OpenRouter Auto Router** — picks a model per prompt from aggregate
  marketplace usage patterns over a trailing 7-day window; its
  `cost_quality_tradeoff` parameter is deprecated. Different mechanism
  (market-driven vs. task-classification) and different scope (picks a
  concrete model across all of OpenRouter, not a tier within keryx's own
  connected-provider set).
- Both confirm a router-as-cost-control pattern is established practice;
  neither is used directly — Jev was the operator's explicit choice.

## 14. Requirements (numbered, verifiable)

- R1: A `DecisionPort` interface exists at
  `src/harness/decision/decision-port.ts`, structurally independent of
  `ProviderPort` (no shared method signatures forced onto either), with a
  `JevDecisionPort` implementation and a `FakeDecisionPort` default.
- R2: `JevDecisionPort` makes exactly one `POST
  https://openrouter.ai/api/v1/systemone` call per `decide()`, using
  injected `fetch` (never `globalThis.fetch` directly) and
  `OPENROUTER_API_KEY` resolved the same way `providers.ts` resolves it
  for the `openrouter` compat entry.
- R3: Routing is off by default; a project must opt in via config or
  `KERYX_ROUTING_ENABLED=1` before `JevDecisionPort` is ever constructed
  with a real grant.
- R4: `state` passed to `decide()` is run through
  `redactSensitiveText` (`src/security/redact.ts:128`) before assembly,
  verified by a test asserting a planted secret/PII pattern never reaches
  the constructed request body.
- R5: An explicit operator override (flag, dispatch `model` block, or
  `KERYX_SUBAGENT_MODEL`) always wins over a routing recommendation,
  verified by a test that supplies both and asserts the explicit value is
  used.
- R6: On timeout (default 2000ms, configurable), network error, malformed
  response, or `confidence` below the configured threshold (default 0.6),
  routing returns "no recommendation" and the caller's existing behavior
  (rule-based tier / inheritance) is unchanged — verified by a test per
  failure mode, none of which touch the network.
- R7: A subagent spawn that used a routing-supplied tier still passes
  through `resolveChildModel`'s G1 (allowlist)/G2 (network/trust)/G3
  (classifiable) gates unmodified — verified by a test where a routed tier
  resolves to a provider outside the allowlist and is denied exactly as an
  explicit request would be.
- R8: `keryx review tier` accepts routing as an additional signal and
  reports it distinctly in `tier_reasons`/`--json` output without changing
  behavior when routing is disabled or falls back — a snapshot test with
  routing off reproduces today's exact output.
- R9: The TUI sidebar shows a `Routing` row in every state named in §9,
  mounted after `Model`, tested with a fixture per state
  (`otui.testing.createTestRenderer`-style, matching
  `mountGovernancePanel`'s test pattern).
- R10: A routing modal shows the `state` sent (post-redaction), both
  questions/answers, resolved tier->model mapping, usage/cost/latency, and
  accept/override/fallback status for the most recent N decisions,
  keyboard-navigable and closed with Esc.
- R11: `keryx route explain "<task>"` prints the routing decision (tier,
  confidence, resolved model if any, usage, latency, fallback reason if
  any) for a one-off task description without dispatching any turn or
  subagent, network-free in `--dry-run`/test mode via an injected decision
  port.
- R12: A per-project routing spend ceiling is enforced the same way
  `keryx review budget`'s ceiling is (`src/review/caps.ts`), with its own
  `spend_status`, separate from the generation spend ceiling.
- R13: An unattended (sandboxed) run that would call `JevDecisionPort`
  refuses with a named reason (not a silent skip) unless
  `openrouter.ai` is present in that run's network allowlist — verified by
  a test against `src/harness/process/sandbox/unattended.ts`'s allowlist
  shape.
- R14: No test in the new code exercises a real network call; every
  `JevDecisionPort` test injects `fetch` and asserts on the constructed
  request/parsed response, mirroring `anthropic-provider.test.ts`'s
  pattern.
- R15: `docs/docs/cli-reference.md`, `README.md`, and the docs site are
  updated to document `keryx route explain`, the `Routing` sidebar
  section/modal, the opt-in config, and the fallback behavior — consistent
  with the project's "docs stay current with code" rule.

## Related modules

- [Keryx Provider Breadth](../keryx-provider-breadth/README.md) —
  `ProviderPort` adapters this design deliberately does not extend.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — credential
  acquisition; routing reuses `OPENROUTER_API_KEY` resolution, adds no new
  auth method.
- [Keryx Multi-Agent Engine] (see `src/harness/child/model.ts`,
  `src/harness/child/orchestrate.ts`) — `ChildModelRequest`/
  `resolveChildModel`, the gate chain routing's subagent output must pass
  through unmodified (R7).
