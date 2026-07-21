# Sandbox Credential Auto-Mask — Product Requirements
Version: 0.2.0

## Problem

Operators who enable OS sandbox + restricted network for `shell_exec` (or
harness-contained children) must **manually** configure credential masking:

```bash
export KERYX_SANDBOX_SHELL=1
export KERYX_SANDBOX_TLS_TERMINATE=1
export KERYX_SANDBOX_MASK_ENV='DEEPSEEK_API_KEY@api.deepseek.com'
```

Meanwhile the **real key** is often already present in:

- process env, or
- user-global `~/.local/share/keryx/auth.json` (from shell `/connect`),

and `shell_exec` already calls `applySavedApiKeys()` so the sandboxed child
receives the **cleartext** key unless mask env is set.

Consequences:

1. **Easy footgun** — sandbox on, mask forgotten → secrets visible to
   untrusted commands inside the sandbox.
2. **Duplicated knowledge** — hostnames already live in
   `OPENAI_COMPAT_PROVIDERS[].baseUrl` + `envKey`; operators retype them.
3. **Confusion of levels** — users ask whether keys belong in the project or
   global keryx; `keryx init` does not (and must not) store secrets, but there
   is no documented automatic policy path either.
4. **Verification ambiguity** — model calls (parent/subagent need real keys on
   the LLM path) are conflated with shell masking (child must see sentinels).

## Goal

Make credential masking **automatic and fail-closed** for known provider keys
whenever sandboxed restricted network is active, while keeping:

- secrets only in user-global storage or parent process env;
- policy (sandbox on, mask mode, TLS) configurable at global and later project
  levels without secrets in git;
- clear separation of **model credential path** vs **shell mask path** for
  verification.

## Users

| User | Need |
|---|---|
| Interactive shell operator | Enter key once via `/connect`; enable sandbox; get auto-mask without memorizing host specs. |
| Harness / CI operator | Prefer flags or defaults over ad-hoc exports; parity with shell path. |
| Project maintainer | Optional project policy skeleton via init; never commit keys. |
| Security / review agent | Dual-axis tests prove sentinel in sandbox and real key only on allowlisted wire. |

## Requirements

### Functional

- **FR1 — Auto-mask resolution (P0).** When sandbox network posture is
  `restricted` and `maskMode` is `auto` (default once P0 lands for shell path),
  build mask specs from every known provider whose `envKey` has a non-empty
  value in the effective env (`process.env` after `applySavedApiKeys`).
  Host = hostname of that provider’s `baseUrl` (or Anthropic default host).
- **FR2 — Explicit merge.** Non-empty `KERYX_SANDBOX_MASK_ENV` (and harness
  `--mask-env`) still apply. In `auto` mode they **merge** with derived specs
  (union by env name; explicit hosts win if the same name appears twice).
- **FR3 — maskMode.** Support `auto` | `manual` | `off`:
  - `auto` — derive + merge explicit;
  - `manual` — explicit only (current behavior);
  - `off` — no masks even if explicit env is set (escape hatch for debugging).
- **FR4 — TLS coupling.** If the resolved mask list is non-empty and TLS
  terminate is not enabled, **fail closed** (current ADR-0007 rule). Under
  `maskMode=auto`, when masks would apply and TLS is unset, **auto-enable** TLS
  terminate for that run (document as derived enable, not a global default for
  maskless runs). If openssl/launcher cannot support termination, refuse the
  sandboxed command rather than half-mask.
- **FR5 — Shell / harness parity.** Same resolver used by `shell_exec` and
  harness contained runs so behavior does not diverge.
- **FR6 — No secrets in project or init.** Init may write policy skeletons
  only. Keys remain in `auth.json` / env.
- **FR7 — Global defaults (P1).** Optional
  `~/.local/share/keryx/sandbox.json` supplies `shell`, `tlsTerminate`,
  `maskMode` when corresponding env vars are unset. Env always overrides.
- **FR8 — Project policy (P2).** Optional project file may set maskMode,
  extraMasks, allowedDomains — never API key values. Documented resolution
  order: env > project policy > global defaults > built-in defaults.
- **FR9 — Observability without leaks.** Logs/reports may record mask **names**
  and **hosts**, never real values or sentinels that equal secrets. Dual-axis
  verification artifacts must be redacted.
- **FR10 — Dual-axis verification protocol.** Document and implement (as tests
  + optional manual runbook) Axis A (subagent/model network) vs Axis B
  (shell_exec mask) vs Axis C (harness CLI parity).

### Non-functional

- **NFR1 — Fail-closed.** Invalid mask specs, mask without TLS capability, or
  missing launcher → refuse, never silent cleartext under “we thought we masked”.
- **NFR2 — Backward compatible.** Unset maskMode behaves as `manual` until P0
  ships with an explicit migration note; after P0, default for new installs is
  `auto` when sandbox restricted is on (see implementation-plan migration).
- **NFR3 — Zero new runtime dependencies.** Reuse openssl/proxy stack; no npm
  cert libs (ADR-0005 / ADR-0007).
- **NFR4 — Deterministic resolver.** Same env + registry → same mask list
  (order stable by provider registry order then explicit).
- **NFR5 — Honest docs.** Package status stays draft until code proves claims.

## Success Criteria

- **SC1:** With only `DEEPSEEK_API_KEY` in auth.json and
  `KERYX_SANDBOX_SHELL=1` (restricted), without manual `MASK_ENV`, a sandboxed
  `printenv DEEPSEEK_API_KEY` shows a sentinel, not the real key.
- **SC2:** HTTPS request from that sandbox to `api.deepseek.com` still
  authenticates (proxy unmasks on wire).
- **SC3:** Request to a non-inject host does not receive the real key.
- **SC4:** Mask without TLS capability fails with an actionable error.
- **SC5:** `maskMode=manual` reproduces today’s explicit-only behavior.
- **SC6:** Dual-axis report never contains the real API key string.
- **SC7:** Unit tests cover hostname derivation, merge rules, and mode matrix
  without live network (proxy unit tests may stay as today).

## Risks

| ID | Risk | Mitigation |
|----|------|------------|
| R1 | Auto-enable TLS surprises users (MITM on allowlisted HTTPS) | Opt-in sandbox remains required; document; `maskMode=manual`/`off`; MITM only when masks apply |
| R2 | Custom/self-hosted providers not in registry | Explicit `MASK_ENV` / extraMasks still work |
| R3 | Tools ignoring CA env under TLS | Documented ADR-0007 limit; exclude those tools |
| R4 | Default flip to `auto` breaks a workflow that relied on cleartext in sandbox | Migration: default `auto` only when sandbox restricted; changelog; `maskMode=manual` escape |
| R5 | Logging accidentally prints secrets | Redaction rules in FR9; tests that fail if fixture key appears in report |

## Recommendation

Ship **P0 auto-mask + dual-axis verification** first; then **P1 global
defaults**; then **P2 project policy + init skeleton**. Do **not** put keys in
init. Treat provider registry as the single source of truth for
`envKey` ↔ host mapping.
