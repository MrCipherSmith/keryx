# Keryx Antigravity Agent

Version: 0.1.0

## Purpose

Let keryx delegate bounded work to Google's **Antigravity CLI** (`agy`) as an
external child agent, so an operator's Google AI Pro / Ultra subscription does
the work while keryx keeps policy, budget, isolation, monitoring and
completion — the same contract `codex-cli`, `claude-cli` and `gemini-acp`
already follow in [keryx-external-agent-runtime](../keryx-external-agent-runtime/README.md).

The subscription is reached only by running Google's own client, logged in by
the operator. keryx never reads, copies, refreshes or proxies a Google
credential. That is the line the Antigravity terms draw: *"Using third party
software, tools, or services to access the Service (e.g. using OpenClaw with
Antigravity OAuth) is a breach of this Agreement."* Driving the official binary
through its documented headless mode is a different act from lifting its OAuth
token into another client; the [BRD](brd.md) records why the difference matters
and what residual risk remains.

## Status

**implemented (read-only) — flow 357, 2026-09-28.**

Registry entry, line-stream codec, credential allowlist entry (empty — `agy`
has no API-key auth path), `/external` block-list entry, one-time TTY consent
(`externalAgents.consent["antigravity-cli"]`), and `keryx agents external run
antigravity-cli` are all shipped. `worktree-write` is declared in the registry
(the CLI itself supports it) and refused at runtime with `not-implemented`,
the same split every other line-stream agent uses — write mode ships when
line-stream `worktree-write` does, for all three agents at once.

A live read-only run through keryx's own `agents external run` path is
recorded under `fixtures/external/live/antigravity-cli/2026-09-28/`
(`agy` 1.2.12). `agy` was installed and already logged in on the build
machine at implementation time; the install/login/consent/data-collection
steps for an operator starting from nothing are in
[docs/docs/harness.md](../../docs/harness.md#external-children-a-vendor-cli-as-a-child-agent).

## Document index

- [README.md](README.md) — this file.
- [brd.md](brd.md) — business context, stakeholders, objectives, success metrics, constraints, terms-of-service analysis, risks, decision.
- [prd.md](prd.md) — problem, goal, users, requirements, success criteria, risks, recommendation.
- [specification.md](specification.md) — registry entry, codec, argv, sandbox and permission mapping, environment, privacy gate, surfaces, data contracts, acceptance criteria.

## Scope

- One registry entry `antigravity-cli` and one line-stream codec for
  `agy -p … --output-format stream-json`.
- Read-only first. `worktree-write` follows when line-stream agents gain it:
  today `worktree-write` is implemented only for ACP agents (`IMPLEMENTED_ACP_SANDBOX_MODES`); line-stream (codec) agents refuse it with `not-implemented`, and `agy` is a line-stream agent. Declared in the registry, refused
  at runtime until then — the same split the other codec agents use.
- Token accounting from the `usage` field; resume through `--conversation`.
- A privacy gate: `agy` sends prompts and agent actions to Google by default,
  so `antigravity-cli` joins the `/external` block-list defaults; with
  `/external off` no private work is dispatched to it.
- A live, recorded run (this is also part of P0 W1,
  [keryx-p0-improvements](../keryx-p0-improvements/README.md)).

## Non-goals

- Any use of Antigravity's or Gemini CLI's OAuth token outside Google's own
  binary — no token import, no "Login with Google" in keryx, no proxy.
- An ACP adapter. `agy` has no native ACP (feature request
  google-antigravity/antigravity-cli#31 is open with no maintainer reply);
  third-party ACP wrappers exist but are not needed — the stream-json mode
  carries what keryx reads.
- Replacing the `gemini` API-key provider. It stays the route for
  keryx's own in-process turns on Gemini models.

## Related modules and packages

- `src/harness/external/` — registry, codecs, env builder, supervision, runtime.
- [keryx-external-agent-runtime](../keryx-external-agent-runtime/README.md) — the contract this entry joins (decisions D-04, D-06, D-08; security-policy §1–§2).
- [keryx-p0-improvements](../keryx-p0-improvements/README.md) W1 — external agents run for real.
- `/external` switch (0.3.11) — per-vendor privacy gate.
- [keryx-audit-remediation](../keryx-audit-remediation/README.md) — the credential strip for external children (#770 AC1) applies unchanged.
