# Review 310 R2: PR #684 (W2 agent-definition catalogue), adversarial round 2

Scope: fix commits 64e2a3bf, 89679e62, 795acba0 and 7077edb7 on flow/310-w2 (head 7077edb7), reviewed against the round-1 head 1184e988, in /Users/Goodea/goodea/keryx-ape-310-w2. The review was read-only on the repo. All CLI probes ran in fresh git repos under scratchpad/review310-r2/ (script e2e.sh, output e2e.out; format probe probe-formats.ts, output probe-formats.out). Afterwards `git status` shows only the two pre-existing flow files (flow.json and journal.md), so the probes did not write to the repo. Gates are green: the targeted suites give 562 pass, 0 fail across 26 files; `agents verify` returns ok: true for all 10 bundled agents; `integrations matrix --check` matches the registry. Every one of the 9 modules imports cleanly when loaded first in a fresh process (the round-1 TDZ is gone). On macOS, the realpath containment check behaves correctly under /var -> /private/var: the tests pass using tmpdir() (/var/folders) and the scratch roots are under /private/tmp. One non-finding: a lone UTF-16 surrogate in a description still yields invalid YAML, but it cannot arise from a UTF-8 file loaded from disk, so it is not reported.

Per-R1 disposition:

| R1 | Sev | Disposition | Evidence (round 2) |
|---|---|---|---|
| F1 YAML/TOML escaping | blocker | resolved | All 10 bundled agents × claude/opencode/codex/kiro parse with Bun.YAML/TOML/JSON, and descriptions round-trip. Adversarial `: `, ` #`, leading `- `, newline injection (no extra keys), `"""`, BEL/CR/NUL, DEL and C1 all parse. frontmatter.ts stripQuotes is unchanged: `'It''s'` still loads doubled. That is source-side fidelity, not an injection, so it is not re-raised. |
| F2 EISDIR on `--surface agents` | blocker | resolved | `install --runtime all --surface agents` with .metaproject: exit 0, 10 files written, install-state recorded for claude/codex/kiro/opencode, doctor shows `agents — valid`. |
| F3 symlink escape | major | resolved | CLI refuses a dangling file symlink, a symlinked `.codex/agents`, a symlinked `.claude` parent, and a bulk install through a symlinked dir (exit 1, nothing written outside). Uninstall through a symlinked dir leaves the outside victim.md in place. |
| F4 empty tools → claude null | major | resolved (exporter); audit part partially, see R2-F3 | Empty or all-unmapped tools export as `tools: "Read, Grep, Glob"`; kiro `["read"]`. |
| F5 policy_profile ignored on claude/kiro | major | resolved | A read-only definition with apply_patch/shell_exec exports claude `Read`, kiro `["read"]`, and reports droppedTools. verify raises `policy-tool-conflict`. |
| F6 keryx-shell sidecar unenforced | major | resolved (by honest labeling) | `policy.enforcement` {enforced: [mode], advisory: [toolAllowlist, isolation]} appears in show, export and JSON. A new guide section documents the D-2 boundary. |
| F7 sourceRef traversal | minor | resolved | `../agents` → `invalid-source-ref`, exit 1. The default resolver also refuses a symlinked pack dir. |
| F8 opt-in doctor noise / dry-run | minor | resolved (CLI `--surface` gap noted as R2-F5, info) | Doctor in a never-opted-in repo no longer lists agents. Dry-run uninstall now uses inspect(). |
| F9 hand edits overwritten | minor | partially | The content-sha256 sentinel now refuses hand edits and `--force` is gated. The "match the sentinel only on its line" half is not done, and together with `--force` and uninstall it now overwrites or deletes a user-owned file (R2-F1). The new content hash also has a false-positive path (R2-F2). |
| F10 import-cycle TDZ | minor | resolved | Lazy import() in surfaces-agents; a subprocess test covers it. |
| F11 guide inaccuracies | minor | partially | (a)–(d) fixed, and `no-export-support` is reachable via an injected lookup and documented. New inaccurate sentences: codex empty tools (R2-F4) and audit null tools (R2-F3). |
| F12 audit anchoring | info | partially | The model_tier fallback is now limited to lines containing the sentinel prefix. The kiro JSON prompt is one line, so prose in the prompt still suppresses the finding. tomlHasKey is unchanged (R2-F6, info). |
| F13 xref guard | info | not acted (by design) | — |
| F14 tautological test | info | resolved | Replaced with a real near-copy test through a 10-word n-gram guard in compileAgentHeader. |
| F15 names from spec | info | not acted (by design) | — |

```json keryx:findings
[
  {
    "id": "R2-F1",
    "severity": "minor",
    "title": "Sentinel detection is still substring-anywhere: `--force` overwrites and uninstall deletes a user-owned file that merely quotes the sentinel prefix",
    "file": "src/agents/export.ts",
    "line": 204,
    "detail": "decideAction treats any file whose text contains AGENT_SENTINEL_PREFIX ('keryx-managed: keryx agents export (') anywhere as keryx-owned. A hand-authored file that mentions the prefix in prose has no content-sha256, so it fails verifyAgentContentHash and gets 'refuse-modified' instead of 'refuse-unmanaged'. `--force` is documented as 'never a file with no keryx-managed sentinel at all', yet it then overwrites the file. scanManagedAgentExports (line 461) uses the same substring test, so `integrations uninstall --surface agents` deletes such a file. This is the unfixed half of R1-F9's suggested fix ('match the sentinel only on its expected line'), and the new --force path widens its effect from a wrong 'update' to user-authorised data loss.",
    "class_scope": {
      "sites": [
        "src/agents/export.ts:204 (decideAction managed test)",
        "src/agents/export.ts:461 (scanManagedAgentExports → removeManagedAgentExports / hasManagedAgentExports)",
        "src/security/audit-harness/checks.ts:597 (sentinelLines uses includes, same class)"
      ],
      "enumeration_method": "Searched for every consumer of AGENT_SENTINEL_PREFIX in src/agents and src/security/audit-harness; reproduced the export and uninstall sites with the CLI."
    },
    "impact": "A user's own agent file that documents keryx's sentinel is overwritten by `agents export --force` and silently deleted by `integrations uninstall --surface agents`.",
    "suggested_fix": "Recognise a file as managed only when its sentinel sits on the renderer's sentinel line (md: the first line after the closing `---` matching `^<!-- keryx-managed: keryx agents export \\(<name>, sha256:[0-9a-f]{64}, model_tier=…, content-sha256:[0-9a-f]{64}\\) -->$`; toml: a `^# keryx-managed: …$` line; kiro: the parsed `prompt` starting with the sentinel), and require the name in the sentinel to match the file stem. Treat anything else as refuse-unmanaged, which --force never overrides, and never delete it on uninstall. Add CLI-level tests for both cases.",
    "evidence": "e2e.out lines 105-123: a hand-authored .claude/agents/architect.md with prose 'keryx-managed: keryx agents export ( …': plain export → written: false (exit 1); `--force` → written: true, and the file is replaced by keryx's architect export. A hand-authored mine.md with the same prose: `integrations uninstall --runtime claude --surface agents` → 'removed', and .claude/agents is empty afterwards.",
    "confidence": "high"
  },
  {
    "id": "R2-F2",
    "severity": "minor",
    "title": "content-sha256 self-verification false-positives on legitimate content: an untouched export becomes permanently 'refuse-modified'",
    "file": "src/agents/compile.ts",
    "line": 252,
    "detail": "finalizeAgentContentHash replaces EVERY occurrence of the 64-zero placeholder in the whole draft, but verifyAgentContentHash (line 267) restores only the FIRST `content-sha256:` occurrence in the file. Two legitimate inputs break the round trip: (1) a body (or role/description) that contains 64 consecutive zeros, for example a null commit/hash example, has that text replaced by the hash as well, so it is also silently corrupted in the export; (2) a description containing `content-sha256:` followed by 64 hex characters sits before the sentinel line in claude/opencode frontmatter and in kiro's JSON, so the verifier checks the wrong span. In both cases the file keryx has just written fails its own verification. After any later source change, a plain re-export and `integrations install --surface agents` report 'refuse-modified' ('appears to have been hand-edited'), and doctor reports 'hand-edited since export', although nobody touched the file. The only way out is --force.",
    "class_scope": {
      "sites": [
        "src/agents/compile.ts:252-255 (global placeholder replace)",
        "src/agents/compile.ts:267-276 (first-occurrence marker lookup)"
      ],
      "enumeration_method": "Called verifyAgentContentHash on freshly compiled output for 4 hosts × 2 adversarial inputs (probe-formats.out tail), then ran a CLI export → source change → re-export cycle."
    },
    "impact": "False 'hand-edited' refusals, and doctor noise, for definitions containing ordinary text. The zeros case also rewrites the definition's own body text in the export.",
    "suggested_fix": "Apply the placeholder substitution and the verification to the sentinel line only: build the sentinel last and hash the content with the sentinel's hash field blanked, or locate the marker by the anchored sentinel regex from R2-F1 rather than indexOf. Add tests with a 64-zero body and a description containing `content-sha256:`.",
    "evidence": "probe-formats.out: 'zeros-in-body claude/codex/kiro/opencode selfVerify= false'; 'marker-in-desc claude/kiro/opencode selfVerify= false'. e2e.out lines 129-134: project agent `zed` whose body contains 64 zeros, export → written: true; description changed → 'reason: existing file's content no longer matches the content-sha256 … hand-edited', written: false, exit 1.",
    "confidence": "high"
  },
  {
    "id": "R2-F3",
    "severity": "minor",
    "title": "Audit still treats `tools: null` / `tools: ~` as a restriction, contrary to the guide's new claim",
    "file": "src/security/audit-harness/checks.ts",
    "line": 632,
    "detail": "toolsIsEmpty recognises only '', '\"\"' and \"''\". YAML null spellings (`null`, `Null`, `~`) parse as null, which Claude Code treats like an omitted key (inherit every tool), yet checkAgentUnrestrictedTools reports no finding for them. The updated guide (Auditing section) now states that an 'explicitly empty or null `tools` value in a Claude-shaped file' is flagged. The exporter no longer emits null (R1-F4 is fixed there), so this affects hand-written or tampered host files, which is exactly what the audit exists for.",
    "class_scope": {
      "sites": [
        "src/security/audit-harness/checks.ts:630-635",
        "docs/docs/guides/agent-catalog.md (Auditing section, 'empty or null `tools` value')"
      ],
      "enumeration_method": "Called checkAgentUnrestrictedTools on a claude md for each value: null, ~, Null, [], \"\", empty, spaces."
    },
    "impact": "A hand-written .claude/agents file that inherits all tools passes the audit, and the guide claims otherwise.",
    "suggested_fix": "Parse the frontmatter value with Bun.YAML (or normalise it) and treat null, an empty string or an empty sequence as unrestricted, or correct the guide sentence. Add the null/~ cases to audit-harness.test.ts.",
    "evidence": "Probe output: 'null findings= 0', '~ findings= 0', 'Null findings= 0', '\"\" findings= 1', ' findings= 1'.",
    "confidence": "high"
  },
  {
    "id": "R2-F4",
    "severity": "minor",
    "title": "Guide says an empty tools[] maps to codex sandbox_mode \"read-only\"; a workspace-write definition exports workspace-write",
    "file": "docs/docs/guides/agent-catalog.md",
    "line": 93,
    "detail": "The new 'Empty `tools[]`' section states that for Codex 'an empty `tools[]` maps to `sandbox_mode = \"read-only\"`'. renderCodexExport derives sandbox_mode from policy_profile alone, so a workspace-write definition with tools: [] exports `sandbox_mode = \"workspace-write\"`. The claude/opencode/kiro sentences in that section are accurate: claude and kiro get the read baseline regardless of profile.",
    "class_scope": {
      "sites": [
        "docs/docs/guides/agent-catalog.md:92-93"
      ],
      "enumeration_method": "Compiled {policy_profile: workspace-write, tools: []} for all four hosts (probe-formats.out 'adv-ww-empty')."
    },
    "impact": "Users relying on empty tools[] as a least-privilege switch get a writable codex sandbox. This is also a cross-host inconsistency (claude/kiro/opencode read-only, codex workspace-write).",
    "suggested_fix": "Either make codex honour empty tools[] (emit read-only when no mutation tool is named) for parity with the other hosts, or change the sentence to 'codex follows policy_profile only; tools[] does not affect sandbox_mode'.",
    "evidence": "probe-formats.out: 'adv-ww-empty codex PARSE OK … sandbox=workspace-write', while claude tools=\"Read, Grep, Glob\", kiro [\"read\"], opencode edit/bash deny.",
    "confidence": "high"
  },
  {
    "id": "R2-F5",
    "severity": "info",
    "title": "doctorIntegration's new explicit-surface option is unreachable from the CLI; `integrations doctor --surface agents` is silently ignored",
    "file": "src/commands/integrations.ts",
    "line": 360,
    "detail": "handleDoctor calls doctorIntegration(cwd, adapter.id) without passing the new DoctorOptions.surfaces and does not parse --surface (or reject it as unknown). Before opting in, a user cannot use doctor to ask about the agents surface. The R1-F8 default-noise fix itself holds, and an installed agents surface is still reported.",
    "class_scope": {
      "sites": [
        "src/commands/integrations.ts:340-363"
      ],
      "enumeration_method": "Searched for doctorIntegration( callers."
    },
    "impact": "The new option is exercised only by tests. The flag is accepted and silently has no effect.",
    "suggested_fix": "Pass `surfaces: collectRepeatable(args, \"--surface\")` through handleDoctor and list it in the doctor usage line, or drop the option.",
    "evidence": "integrations.ts:360; e2e.out lines 28-34 (the --surface output matches the no-flag output).",
    "confidence": "high"
  },
  {
    "id": "R2-F6",
    "severity": "info",
    "title": "R1-F12 residual: the sentinel-line anchor is weak for kiro JSON and TOML `model` key detection is unchanged",
    "file": "src/security/audit-harness/checks.ts",
    "line": 596,
    "detail": "sentinelLines keeps any line that contains the prefix. In a kiro JSON file the whole `prompt` value sits on one line, so a hand-written kiro file whose prompt prose mentions the prefix and 'model_tier=deep' suppresses agent-missing-model-tier. tomlHasKey('model') still matches a `model =` line inside developer_instructions. This is low-severity heuristic hardening only.",
    "class_scope": {
      "sites": [
        "src/security/audit-harness/checks.ts:596-603"
      ],
      "enumeration_method": "Probe: checkAgentMissingModelTier on a kiro JSON with prose sentinel text → 0 findings."
    },
    "impact": "The audit can suppress a finding on a hand-written kiro file.",
    "suggested_fix": "Reuse the anchored sentinel regex from R2-F1. For kiro, test only the first line of the parsed prompt.",
    "evidence": "'kiro prose-in-prompt tier findings= 0'.",
    "confidence": "high"
  }
]
```
