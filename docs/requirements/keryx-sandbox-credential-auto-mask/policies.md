# Policies — Secrets, Masking, and Sandbox Defaults
Version: 0.2.0

## Purpose

Normative placement and safety rules for credentials and sandbox policy under
this package. Complements ADR-0006 and ADR-0007; does not replace them.

## P-SEC-1 — Secret storage

1. API keys **MUST** live only in:
   - user-global `auth.json` (`apiKeys`), mode 0600; and/or
   - parent process environment; and/or
   - CI secret injection into process env.
2. API keys **MUST NOT** be written by `keryx init`, project templates, wiki,
   memory, sessions transcripts (beyond existing redaction), or requirements docs.
3. Logs, dual-axis `REPORT.md`, and health artifacts **MUST NOT** contain real
   key material. Recording env **names** and inject **hosts** is allowed.

## P-SEC-2 — Policy storage

1. Sandbox **policy** (shell mode, maskMode, tlsTerminate preference,
   extraMasks as `NAME@host` without values, allowedDomains) **MAY** live in:
   - process env / CLI (highest priority);
   - project policy file (P2);
   - user-global `sandbox.json` (P1).
2. Policy files **MUST NOT** embed secret values. `extraMasks` is name+host only;
   real values are always read from effective env at run time.

## P-MASK-1 — When masking applies

Masking applies only when **all** hold:

1. OS sandbox path is active for the command (shell sandbox mode ≠ off, or
   harness contained run with restricted network);
2. Network posture is `restricted` (allowlist proxy in path);
3. Resolved `maskMode` ≠ `off`;
4. Resolved mask list is non-empty (from auto and/or explicit).

## P-MASK-2 — Fail-closed TLS

1. Non-empty mask list **requires** TLS termination for that run.
2. If termination cannot be established, the run **MUST** refuse (no cleartext
   fallback under a “masked” label).
3. Under `maskMode=auto`, TLS **MAY** be auto-enabled when masks apply and the
   operator did not set TLS explicitly to off.
4. Explicit `KERYX_SANDBOX_TLS_TERMINATE=0` with non-empty masks **MUST** refuse
   (cannot satisfy both).

## P-MASK-3 — Inject host discipline

1. Auto-derived hosts **MUST** come from provider registry `baseUrl` hostnames
   (plus Anthropic default API host).
2. Proxy **MUST** substitute the real secret only for requests whose host matches
   that credential’s `injectHosts` (existing proxy contract).
3. Wildcard hosts in explicit specs follow existing allowlist wildcard rules.

## P-MASK-4 — Model path exception

1. The agent’s own provider client (parent turn, subagent model turn) **is not**
   a sandboxed shell_exec child and **MUST** retain usable credentials for the
   LLM HTTPS path per existing grant rules.
2. Verification **MUST NOT** require stripping parent model credentials as part
   of “mask success”.

## P-RES-1 — Resolution order (after P1/P2)

For each setting (`shell`, `maskMode`, `tlsTerminate`, mask list composition):

1. Process env / CLI flags  
2. Project policy (P2), if present  
3. Global `sandbox.json` (P1), if present  
4. Built-in defaults (see specification)

## P-INIT-1 — Init constraints (P2)

1. Init **MAY** create a project policy skeleton with comments pointing to
   `/connect` for keys.
2. Init **MUST NOT** prompt to paste API keys into the project tree by default.
3. Init **MUST NOT** copy values from `auth.json` into the project.

## P-VERIFY-1 — Dual-axis honesty

1. Axis A (spawn_subagent / model) and Axis B (shell_exec mask) **MUST** be
   reported as separate verdicts.
2. A green model call **MUST NOT** be counted as proof of shell masking.
3. Axis C (harness CLI) **MUST** use the same resolver as shell_exec.
