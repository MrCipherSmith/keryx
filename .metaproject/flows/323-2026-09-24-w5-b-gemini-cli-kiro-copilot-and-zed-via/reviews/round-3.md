# Review round 3 — PR #677 (opus, adversarial)

Round-2 items F4, F7, F13, N1, N2 (reported case), N5, N6 fixed; N4 partial. All 8 ACs pass end to end.

```json keryx:findings
[
{"id":"M1","severity":"minor","file":"src/integrations/markdown-block.ts","line":338,"title":"Markdown round trip still not byte-safe; created-file marker leaks","detail":"CRLF kiro front matter left; CRLF created file not deleted; orphan created-file marker after user edits; user front matter identical to Keryx's stripped; whitespace normalization."},
{"id":"M2","severity":"minor","file":"src/integrations/installer.ts","line":238,"title":"strip-diff presence check reports removed for a never-installed surface","detail":"strip prunes empty containers; judge presence by the surface's own sentinel-tagged group."},
{"id":"M3","severity":"minor","file":"src/integrations/installer.ts","line":634,"title":"doctor --runtime all aborts on one unparsable settings file","detail":"Catch into live 'invalid'."},
{"id":"M4","severity":"info","file":"src/integrations/markdown-block.ts","line":107,"title":"Created-file marker user-visible and undocumented","detail":"Removed by the re-plan."},
{"id":"I1","severity":"info","file":"src/integrations/installer.ts","line":512,"title":"Invalid JSON in one surface file skips that runtime's other surfaces on uninstall","detail":"Refuse-hard behaviour; reported, rc=1."},
{"id":"I2","severity":"info","file":"src/integrations/settings-file.ts","line":1,"title":"Shared settings files left as {} after uninstall","detail":"Pre-existing walker behaviour."}
]
```

Re-plan after three rounds: see journal.md (2026-09-24, round 3 entry).
