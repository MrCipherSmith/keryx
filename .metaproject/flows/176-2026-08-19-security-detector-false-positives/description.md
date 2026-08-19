# Security detectors: ISO-dated flow prefixes masked as phones, dotted/hex credentials under-masked, and agent tool-call nudge noise

Status: formalized
Source: user description (evidence: keryx session `4a24a760`, project `/home/altsay/keryx`, 2026-08-19)

## Problem

Three defects observed in one real agent session (`b4beb664-…-0aaa4a24a760`, 178
messages) and reproduced against the current working tree.

**P1 — a flow directory name is masked as a phone number (blocking).**
Flow packages are named `NNN-YYYY-MM-DD-<slug>`. The `pii.phone` rule
(`src/security/detect/pii.ts`) treats the `001-2026-07-09` prefix as a dialling
sequence: 11 digits, hyphen-separated groups of 2–4, no whitespace, so both the
digit-count guard and `hasPhoneSeparatorShape` pass. Every `ls
.metaproject/flows` therefore reaches an agent as
`[REDACTED:phone]-managed-review-feedback-loop`, and the agent cannot
reconstruct a path. In the recorded session this burned roughly seven turns on
`ENOENT` retries, `id-map.json` lookups, and re-searching by slug before the
agent recovered. Reproduced today: `detectPii` returns `pii.phone
"001-2026-07-09"` and `pii.phone "144-2026-08-11"`. Directory listings are the
primary way an agent discovers flows, so this is a routine, high-traffic path.

**P2 — a live API key survived redaction in the same session.**
The transcript records `"DEEPSEEK_API_KEY": "[REDACTED:secret]"` next to a
`ZAI_API_KEY` printed in full, in one tool output, so the redactor ran and
covered only one of the two.

Root cause (found during self-review, T4): tool output is scrubbed by
`redactSensitiveText`, whose deterministic floor is `detectSecrets` + `detectPii`
— `detectEntropy` is NOT in that path. The `secrets.env-assignment` rule required
`NAME\s*[:=]`, so in the JSON form `"ZAI_API_KEY": "…"` the closing quote after
the name stopped the match reaching the colon. The rule therefore never fired on
a JSON credential store — which is exactly how keryx persists provider keys in
`auth.json`. `DEEPSEEK_API_KEY` was masked only because its VALUE starts with
`sk-` and matched the provider-shaped `secrets.openai-key` rule. Any key without
a recognised prefix was published verbatim.

Two further structural weaknesses in `src/security/detect/entropy.ts` — which
guards the full-scan path rather than tool output — are worth closing in the same
pass:

- the 3.6 entropy floor sits just under the typical Shannon entropy of a
  32-character hex blob (~3.7), so individual real keys fall below it by chance;
- `TOKEN` excludes `.`, so a dotted composite credential is only ever
  half-covered — the tail segment is measured separately and a 16-character tail
  is below the 20-character floor entirely.

**P3 — the toolless-reprompt budget forces the user to drive the loop by hand.**
`MAX_TOOLLESS_REPROMPTS = 1` (`src/commands/agent.ts:453`). When the model
announces a step in prose and emits no tool call, the driver nudges once; if the
second reply is prose again, the turn ends and the user must type another
continuation. In the recorded session the user typed «продолжай» eight times and
the nudge fired about ten times. Detection (`isActionRequest` /
`modelClaimedAction`) is working correctly — the budget and the escalation are
what fail.

## Expected Outcome

- A flow directory listing reaches an agent with its `NNN-YYYY-MM-DD-` prefix
  intact, and genuine phone numbers are still masked.
- A dotted composite credential is masked across its whole span, and a long hex
  credential next to a sensitive label is masked without depending on landing
  above the generic entropy floor.
- A model that answers an action request with prose gets more than one chance to
  correct itself, with an escalating instruction, and the driver gives up
  immediately when the model repeats itself verbatim instead of spending the
  remaining budget.
- No regression in the existing security corpus / detector suites.

## Out of Scope

- Rotating the leaked `ZAI_API_KEY` and scrubbing the stored session transcript
  (operator action; no code change can undo the disclosure).
- Re-installing or upgrading the stale `~/.local/bin/keryx` build.
- Provider-level `tool_choice: "required"` support — no adapter in the tree
  exposes it today; adding it touches the provider port and every adapter and
  belongs in its own flow.
- Any change to `pii.phone` detection of real phone numbers.
