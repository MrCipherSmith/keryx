# Flow 305 review round 1 (opus, adversarial, pre-PR, branch flow/305-w5a @ T9)

Findings F1-F5 major, F6-F10 minor, F11 info. Probe script: scratchpad/probe.ts.

```json keryx:findings
[
 {
  "id": "F1",
  "severity": "major",
  "title": "Owner refusal errors discarded by security CLI and every uninstall path",
  "file": "src/security/agent-hooks.ts",
  "line": 68,
  "detail": "installRuntimeHooks/uninstallRuntimeHooks, ctx uninstallRuntimeHook, orient uninstallOrientRuntime ignore installSurfaces/uninstallSurfaces errors.",
  "class_scope": {
   "sites": [
    "src/security/agent-hooks.ts:installRuntimeHooks",
    "src/security/agent-hooks.ts:uninstallRuntimeHooks",
    "src/ctx/hook-install.ts:uninstallRuntimeHook",
    "src/ctx/orient-runtimes.ts:uninstallOrientRuntime",
    "src/commands/security.ts:handleHooks",
    "src/commands/orient.ts:handleUninstall",
    "src/commands/ctx.ts:handleUninstallHook"
   ],
   "enumeration_method": "every caller of installSurfaces/uninstallSurfaces found by keryx ctx rg"
  },
  "impact": "Owner refusal errors discarded by security CLI and every uninstall path",
  "suggested_fix": "installRuntimeHooks/uninstallRuntimeHooks, ctx uninstallRuntimeHook, orient uninstallOrientRuntime ignore installSurfaces/uninstallSurfaces errors.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F2",
  "severity": "major",
  "title": "In-memory validation replaced on-disk validation: antigravity array container installs report success with no guard on disk",
  "file": "src/integrations/settings-file.ts",
  "line": 41,
  "detail": "Validate a JSON round-trip.",
  "class_scope": {
   "sites": [
    "src/integrations/settings-file.ts:apply"
   ],
   "enumeration_method": "the single validation site in the owner"
  },
  "impact": "In-memory validation replaced on-disk validation: antigravity array container installs report success with no guard on disk",
  "suggested_fix": "Validate a JSON round-trip.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F3",
  "severity": "major",
  "title": "assertRegistryCoherent is vacuous for undeclared keys; flat security surfaces use hooks as array alongside ctx's hooks object",
  "file": "src/integrations/registry.ts",
  "line": 174,
  "detail": "Declare every touched key; test merges on fixtures against declared slots.",
  "class_scope": {
   "sites": [
    "src/integrations/surfaces.ts: every SurfaceAdapter slots declaration",
    "src/integrations/registry.ts:assertRegistryCoherent"
   ],
   "enumeration_method": "every surface merge run on {} and legacy fixtures, touched keys vs declared slots"
  },
  "impact": "assertRegistryCoherent is vacuous for undeclared keys; flat security surfaces use hooks as array alongside ctx's hooks object",
  "suggested_fix": "Declare every touched key; test merges on fixtures against declared slots.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F4",
  "severity": "major",
  "title": "CTX_RUNTIMES/ORIENT_RUNTIMES/RUNTIME_HOOKS lists and confidences are not derived from the registry",
  "file": "src/ctx/runtimes.ts",
  "line": 270,
  "detail": "Derive from HARNESS_ADAPTERS, assert identity.",
  "class_scope": {
   "sites": [
    "src/ctx/runtimes.ts:CTX_RUNTIMES",
    "src/ctx/orient-runtimes.ts:ORIENT_RUNTIMES",
    "src/security/agent-hooks/runtimes.ts:RUNTIME_HOOKS"
   ],
   "enumeration_method": "the three exported runtime lists named by AC2"
  },
  "impact": "CTX_RUNTIMES/ORIENT_RUNTIMES/RUNTIME_HOOKS lists and confidences are not derived from the registry",
  "suggested_fix": "Derive from HARNESS_ADAPTERS, assert identity.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F5",
  "severity": "major",
  "title": "Flat security strip/merge leave managed entries with other on values",
  "file": "src/integrations/surfaces.ts",
  "line": 548,
  "detail": "Orphaned managed entries survive strip while the sentinel is removed.",
  "class_scope": {
   "sites": [
    "src/integrations/surfaces.ts:flat security merge",
    "src/integrations/surfaces.ts:flat security strip"
   ],
   "enumeration_method": "both flat security surface operations (input, output) across cursor/windsurf/generic-mcp"
  },
  "impact": "Flat security strip/merge leave managed entries with other on values",
  "suggested_fix": "Orphaned managed entries survive strip while the sentinel is removed.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F6",
  "severity": "minor",
  "title": "Undocumented behaviour changes: legacy hooks array migration for orient/claude-security; claude security validate requires sentinel",
  "file": "src/integrations/settings-json.ts",
  "line": 69,
  "detail": "Record as deliberate and pin with tests, or restore.",
  "impact": "Undocumented behaviour changes: legacy hooks array migration for orient/claude-security; claude security validate requires sentinel",
  "suggested_fix": "Record as deliberate and pin with tests, or restore.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F7",
  "severity": "minor",
  "title": "SettingsFileOwner.apply accepts unknown ids, uses caller order, mutates its input",
  "file": "src/integrations/settings-file.ts",
  "line": 31,
  "detail": "Reject unknown ids, canonical order, clone input.",
  "impact": "SettingsFileOwner.apply accepts unknown ids, uses caller order, mutates its input",
  "suggested_fix": "Reject unknown ids, canonical order, clone input.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F8",
  "severity": "minor",
  "title": "orient relativePathFor duplicates surface paths; OS-separator dependent fallback",
  "file": "src/ctx/orient-runtimes.ts",
  "line": 133,
  "detail": "Use surface relativePath.",
  "impact": "orient relativePathFor duplicates surface paths; OS-separator dependent fallback",
  "suggested_fix": "Use surface relativePath.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F9",
  "severity": "minor",
  "title": "Tests with surviving mutations",
  "file": "src/integrations/coexistence.test.ts",
  "line": 504,
  "detail": "Orient uninstall checked via reinstall; one-sided uninstall; no legacy fixtures.",
  "impact": "Tests with surviving mutations",
  "suggested_fix": "Orient uninstall checked via reinstall; one-sided uninstall; no legacy fixtures.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F10",
  "severity": "minor",
  "title": "Interface gaps for W5-b/W6/W8",
  "file": "src/integrations/types.ts",
  "line": 57,
  "detail": "Unused codec types, closed subsystem union, inconsistent surface ids, index exports mutation primitives.",
  "impact": "Interface gaps for W5-b/W6/W8",
  "suggested_fix": "Unused codec types, closed subsystem union, inconsistent surface ids, index exports mutation primitives.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "high"
 },
 {
  "id": "F11",
  "severity": "info",
  "title": "LAST_VERIFIED date implies a fresh documentation check",
  "file": "src/integrations/registry.ts",
  "line": 33,
  "detail": "Clarify meaning.",
  "impact": "LAST_VERIFIED date implies a fresh documentation check",
  "suggested_fix": "Clarify meaning.",
  "evidence": "probe output P1-P9 in the round-1 report (scratchpad/probe.ts) and code reading at the cited line",
  "confidence": "medium"
 }
]
```
