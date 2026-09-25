# Review round 1 — PR #677 (opus, adversarial)

Verdict: 3 major, 7 minor, 4 info. Confirmed OK: dry-run writes nothing, confidence claims match first-party research,
matrix deterministic + schema-valid, no path traversal via runtime id, legacy ownerOverride/upgraded/throw semantics kept.

```json keryx:findings
[
{"id":"F1","severity":"major","file":"src/integrations/markdown-block.ts","line":44,"title":"Missing end marker: install/uninstall delete all user content after the start marker","detail":"Start marker without end marker replaces/removes to EOF, losing user content. Fix: refuse an unterminated block."},
{"id":"F2","severity":"major","file":"src/integrations/surfaces-w5b.ts","line":344,"title":"zed instructions: install-state record never removed; doctor fails after uninstall","detail":"customInstall writes nothing but is recorded; customUninstall returns false so the record stays; AGENTS.md edits then fail doctor."},
{"id":"F3","severity":"major","file":"src/commands/integrations.ts","line":205,"title":"--runtime all combined with --surface always exits 1; plain all exits 1 without AGENTS.md keryx block","detail":"Selector errors for adapters lacking the surface; zed AGENTS.md check fails install."},
{"id":"F4","severity":"minor","file":"src/integrations/installer.ts","line":393,"title":"Custom-surface dry-run disagrees with the real run","detail":"Dry-run checks only file existence."},
{"id":"F5","severity":"minor","file":"src/integrations/installer.ts","line":484,"title":"False sha drift when surfaces share a settings file","detail":"Whole-file sha per surface."},
{"id":"F6","severity":"minor","file":"src/integrations/surfaces-w5b.ts","line":150,"title":"Uninstall leaves Keryx-owned hook files as {version} residue","detail":".kiro/hooks/keryx-ctx-guard.json and .github/hooks/keryx-ctx-guard.json left behind."},
{"id":"F7","severity":"minor","file":"src/integrations/install-state.ts","line":67,"title":"Malformed install-state JSON crashes install and doctor","detail":"No shape check in readInstallState."},
{"id":"F8","severity":"minor","file":"src/integrations/markdown-block.ts","line":73,"title":"Kiro steering front matter prepended a second time","detail":"Existing front matter not detected."},
{"id":"F9","severity":"minor","file":"src/integrations/markdown-block.ts","line":89,"title":"Duplicate markers, CRLF and round-trip not handled","detail":"Second block left behind; CRLF always stale; separator newline not removed."},
{"id":"F10","severity":"minor","file":"src/integrations/installer.ts","line":255,"title":"Legacy error output duplicated and relabelled","detail":"Group errors copied onto every surface and prefixed."},
{"id":"F11","severity":"info","file":"src/ctx/hook-install.ts","line":74,"title":"Legacy uninstall output semantics changed","detail":"'nothing to remove' when file exists without guard; docs claim exactly as before."},
{"id":"F12","severity":"info","file":"src/integrations/codecs.ts","line":64,"title":"Copilot codec ignores toolName","detail":"Documented in riskNotes; verify exit 2 + JSON combination live."},
{"id":"F13","severity":"info","file":"docs/docs/integrations.md","line":89,"title":"Documented drift message format does not match code","detail":"Docs vs driftMessage wording."},
{"id":"F14","severity":"info","file":"src/integrations/installer.ts","line":205,"title":"Duplicated install/uninstall preambles and CLI handlers","detail":"Refactor opportunity; matrix --file not confined (operator input)."}
]
```
