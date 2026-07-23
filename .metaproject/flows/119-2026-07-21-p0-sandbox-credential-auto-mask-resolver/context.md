# Context — flow 103 P0 auto-mask

## Package

- `docs/requirements/keryx-sandbox-credential-auto-mask/` (README, prd, specification, policies, implementation-plan P0, schemas/mask-resolution.schema.json)

## Code baselines

- `src/harness/tool/builtin/shell-exec-tool.ts` — restricted network + manual MASK_ENV
- `src/commands/harness.ts` — `harness exec` --mask-env / --tls-terminate
- `src/harness/process/sandbox/network-run.ts` — parseMaskSpec, setupNetworkRun
- `src/commands/providers.ts` — OPENAI_COMPAT_PROVIDERS envKey + baseUrl
- `src/lib/shell-config.ts` — applySavedApiKeys / auth.json

## ADRs

- ADR-0006 OS sandbox shell
- ADR-0007 TLS terminate for HTTPS credential masking (fail-closed)

## Migration decision (this flow)

P0.a: default maskMode = **manual** when `KERYX_SANDBOX_MASK_MODE` unset.
Enable auto: `export KERYX_SANDBOX_MASK_MODE=auto`.
