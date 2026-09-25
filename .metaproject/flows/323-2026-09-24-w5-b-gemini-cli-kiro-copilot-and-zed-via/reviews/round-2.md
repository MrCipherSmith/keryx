# Review round 2 — PR #677 (opus, adversarial)

Round-1: F1, F2, F3, F5, F6, F8, F9, F10, F11 fixed; F4, F7 partial; F13 not fixed. All 8 ACs met. New: 4 minor, 2 info.
CI (run 35948603642): `docs/docs/commands-by-task.md` not regenerated after the HELP_GROUPS entry.

```json keryx:findings
[
{"id":"F4","severity":"minor","file":"src/integrations/installer.ts","line":496,"title":"Dry-run disagrees with real run for an unterminated markdown block","detail":"customSurfaceWouldRemove string-matches only the missing-block probe message."},
{"id":"F7","severity":"minor","file":"src/integrations/install-state.ts","line":73,"title":"Records inside installedModules not validated","detail":"installedModules:[null] crashes doctor and install."},
{"id":"F13","severity":"minor","file":"docs/docs/integrations.md","line":89,"title":"Docs drift example uses runtime id, code emits surface id","detail":"Align the example with driftMessage."},
{"id":"N1","severity":"minor","file":"src/integrations/installer.ts","line":510,"title":"customUninstall throw escapes uninstallIntegration after JSON surfaces were stripped","detail":"Catch into a failed SurfaceResult."},
{"id":"N2","severity":"minor","file":"src/integrations/installer.ts","line":212,"title":"Shared sentinel makes uninstall report removed for a never-installed surface","detail":"Judge presence per surface."},
{"id":"N4","severity":"minor","file":"src/integrations/markdown-block.ts","line":281,"title":"Markdown round-trip not byte-safe (mixed EOL, pre-existing empty files deleted, kiro front matter left)","detail":"Splice only at block boundaries; delete only files install created."},
{"id":"N5","severity":"info","file":"src/standard/command-registry.coverage.test.ts","line":60,"title":"Exclusion reason inaccurate","detail":"Reword: an agent must not be able to uninstall its own guard."},
{"id":"N6","severity":"info","file":"src/integrations/owner.test.ts","line":21,"title":"Unneeded pre-existing test import edit; duplicated CLI lines","detail":"Revert import; dedupe output."}
]
```
