# Brainstorm — Sandbox Credential Auto-Mask
Version: 0.2.0

## Context

Operators already store provider keys in global keryx `auth.json` via shell
`/connect`. Sandbox credential masking (ADR-0007) exists but requires manual
`KERYX_SANDBOX_MASK_ENV` + `KERYX_SANDBOX_TLS_TERMINATE`. The question was:

1. Are keys project-level or global keryx?
2. Can init/harness automatically wire mask when a key is set?
3. How should dual-axis verification improve before run?

This document freezes the decision history for the requirements package.

## Levels of configuration (resolved)

| Concern | Level | Store |
|---------|-------|--------|
| API key secrets | **User-global only** (or parent env / CI secret) | `~/.local/share/keryx/auth.json` |
| Last provider/model | User-global | same `auth.json` |
| Sandbox defaults (shell mode, tls, maskMode) | User-global (P1) | `sandbox.json` next to auth |
| Project allowlist / extra masks / maskMode override | Project (P2) | non-secret policy file |
| One-off overrides | Process env / CLI flags | highest priority |

**Rejected:** project-level secret storage, init writing API keys, “copy key from
harness into project env file”.

## Option space

### O1 — Status quo (manual only)

- Pros: explicit, already implemented.
- Cons: footgun; duplicates registry knowledge; poor UX after `/connect`.

### O2 — Auto-mask from provider registry (chosen for P0)

- When restricted sandbox is active and maskMode=auto, for each known provider
  with a non-empty key, emit `ENV@hostname(baseUrl)`.
- Pros: single source of truth (`providers.ts`); zero extra user typing; works
  with auth.json keys after `applySavedApiKeys`.
- Cons: unknown custom hosts need explicit masks; TLS auto-enable is invasive
  (mitigated by sandbox still opt-in).

### O3 — Auto-mask every `*_API_KEY` env var

- Pros: catches custom tools.
- Cons: wrong hosts unknown; over-masking; surprising inject hosts. **Rejected**
  as default.

### O4 — Init writes mask exports into project shell hooks

- Pros: project-local DX.
- Cons: secrets or secret *names* drift; hooks are easy to commit wrongly;
  init is the wrong lifecycle for credentials. **Rejected** for secrets;
  accepted only for **non-secret policy skeleton** (P2).

### O5 — Global sandbox.json defaults only, no auto-mask

- Pros: simple.
- Cons: still requires typing MASK_ENV. Incomplete alone. **Accepted as P1
  complement**, not substitute for O2.

## Critical questions

### Q1: Default maskMode after P0?

- **A (recommended):** `auto` when sandbox restricted is on; document migration.
- B: remain `manual` forever; auto only if `KERYX_SANDBOX_MASK=auto`.
- **Decision:** A for product goal; implementation-plan may stage via explicit
  env `KERYX_SANDBOX_MASK_MODE` first release then flip default.

### Q2: Auto-enable TLS when masks apply?

- **Decision:** Yes under maskMode=auto when resolved masks non-empty and TLS
  unset. Still fail closed if termination cannot start. Maskless restricted
  runs do **not** enable TLS by default.

### Q3: Should model subagents see sentinels?

- **Decision:** No. Parent/subagent **model** path needs real credentials for
  provider HTTPS. Masking applies to **contained shell/harness child processes**
  under restricted network, not to stripping the agent’s own provider grant.
  Dual-axis verification must not conflate these.

### Q4: Init role?

- **Decision:** Scaffold project policy only (P2). Never keys. Point users to
  `/connect` or env for secrets.

### Q5: Dual-axis before or after P0?

- **Decision:** Specify verification in this package **with** P0; run manual
  dual-axis against current manual env only if needed for regression baseline;
  full dual-axis green is a **P0 acceptance gate**.

## Reference designs studied

| Source | Takeaway |
|--------|----------|
| ADR-0006 / ADR-0007 | Opt-in sandbox; mask requires TLS terminate; fail closed |
| opencode-style auth.json | User-global secrets, 0600 — keep |
| Claude Code TLS notes (via ADR-0007) | Not all tools honor CA env vars |
| OPENAI_COMPAT_PROVIDERS | Ready-made envKey + baseUrl map |

## Resolved forks (summary)

1. Secrets = global; policy = global + optional project.  
2. P0 = registry auto-mask + merge explicit + TLS auto-enable when masks.  
3. P1 = sandbox.json defaults.  
4. P2 = project policy + init skeleton.  
5. Dual-axis = model path vs shell mask path vs harness parity.  
6. No secrets in init or git.
