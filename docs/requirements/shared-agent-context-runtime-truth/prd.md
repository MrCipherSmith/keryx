# Shared Agent Context Runtime Truth — PRD
Version: 0.1.0

## Problem

The current SAC read path can produce a valid schema and receipt while giving a
misleading account of selection and freshness:

- policy resolution changes policy attribution but does not constrain the
  actual FWK candidates passed to assembly;
- the runtime baseline selection is not independent from candidate output;
- public adapters do not express required versus optional items, so every item
  becomes mandatory by default;
- positional IDs can resolve to a different resource after manifest reordering;
- an addressed `read` returns the same compact metadata rather than useful,
  bounded detail;
- unpinned evidence can be re-hashed on each read and reported fresh forever;
- receipt token and elapsed-time costs are hard-coded to zero.

These behaviors undermine the main value proposition of SAC: small,
reproducible, evidence-linked context whose omissions and costs are honest.

## Goal

Make every SAC read reproducible and falsifiable: a caller can determine which
plan was executed, which authorized items were selected or omitted, whether the
source changed, what bounded detail was returned, and whether cost is measured
or unknown.

## Users

- An agent entering an unfamiliar workspace under a strict context budget.
- A developer comparing SAC-on and SAC-off behavior.
- An orchestrator deciding whether to request more detail.
- A security or quality reviewer auditing policy attribution and omissions.
- An experiment owner comparing deterministic and candidate retrieval plans.

## Product requirements

- **RT-1 — Independent baseline.** The deterministic baseline plan is computed
  from the authorized request and source descriptors, never copied from a
  candidate evaluation result.
- **RT-2 — Executed selection.** The plan's selected IDs constrain the exact
  candidates passed to canonical Context Operations assembly.
- **RT-3 — Closed selection.** A plan can only select baseline-authorized IDs;
  unknown, duplicate, hidden, withdrawn, or stale-forbidden IDs fail closed.
- **RT-4 — Mandatory core.** Identity, scope, mandatory policies, and explicit
  task-critical items form a small configured mandatory core.
- **RT-5 — Ranked optional context.** All other visible items are optional and
  deterministically ordered by explicit signals. Budget omission returns a
  successful `partial` result with every omitted optional ID.
- **RT-6 — Stable identity.** FWK IDs are opaque and stable for the same owner,
  kind, canonical reference, and owner revision; they never depend on array
  position.
- **RT-7 — Real detail.** Progressive read returns owner-sanitized, bounded
  detail or an explicit `metadata-only` capability result. It is not allowed to
  silently return the overview projection as detail.
- **RT-8 — Honest freshness.** `fresh` requires a stored observation revision
  and a current owner revision comparison. Unpinned sources are `untracked`, not
  fresh. Changes produce explicit `changed` or `stale` state.
- **RT-9 — Honest cost.** Measured token/time/tool/storage values are recorded;
  unavailable measurements are represented as `unknown`, never numeric zero.
- **RT-10 — Explanations.** Metadata-only output explains selection,
  omission, overflow, and drift without exposing hidden references.
- **RT-11 — Surface parity.** CLI, stdio MCP, and shell use the same operation
  contract, defaults, normalized output, and authorization decision.
- **RT-12 — Safe experiment boundary.** Candidate retrieval stays shadow-only
  until it demonstrably changes output and passes independent outcome and
  security gates.

## Success criteria

- A candidate strict subset produces a correspondingly smaller FWK manifest.
- A workspace with 33 optional items and `maxItems=32` succeeds with exactly one
  explicit omission.
- Reordering resources does not change item IDs or addressed-read meaning.
- Editing an unpinned source never leaves the item reported as fresh.
- Every successful progressive read returns useful bounded detail or an honest
  metadata-only status.
- Receipts contain measured values or `unknown`; no fabricated zero appears.
- No candidate expands baseline authorization, roles, security gates, or Flow
  state.

## Risks

- Stable-ID migration can invalidate old receipts and bookmarks.
- Owner detail adapters may require coordinated contracts in several modules.
- Ranking signals can accidentally encode hidden-source existence.
- Measuring cost on every read can add latency and more receipt writes.
- Changing default required/optional behavior can alter existing tests and
  scripts that rely on overflow.

## Recommendation

Deliver a deterministic correction before any learned retrieval. Freeze a
small mandatory core, make all remaining items deterministically optional,
introduce stable IDs and honest freshness/cost, and prove output-changing
selection with end-to-end tests. Keep the current learned candidate disabled
until this baseline is complete and measured.
