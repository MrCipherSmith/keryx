# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: gemini-cli, kiro and github-copilot-agent each have a registered HarnessAdapter with an `instructions` surface and a `block` surface, both at `experimental` confidence with non-empty sourceDocs (first-party URLs recorded from a docs fetch) and non-empty riskNotes, pinned by a registry test (W5-AC5).
- AC2: zed is registered with adapterKind `policy-travels-with-agent`; its `block` surface is `verified`, installs into no settings file, and its sourceDocs cite `src/acp/permission.ts` and `src/acp/permission.test.ts` (W5-AC6), pinned by a test.
- AC3: opencode and antigravity remain `experimental` with the same UNSUPPORTED_ORIENT reasons, and no pre-existing adapter's or surface's confidence changes (W5-AC7), pinned by a test.
- AC4: `keryx integrations matrix` generates a harness-capability-matrix.schema.json-conformant document from the registry covering every canonical harness id (including keryx-shell); the checked-in artifact matches it; `keryx integrations matrix --check` exits non-zero on drift; a guard test in test:core and a CI step enforce it (W5-AC4).
- AC5: `keryx integrations install|doctor|uninstall --runtime <id> [--surface <flag|surface-id>]` cover every surface a registered adapter declares (JSON surfaces through their SettingsFileOwner, non-JSON surfaces through customInstall plus a probe), record per-target install-state in `.metaproject/data/integrations/install-state/<runtime>.json` in the install-manifest installState shape with the surface discriminator, and doctor reports drift for a recorded surface that is now missing or invalid; experimental surfaces print a warning at install time; proven by tests on a temp project.
- AC6: `keryx ctx install-hook|uninstall-hook`, `keryx orient install-hook|uninstall-hook` and `keryx security hooks install|uninstall` delegate to the integrations installer core, and their pre-existing tests pass without modification; `keryx ctx hook <runtime>` handler code is unchanged (W5-AC3).
- AC7: `keryx harness run|exec|extension|wave` behavior and help text are unchanged, pinned by a test (W5-AC3a).
- AC8: harness-capability-matrix.schema.json parses and the validator rejects a matrix entry missing any required field, proven by a test (W5-AC8).
