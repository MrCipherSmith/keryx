# Keryx Project Agent Harness Provider Protocol
Version: 0.2.0

## Purpose

Specify the provider-neutral boundary between the Keryx harness and model
providers. The protocol keeps Anthropic, OpenAI-compatible, local, and future
providers replaceable.

## Provider Adapter Responsibilities

A provider adapter owns:

- authentication lookup from approved configuration;
- endpoint and request serialization;
- provider-specific streaming parser;
- provider error classification;
- usage extraction;
- capability discovery;
- provider request id and rate-limit metadata;
- cancellation of in-flight requests.

It must not own project tools, permissions, sessions, flows, or completion
gates.

## Normalized Request

The runtime request must contain:

- provider and model id;
- system instruction assembled from trusted Keryx policy and project context;
- ordered messages with provenance class;
- tool definitions with schemas and risk metadata;
- temperature/reasoning/verbosity options only when supported;
- max output token budget and total run reservation;
- stream mode and cancellation signal;
- request id and parent run id.

Provider adapters may omit unsupported options but must report the omission.

## Normalized Events

Provider streams normalize to:

- `model_start`;
- `text_delta`;
- `tool_call_start`;
- `tool_call_delta`;
- `tool_call_end`;
- `usage_update`;
- `model_end`;
- `provider_error`.

Events must be sequence-numbered within a request. A malformed stream must
produce a typed provider error and preserve the partial event trail.

Each attempt has a stable attempt id and either completes, fails, is cancelled,
or is abandoned after partial output. A provider must preserve unknown provider
extensions in a namespaced, redacted field rather than discard them. A tool call
is accepted only after its complete JSON input validates; partial deltas never
authorize execution or retry reuse.

## Tool Call Semantics

The runtime must never execute a partially streamed tool call. It buffers a
call until:

1. the provider marks it complete;
2. the JSON input parses;
3. the input validates against the registered tool schema;
4. policy resolves the call.

Parallel tool calls are allowed only when the provider advertises support and
the runtime can reserve concurrency and budget for every call.

## Error Taxonomy

| Error | Retry | Default action |
|---|---:|---|
| authentication | no | stop and request credential configuration |
| invalid request | no | persist and surface provider detail safely |
| rate limit | yes | bounded backoff within run budget |
| overloaded/5xx | yes | bounded backoff and retry budget |
| context overflow | conditional | compact/rebuild context once, then stop |
| unavailable/network | conditional | retry only if policy permits network |
| cancelled | no | finalize as cancelled |
| malformed response | limited | retry once, then fail provider task |

Retry delays must be cancellable and persisted as events. No provider adapter
may retry indefinitely.

## Provider Capability Matrix

The runtime should expose capabilities as data:

```text
streaming
tool_calls
parallel_tool_calls
structured_output
reasoning_metadata
prompt_caching
vision
token_counting
model_listing
```

The absence of a capability must degrade to a documented fallback. The runtime
must never claim exact token counts if the provider did not report them.

Provider descriptors also declare storage, continuation, retention, deletion,
background-operation, cancellation, and trace-capture capabilities. Provider
storage and continuation are off by default, excluded from Release 0, and may
only be enabled later through a dedicated capability, policy, retention, and
deletion contract. System and project instructions are reconstructed locally for
each request; the local Keryx event/session log remains authoritative state.

## Credentials

- Read credentials only from approved environment variables or user config.
- Never include credential values in session events, prompts, errors, or
  metrics.
- Provider config may contain a reference to a secret, not the secret itself.
- A missing credential is a typed environment blocker.

## Provider Testing

Every provider adapter requires:

- fixture-based streaming parser tests;
- tool-call buffering tests;
- malformed event tests;
- retry classification tests;
- cancellation tests;
- usage and unknown-value tests;
- secret-redaction tests;
- an offline fake provider used by harness loop tests.

The fake-provider transcript is versioned and uses deterministic time, ids, and
expected normalized events. Fixtures cover partial or malformed streams,
unknown events, usage corrections, permanent/transient failures, cancellation,
and retry boundaries. Real provider behavior is evidence-linked to a pinned
source revision and refresh date, not copied as a provider-neutral contract.
