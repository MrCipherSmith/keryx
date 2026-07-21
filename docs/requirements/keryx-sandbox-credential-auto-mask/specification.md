# Sandbox Credential Auto-Mask — Specification
Version: 0.1.0

## Module Identity

- **Name:** `keryx-sandbox-credential-auto-mask`
- **Kind:** harness / shell security capability (configuration + resolver)
- **Home code (planned):**
  - `src/harness/process/sandbox/mask-resolve.ts` (new pure resolver)
  - `src/harness/tool/builtin/shell-exec-tool.ts` (call resolver)
  - `src/commands/harness.ts` (same resolver + optional `--auto-mask` / mask mode)
  - `src/lib/sandbox-config.ts` (new; P1 load/save global defaults)
  - `src/commands/providers.ts` (read-only source of envKey/baseUrl; no secret storage)
  - `src/lib/shell-config.ts` (existing keys; unchanged secret model)
- **Related ADRs:** ADR-0006, ADR-0007
- **Status:** draft — not implemented

## Storage Structure

```text
# User-global (existing)
~/.local/share/keryx/auth.json          # secrets + last provider (implemented)

# User-global (P1 — planned)
~/.local/share/keryx/sandbox.json       # non-secret defaults

# Project (P2 — planned; exact path TBD, pick one in implementation)
.keryx/sandbox-policy.json              # preferred non-git-secret policy
# OR documented alternative under .metaproject/ if product prefers
```

No new session store. Resolved masks are ephemeral per run.

## Manifest / Config Shape

### Global `sandbox.json` (P1)

See [schemas/sandbox-defaults.schema.json](schemas/sandbox-defaults.schema.json).

```json
{
  "shell": "workspace",
  "tlsTerminate": true,
  "maskMode": "auto"
}
```

All fields optional. Missing file ≡ empty defaults.

### Project policy (P2)

See [schemas/project-sandbox-policy.schema.json](schemas/project-sandbox-policy.schema.json).

```json
{
  "maskMode": "auto",
  "extraMasks": ["MY_TOOL_TOKEN@api.example.com"],
  "allowedDomains": ["api.deepseek.com", "registry.npmjs.org"]
}
```

`extraMasks` entries are `NAME@host[,host]` strings (same grammar as
`parseMaskSpec`). Values are **never** in this file.

### Environment / CLI (all phases)

| Surface | Meaning |
|---------|---------|
| `KERYX_SANDBOX_SHELL` | existing: off / workspace / strict / 1 |
| `KERYX_SANDBOX_TLS_TERMINATE` | `1` enable, `0` force disable |
| `KERYX_SANDBOX_MASK_ENV` | `;`-separated `NAME@host[,host]` (existing) |
| `KERYX_SANDBOX_MASK_MODE` | `auto` \| `manual` \| `off` (new) |
| harness `--mask-env` | repeatable explicit specs (existing) |
| harness `--tls-terminate` | existing |
| harness `--mask-mode <mode>` | new; optional |
| harness `--auto-mask` | optional alias for `--mask-mode auto` |

## Data Contracts

### Mask resolution result

See [schemas/mask-resolution.schema.json](schemas/mask-resolution.schema.json).

```ts
type MaskMode = "auto" | "manual" | "off";

interface ResolvedMask {
  name: string;           // env var name
  injectHosts: string[];  // never empty
  source: "auto" | "explicit" | "merged";
}

interface MaskResolution {
  mode: MaskMode;
  masks: ResolvedMask[];
  tlsTerminate: boolean;  // effective for this run
  tlsSource: "env" | "flag" | "auto-derived" | "defaults" | "off";
  /** Human-readable reasons for empty list or refusal (no secrets). */
  notes: string[];
}
```

### Pure resolver API (planned)

```ts
function resolveCredentialMasks(input: {
  mode: MaskMode;
  env: Record<string, string | undefined>;
  explicitSpecs: string[];           // from MASK_ENV and/or CLI
  providers: readonly { envKey: string; baseUrl: string }[];
  anthropicHost?: string;            // default "api.anthropic.com"
  tlsExplicit?: boolean | undefined; // undefined = unset
  allowAutoTls: boolean;             // true when mode === "auto"
}): { ok: true; resolution: MaskResolution } | { ok: false; reason: string };
```

### Derivation rules

1. **Provider list:** `OPENAI_COMPAT_PROVIDERS` mapped to
   `{ envKey, baseUrl }`, plus `{ envKey: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com" }`
   when Anthropic is treated as a first-class key source.
2. **Hostname:** `new URL(baseUrl).hostname` (fail closed for invalid URL —
   skip that provider with a note, do not throw across the whole resolve if
   others remain valid).
3. **Auto candidates:** for each provider, if `env[envKey]` is non-empty string,
   emit `{ name: envKey, injectHosts: [hostname], source: "auto" }`.
4. **Explicit:** parse each spec with existing `parseMaskSpec`; invalid → whole
   resolve `{ ok: false }` (same as shell_exec today).
5. **Merge (mode=auto):** start from auto map by `name`; for each explicit, set
   hosts from explicit and `source: "merged"` if auto had same name, else
   `source: "explicit"`.
6. **mode=manual:** only explicit; empty list is OK (no masks).
7. **mode=off:** empty list; ignore explicit (note recorded).
8. **TLS:** if `masks.length > 0`:
   - `tlsExplicit === false` → `{ ok: false, reason: "…" }`
   - `tlsExplicit === true` → `tlsTerminate: true`, source env/flag
   - `tlsExplicit === undefined` && `allowAutoTls` → `tlsTerminate: true`,
     source `auto-derived`
   - `tlsExplicit === undefined` && !allowAutoTls → `{ ok: false }` (manual
     mode without TLS flag — current behavior)

### Effective env for key presence

Callers **MUST** pass env after `applySavedApiKeys` / `envWithSavedApiKeys` so
keys only in `auth.json` participate in auto-mask.

## Integration Points

| Component | Integration |
|-----------|-------------|
| `shell-exec-tool` | After building env, if restricted network: resolve masks → setupNetworkRun |
| `harness` contained spawn | Same resolver; CLI flags feed explicitSpecs / mode / tls |
| Provider registry | Read-only input to auto list |
| `shell-config` | Unchanged secret I/O; keys feed env only |
| `keryx init` (P2) | Write project policy skeleton; link docs |
| Dual-axis tests | Consume resolution notes; assert sentinel behavior |

## CLI / Skill Surface

No new top-level skill required. Optional later:

```text
keryx sandbox defaults show|set   # P1 ergonomics (future; not required for P0)
```

P0 may ship with env-only mode control.

## Acceptance Criteria

| ID | Criterion |
|----|-----------|
| AC1 | Pure unit tests: auto derives `DEEPSEEK_API_KEY@api.deepseek.com` when key set and mode=auto. |
| AC2 | Pure unit tests: mode=manual ignores registry keys without explicit specs. |
| AC3 | Pure unit tests: mode=off yields empty masks even with explicit specs. |
| AC4 | Pure unit tests: merge replaces hosts for same name; union for different names. |
| AC5 | Pure unit tests: masks + tls unset + allowAutoTls → tlsTerminate true, source auto-derived. |
| AC6 | Pure unit tests: masks + tlsExplicit false → ok:false. |
| AC7 | Integration/fixture: shell_exec restricted path calls resolver (mock setupNetworkRun). |
| AC8 | Integration/fixture: harness path same resolution for equivalent inputs. |
| AC9 | Live or recorded proxy test (existing style): sentinel in child env; unmask on inject host. |
| AC10 | Dual-axis artifact redaction test: fixture key never appears in REPORT body. |
| AC11 | Docs: package README status stays honest until AC1–AC9 land in code. |
| AC12 | P1: load sandbox.json when env unset; env overrides file. |
| AC13 | P2: project extraMasks merge; secrets still absent from policy file. |

## Non-goals (normative)

- Masking the agent’s own model HTTP client credentials.
- Default TLS terminate for maskless restricted runs.
- Storing secrets in project policy or init output.
