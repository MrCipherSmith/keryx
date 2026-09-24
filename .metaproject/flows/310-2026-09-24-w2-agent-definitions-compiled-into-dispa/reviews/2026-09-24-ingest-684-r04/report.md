# Review 310 R4: PR #684 (W2 agent-definition catalogue), final verification round

Scope: fix commit 9e77c3d6 and merge commit 535f20af on flow/310-w2 (head bb521e75), in /Users/Goodea/goodea/keryx-ape-310-w2. The review was read-only on the repo. All CLI probes ran in fresh git repos under scratchpad/review310-r4/: the round-3 probes re-run as e2e.sh → e2e.out and probe.ts → probe.out, plus r-dall (doctor across all runtimes) and r-dry (uninstall dry-run).

R3 disposition:
- **R3-F1: resolved.** The hash now covers the whole file. Only the structurally located `content-sha256` value is blanked (`sentinelHashFieldSpan` plus `spliceSentinelHashSpan`), and the kiro four-key projection is gone. probe.out results:
  - Adding `model`, `allowedTools` or `mcpServers` to a kiro file now gives verify=false. So do a changed tool list, a body edit, an added claude frontmatter key, an edit to the source sha, and a codex sandbox change.
  - In e2e.out, a kiro file with an added `mcpServers` key is re-exported as `refuse-modified` (written: false) and the key survives. Doctor reports it as "hand-edited since export".
  - Text appended to a claude sentinel line is re-exported as `refuse-modified` and the text survives.
  - All 10 bundled agents × 4 formats still self-verify, are recognised as managed, and compile deterministically.
  - The earlier edge cases still verify on all 4 hosts: a body of 64 zeros (kept), a description containing `content-sha256:`, a sentinel-shaped line in the body, and a body of `---\n---`.
  - md and toml verification remains CRLF-tolerant, because `locateStructuralLine` splits on `\r?\n` and the splice rejoins with `\n`. A CRLF kiro file fails safe: it is reported as hand-edited.
  - The kiro raw `indexOf(candidate)` splice cannot be steered by content that appears earlier in the file. A description that duplicated the candidate would need to contain its own source sha. Any JSON-escaped trailing text makes `indexOf` miss, which fails safe.
- **R3-F2: resolved.** Both guide passages and the cli-reference row now state the rules exactly:
  - An unmanaged file is never overwritten, even with `--force`.
  - A file whose content-sha256 no longer matches is refused unless `--force` is passed.
  - A stale file whose content still verifies is updated with no flag.

  `[--force]` is in both synopses and the table row. `--surface` is in the doctor usage in both the CLI help and cli-reference.
- **Info items: resolved.** `doctor --runtime claude --surface bogus` now exits 1 with "unknown surface selector(s) bogus". Uninstall keeps hand-edited managed exports and warns about them (e2e.out r-f9: planner.md was kept, and architect.md and mine.md were untouched). Two new defects came in with these fixes, and both are below: R4-F1 (doctor across several runtimes) and R4-F2 (uninstall dry-run).

Merge 535f20af:
- The two conflict resolutions are correct:
  - types.ts keeps both `SUBSYSTEM_AGENTS` and `SUBSYSTEM_SHELL_HOOKS`.
  - The registry.test.ts flag set is the union: agents, block, inject-context, instructions, observe, post-tool, pre-tool-context, prompt-gate, session-start, stop.
- `integrations matrix --check` reports "matches the registry".
- W6's keryx-shell surfaces (subsystem `shell-hooks`) are not affected by this PR's changes:
  - They carry no `relativePath`, so the audit-harness hooks discovery exclusion, which is keyed on `SUBSYSTEM_AGENTS` only, neither picks them up nor skips them.
  - `agentDefinitionHostDirs` collects only `SUBSYSTEM_AGENTS` directories.
  - `resolveSurfaceSelection`/`Lenient` exclude only `optIn` surfaces from the default. W6 surfaces are not opt-in, so a plain `install --runtime keryx-shell` behaves as W6 intended.
  - `install --runtime all --surface agents` reports keryx-shell as "no matching surface" and exits 0.
  - `defaultAgentSupportLookup` still returns `native` for keryx-shell before it looks anything up in the registry, so W6's surfaces do not change it. keryx-shell has no `agents` flag surface, and its matrix `agents` cell stays W6's unsupported entry. That is the settled round-1 design.
  - One stale comment: export.ts:64 still calls the keryx-shell row "W6's placeholder adapter (no surfaces yet)". That is cosmetic and not reported.
  - The cli-reference "keryx-shell (no surfaces yet)" text comes from the W6 parent (it is present at 368ee495), so it is out of scope here.

Gates:
- The requested test set gives 949 pass, 0 fail across 37 files. src/sac is limited to core-graph.test.ts, so the wrap-up author-email failures did not come into play.
- `agents verify` exits 0.
- `check-doc-links`: 1601 links, 0 broken.

```json keryx:findings
[
  {
    "id": "R4-F1",
    "severity": "minor",
    "title": "`integrations doctor --runtime all|<list> --surface agents` now fails every runtime without an agents surface with 'unknown surface selector', although install/uninstall accept the same selector across several runtimes",
    "file": "src/integrations/installer.ts",
    "line": 712,
    "detail": "9e77c3d6 added `resolveSurfaceSelection(adapter, opts.surfaces)` to `doctorIntegration`. That is the STRICT resolver, which throws when a selector matches nothing on that adapter. handleDoctor (src/commands/integrations.ts:374) calls it for every runtime in `--runtime all` or a comma list. install and uninstall handle the same multi-runtime `--surface` request through `resolveSurfaceSelectionLenient` (integrations.ts:294/323, `lenientSelectors = surfaces.length > 0 && isMultiRuntimeRequest(runtimeArg)`), which turns a runtime with no matching surface into `noMatchingSurface` instead of an error. doctor never got that multi-runtime leniency. The new cli-reference doctor row says 'an unknown selector errors the same way it does there', which is untrue for a multi-runtime request.",
    "class_scope": {
      "sites": [
        "src/integrations/installer.ts:710-713 (doctorIntegration strict selector validation)",
        "src/commands/integrations.ts:340-382 (handleDoctor: no isMultiRuntimeRequest/lenient path, unlike handleInstall:294 and handleUninstall:323)",
        "docs/docs/cli-reference.md doctor row ('errors the same way it does there')"
      ],
      "enumeration_method": "Found every resolveSurfaceSelection/lenientSelectors/isMultiRuntimeRequest site in src/commands/integrations.ts and src/integrations/installer.ts with `keryx ctx rg --all`. Only doctor uses the strict resolver for a multi-runtime request. Reproduced with the CLI in scratchpad/review310-r4/r-dall."
    },
    "impact": "In r-dall, `install --runtime all --surface agents` succeeds (exit 0), and the natural follow-up `integrations doctor --runtime all --surface agents` exits 1. It reports 7 false problems ('✗ cursor|windsurf|antigravity|zed|generic-mcp|gemini-cli|github-copilot-agent: unknown surface selector(s) agents'), so a healthy install reads as broken. `doctor --runtime claude,cursor --surface agents` fails the same way. At round 3 the same command was silently accepted. For comparison, the four agents hosts named explicitly (`--runtime claude,codex,kiro,opencode --surface agents`) exit 0.",
    "suggested_fix": "Follow the install/uninstall pattern. In handleDoctor, compute `lenientSelectors = surfaces.length > 0 && isMultiRuntimeRequest(runtimeArg)` and pass it through. In doctorIntegration, use the strict check only when it is false. With lenient selection, skip or mark `noMatchingSurface` for a runtime none of whose surfaces match, and fail only when no selected runtime matched any selector. Add a test for `doctor --runtime all --surface agents` after `install --runtime all --surface agents`, and reword the cli-reference sentence to match.",
    "evidence": "scratchpad/review310-r4/r-dall: install all agents exit=0; `doctor --runtime all --surface agents` exit=1, with lines like '✗ cursor: unknown surface selector(s) agents — valid flags: block, inject-context, prompt-gate; ...' for 7 runtimes while claude, codex, opencode and kiro show 'ok'; `doctor --runtime all` (no --surface) exit=0; `doctor --runtime claude,codex,kiro,opencode --surface agents` exit=0.",
    "confidence": "high"
  },
  {
    "id": "R4-F2",
    "severity": "minor",
    "title": "`integrations uninstall --surface agents --dry-run` reports would-remove for exports that are all hand-edited, but the real uninstall keeps them (nothing-to-remove), which breaks the dry-run/real parity R1-F8 established",
    "file": "src/agents/export.ts",
    "line": 548,
    "detail": "T17 changed `removeManagedAgentExportsDetailed` to delete only managed files that still verify. Hand-edited ones are kept and reported. The dry-run path is `installer.ts` `customUninstallDryRun` → `surface.inspect` → `surfaces-agents.ts` `inspectAgentsExports` → `hasManagedAgentExports`. That path still counts `verified.length > 0 || handEdited.length > 0`, so it returns `present` → `would-remove` when only hand-edited files exist. The real run for that directory removes nothing and reports `nothing-to-remove` plus 'kept …' warnings. The dry-run prints no kept warnings. installer.ts:247-249 documents that the dry-run 'mirrors what the real `customUninstall` would find, so dry-run and the real run never disagree'. R1-F8 (minor) was this exact would-remove/nothing-to-remove disagreement for the agents surface.",
    "class_scope": {
      "sites": [
        "src/agents/export.ts:548-552 (hasManagedAgentExports counts handEdited)",
        "src/integrations/surfaces-agents.ts:120-123 (inspectAgentsExports, the only caller)",
        "src/integrations/installer.ts:260-272 (customUninstallDryRun consumer; no warnings channel)"
      ],
      "enumeration_method": "Enumerated every hasManagedAgentExports reference with `keryx ctx rg --all` (the definition plus one caller, inspectAgentsExports). Every customUninstall site with `keryx ctx rg --all`: the installer.ts:587 real path and the ctx/runtimes.ts:175 normalizer, which is ctx-guard only. Reproduced with the CLI in scratchpad/review310-r4/r-dry."
    },
    "impact": "The uninstall preview is wrong. An operator is told the agents exports would be removed, when running it would keep all 10 files. The preview also gives no sign that anything will be kept.",
    "suggested_fix": "Make the dry-run follow the real rule. Have inspect report `present` only when `verified.length > 0`, for example with a `hasRemovableAgentExports` that returns the verified/handEdited split. Ideally, also surface the would-keep list as dry-run warnings through an optional warnings field on the inspect result. Add a dry-run test for an all-hand-edited directory next to the new installer.test.ts real-uninstall test.",
    "evidence": "scratchpad/review310-r4/r-dry: `install --runtime claude --surface agents`, append a line to all 10 .claude/agents/*.md, then `uninstall --dry-run` gives 'agents (agents) -> .claude/agents would-remove'; the real uninstall gives 'agents (agents) -> .claude/agents nothing-to-remove' with 'kept .claude/agents/architect.md — …' warnings, and 10 files remain.",
    "confidence": "high"
  }
]
```
