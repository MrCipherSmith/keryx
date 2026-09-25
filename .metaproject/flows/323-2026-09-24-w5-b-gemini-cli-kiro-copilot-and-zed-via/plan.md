# Implementation Plan

Status: approved (autonomous run, create-pr-and-merge; stacked on stack/wave0)

## Approach

Extend the W5-a registry rather than add a parallel structure.

1. **Types** (`src/integrations/types.ts`): `SurfaceAdapter.probe?(root)` for non-JSON / non-installing surfaces;
   `HarnessAdapter.riskNotes?`. New subsystem constants `SUBSYSTEM_INSTRUCTIONS`, `SUBSYSTEM_ACP_PERMISSION`.
2. **Adapters** (`src/integrations/surfaces*.ts`, `registry.ts`):
   - gemini-cli / kiro / github-copilot-agent: `block` = ctx-guard surface (subsystem `ctx-guard`, so
     `keryx ctx hook <id>` works without touching the handler) in the harness's documented hook file, with
     payload/decision codecs per first-party docs; `instructions` = managed markdown block in the harness's
     documented instructions file. All experimental, riskNotes + first-party sourceDocs URLs (T1 research).
   - zed: `policy-travels-with-agent`, `block` surface subsystem `acp-permission`, verified, no settings file,
     sourceDocs `src/acp/permission.ts` + `src/acp/permission.test.ts`; `inject-context` stays unsupported;
     instructions via AGENTS.md experimental.
   - keryx-shell: placeholder adapter, no surfaces, every flag unsupported with a "W6 registers these" reason.
3. **Installer core** (`src/integrations/installer.ts`, `install-state.ts`): per-surface install/uninstall/doctor
   through `SettingsFileOwner` or `customInstall`/`probe`; install-state at
   `.metaproject/data/integrations/install-state/<runtime>.json` (the `installState` shape of
   install-manifest.schema.json with the `surface` discriminator; optional `keryxVersion`/`installedAt` added to the
   record as an additive schema extension); written only when `<root>/.metaproject/` exists. Legacy installers
   call this core.
4. **Matrix** (`src/integrations/matrix.ts`): deterministic generation (generatedAt derived from the max
   lastVerified), validated with `src/contracts/validator.ts` against the schema; checked-in artifact
   `docs/integrations/harness-capability-matrix.json`; guard test; CI step.
5. **CLI** (`src/commands/integrations.ts`): install|doctor|uninstall|matrix, `--runtime`, repeated `--surface`
   (flag or surface id), `--dry-run`, `--json`, `--check`; registered in cli.ts, help and the command registry.

## Sequencing

T1 research → T5 adapters → (T6 installer core ∥ T7 matrix) → (T8 CLI ∥ T9 docs) → T10/T11 verification →
T3 targeted checks → T4 review + PR.

## Risks

- Registering new ctx-guard surfaces extends `ctx install-hook --runtime all` to three experimental harnesses
  (same pattern as antigravity/opencode; experimental warning printed).
- Install-state writes from legacy commands could break existing tests asserting tree contents — gated on
  `.metaproject/` existing, and the legacy tests are run unmodified.
- Third-party-only facts are never cited as verified.
