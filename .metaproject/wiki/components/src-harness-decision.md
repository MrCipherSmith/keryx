# Module src/harness/decision

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/harness/decision` is the decision-port layer: single-question clients and classifiers that answer a routing or triage question about a piece of text, such as which routing category a `keryx shell` request belongs to. It groups 12 file(s). Depends on `src/harness/routing`, `src/lib`, `src/harness/provider`. Exposes 20 public symbol(s).

## Overview

`src/harness/decision` owns the decision port: small clients and classifiers that ask a model one bounded question and get back a typed answer, rather than streaming a chat completion. Its main consumer is the keryx shell's routing classifier, which picks a routing category for a request and falls back through progressively simpler stages. The shared Jev/System-One HTTP client also lives here, so other Jev-backed features reuse one transport instead of writing their own.

## How it works

The module has three layers. The transport layer is `jev-client.ts`, whose `callJevSystemOne` POSTs `{model, state, questions}` to `JEV_ENDPOINT` through an injectable `fetch`. Before any network call it checks the external-provider block (`ExternalBlockedError`), resolves a credential (`resolveJevApiKeyResolution`: the `OPENROUTER_API_KEY` env var, then the saved key), and preflights the 64k state+questions budget. It then loops over `attemptJevRequest`, retrying 429 and 5xx responses and thrown network errors up to `JEV_MAX_ATTEMPTS` with a short backoff that honours `Retry-After` up to `JEV_RETRY_AFTER_CAP_MS`. Timeouts and other 4xx responses are never retried. Every requested answer key is checked by `validatedAnswer`, so a missing or out-of-range answer throws `JevAnswerValidationError` instead of being defaulted.

The classifier layer sits on the `TaskClassifier` interface in `classifier.ts`. Its `classify` method never throws; it resolves to a `TaskClassifierResult` that is either `{ok: true, category, confidence, source}` or `{ok: false, reason}`. `NullClassifier` is the terminal stage that always declines. `JevTaskClassifier` (`jev-classifier.ts`) asks one `choice` question over per-category criteria plus one `noul` confidence question, and refuses any pick below `DEFAULT_JEV_CLASSIFIER_CONFIDENCE_THRESHOLD` (0.45). `MainModelTaskClassifier` (`main-model-classifier.ts`) sends a 16-token request through `runModelTurn` to the session's own provider and model, and reports a fixed confidence of `MAIN_MODEL_CLASSIFIER_CONFIDENCE` (0.7) because a one-token reply carries no real probability.

The orchestration layer is `classify-turn.ts`. `classifyTurn` runs the chain deterministic shortcut, then Jev (only when `jevEnabled` is set and a credential resolves), then the main-model classifier (only when a fallback model exists), then `NullClassifier`. All stages share one deadline of `CLASSIFY_TURN_TIMEOUT_MS` (3s). When a fallback exists, Jev gets at most half of that budget. Each stage is wrapped by `withTimeout`, which races the stage against an abort timer and an external signal, so a hung stage degrades to the next one.

## Key concepts

- **Decision port**: a one-question, bounded-answer call. It is deliberately not a `ProviderPort`, because Jev's `noul` and `choice` answers have no chat or completion shape.
- **Routing category** (`RoutingCategory` from `src/harness/routing/table`): the candidate vocabulary a classifier chooses from. A classifier never returns a category outside the list it was given.
- **TaskClassifierResult**: a discriminated `ok` union. The `source` field names the stage that decided, and `usage` carries token and cost figures for accounting.
- **Jev question types**: `noul` returns a probability in 0..1, and `choice` returns one key from a `criteria` record. The default model is `DEFAULT_JEV_MODEL` (`jev-1.13`), pinned so unmeasured classifier accuracy does not drift.
- **Error taxonomy**: `JevCredentialError`, `JevBudgetError`, `JevRequestError` (with `JevAuthRejectedError` for 401), `JevNetworkError`, `JevTimeoutError`, `JevResponseParseError`, `JevResponseShapeError` and `JevAnswerValidationError`. Each names a distinct failure so callers can react differently.
- **Redaction**: `redactSensitiveText` runs on the operator's task text before it is embedded in Jev's `state`, and on vendor error bodies before they reach an Error message.

## Main flows

1. **Routing a shell request.** `classifyTurn(line, categories, opts)` returns `undefined` for a slash-command line or an empty vocabulary. A deterministic match returns at once with confidence 1. Otherwise, when `jevEnabled` is set and a credential resolves, `JevTaskClassifier.classify` redacts the task, builds the `state` string and both questions, and calls `callJevSystemOne`. A pick below threshold is recorded in `trace` and the chain falls through. Next comes `MainModelTaskClassifier` if a fallback exists, and last `NullClassifier`. The `trace` array keeps every stage that was tried.
2. **A Jev call.** `callJevSystemOne` runs the external-switch check, resolves the key, and preflights the budget. It then loops over `attemptJevRequest`, which wires one `AbortController` to both the timeout and any caller signal. A retryable outcome sleeps and continues. A success parses the JSON body, validates each requested answer with `validatedAnswer`, and returns a `JevResult` whose `usage` comes from the successful attempt only, so cost is counted once per call.
3. **Failure containment.** Any error thrown inside a stage, including a timeout, is caught by `withTimeout` and turned into `{ok: false, reason}`. The next stage then runs, and `classifyTurn` never throws into the TUI turn dispatch.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `JEV_ENDPOINT`
- `JEV_MODEL_1_13`
- `JEV_MODEL_LATEST`
- `DEFAULT_JEV_MODEL`
- `JEV_TOKEN_BUDGET`
- `DEFAULT_JEV_TIMEOUT_MS`
- `JEV_MAX_ATTEMPTS`
- `JEV_RETRY_AFTER_CAP_MS`
- `JevSleepFn`
- `JevQuestionType`
- `JevQuestion`
- `JevQuestions`
- `JevRequestInput`
- `JevAnswer`
- `JevUsage`
- `JevResult`
- `JevCredentialError`
- `JevBudgetError`
- `JevRequestError`
- `JevNetworkError`

### Key files

- `src/harness/decision/jev-client.ts` - imported by 18, imports 5
- `src/harness/decision/classify-turn.ts` - imported by 4, imports 6
- `src/harness/decision/jev-classifier.ts` - imported by 3, imports 4
- `src/harness/decision/classifier.ts` - imported by 5, imports 1
- `src/harness/decision/main-model-classifier.ts` - imported by 2, imports 3
- `src/harness/decision/classify-turn.test.ts` - imported by 0, imports 3

### Depends on

- `src/harness/routing` - 5 import(s)
- `src/lib` - 3 import(s)
- `src/harness/provider` - 2 import(s)
- `src/security` - 2 import(s)
- `src/review` - 1 import(s)

### Depended on by

- `src/commands` - 12 import(s)
- `src/tui` - 7 import(s)
- `scripts` - 2 import(s)

### Dependency basis

- Production imports only: 6 import(s) from test file(s) (e.g. `src/harness/decision/classify-turn.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 12
- Cross-module imports: 13

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/routing](src-harness-routing.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/security](src-security.md)
- [Module src/review](src-review.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)
- [Module scripts](scripts.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
