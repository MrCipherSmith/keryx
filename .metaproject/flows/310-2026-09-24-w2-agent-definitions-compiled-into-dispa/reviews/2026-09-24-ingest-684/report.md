# Review 310 R1 — PR #684 (W2 agent-definition catalogue), adversarial round 1

Scope: the PR diff (58 files) on flow/310-w2 in /Users/Goodea/goodea/keryx-ape-310-w2. Every finding below was reproduced with a probe script, a CLI run in a scratch git repo, or a direct code trace. The probe scripts and their outputs are in scratchpad/review310/. The targeted suites pass: 498 pass, 0 fail across 24 files (src/agents, src/integrations, src/security/audit-harness, agents CLI tests, the xref test, import-policy.live and import-zones). `integrations matrix --check` passes. D-2 holds: the PR changes nothing under src/harness/, `spawn_subagent`'s inputSchema is untouched, and the compiled keryx-shell `input` keys are a subset of the real tool's keys. No external toolkit or project is named anywhere in the diff.

Process note: one of my CLI probes passed an unsupported `--root` flag to `keryx integrations install`/`uninstall`. The flag was ignored silently, so the commands ran against the review worktree itself. The run rewrote `.claude/settings.json` and created `.claude/agents/` (10 files). I restored both straight away with `git checkout -- .claude/settings.json` and by removing the untracked directory I had created, and I kept a copy of those files as evidence. Before my run the worktree already had two uncommitted flow files, flow.json and journal.md (modified 09:08, before my 09:10 run). I did not touch them.

```json keryx:findings
[
  {
    "id": "R1-F1",
    "severity": "blocker",
    "title": "Claude and OpenCode exports write unescaped YAML frontmatter; 6 of 10 bundled agents produce invalid YAML",
    "file": "src/agents/compile.ts",
    "line": 200,
    "detail": "renderClaudeExport interpolates `description: ${definition.description}` (and `name`, `tools`) as raw YAML plain scalars. renderOpencodeExport does the same for `description`. The frontmatter loader (frontmatter.ts stripQuotes) removes the author's quotes, so a description like `...tradeoffs for a proposed change: module boundaries, ...` is emitted as `description: Reasons about ... change: module boundaries ...`. A strict YAML parser rejects that ('mapping values not allowed'). Measured with Bun.YAML.parse on the frontmatter of every bundled export: architect, doc-updater, performance-reviewer, security-reviewer, silent-failure-hunter and tdd-guide fail for BOTH claude and opencode. Only code-explorer, e2e-runner, planner and refactor-cleaner parse. The same defect class has three more cases: a description containing ` #` is silently truncated (the round trip fails), a description starting with `- ` fails to parse, and a description containing a newline injects frontmatter keys. The adversarial probe `line1\\ntools: Bash, Edit\\npermissionMode: default` parsed with an extra `permissionMode` key on claude and extra `tools`/`permissionMode` keys on opencode. The codex renderer has a sibling gap: tomlMultilineString does not escape control characters, so a body containing U+0007 produces TOML that Bun.TOML rejects ('Control character must be escaped'). None of the tests parse the rendered YAML/TOML. The audit harness's frontmatter reader is a lenient line splitter, so AC11's 'zero findings' passed on files a real host cannot load.",
    "class_scope": {
      "sites": [
        "src/agents/compile.ts:199-201 (claude name/description/tools lines)",
        "src/agents/compile.ts:345-355 (opencode description line)",
        "src/agents/compile.ts:240-244 (codex tomlMultilineString: no control-char escaping)",
        "src/agents/frontmatter.ts:37-46 (stripQuotes drops quoting without unescaping, e.g. 'It''s' stays doubled)",
        "src/agents/export.test.ts:213-226 and baseline.test.ts (assert substrings only; never parse output with a YAML/TOML parser)"
      ],
      "enumeration_method": "Compiled every bundled agent for claude/opencode/codex/kiro and parsed each output with Bun.YAML/Bun.TOML/JSON.parse (probe-formats.ts), plus adversarial descriptions/bodies containing ': ', '#', a leading '- ', newlines, '\"\"\"' and control chars. Read every string-interpolation site in the four host renderers."
    },
    "impact": "Claude Code and OpenCode fail to load, or skip, most of the shipped catalogue after `keryx agents export` or `integrations install --surface agents`. AC9's 'host formats follow first-party docs' does not hold. A future generated or imported definition whose description contains a newline can inject host permission keys.",
    "suggested_fix": "Emit every YAML scalar through one quoting helper: JSON.stringify output is valid YAML double-quoted scalar syntax, so use it for name, description and the tools string. Reject control characters and newlines in description/role at validation, or escape them. Escape control characters in tomlMultilineString, or reuse tomlString for developer_instructions. Add a test that parses every bundled × host output with Bun.YAML/Bun.TOML/JSON and round-trips description plus body.",
    "evidence": "probe-formats.ts output: 'architect claude PARSE ERROR: YAML Parse error: Unexpected token' (same for opencode and the 5 other agents); 'adv-nl claude PARSE OK ... keys=name,description,tools,permissionMode,model'; 'adv-ctrl codex PARSE ERROR: TOML Parse error: Control character must be escaped'. An exported file (scratchpad/review310/accidental-claude-agents/architect.md line 3) shows the unquoted 'change: module boundaries' description.",
    "confidence": "high"
  },
  {
    "id": "R1-F2",
    "severity": "blocker",
    "title": "`keryx integrations install --surface agents` exits 1 with EISDIR in any Keryx-initialized project",
    "file": "src/integrations/installer.ts",
    "line": 448,
    "detail": "When customInstall succeeds, installIntegration calls recordSurfaceInstalled with writtenPaths: [surface.relativePath] and no hashPaths. For the agents surface, relativePath is a DIRECTORY ('.claude/agents' etc.). recordSurfaceInstalled hashes `entry.hashPaths ?? entry.writtenPaths` through sha256OfFile, which calls readFile on the directory and throws EISDIR. The throw happens outside the N1 try/catch, so it escapes installIntegration after the agent files are already on disk. In a scratch repo WITH a .metaproject directory, `install --runtime claude --surface agents` printed '✗ EISDIR: illegal operation on a directory, read', exited 1, wrote 10 files and recorded no install-state. `--runtime all --surface agents` fails the same way for claude, codex, kiro and opencode. A repo WITHOUT .metaproject succeeds because nothing gets recorded, and that case is the only one the tests exercise. No test exercises the agents surface through installIntegration at all: a search of the test files for surfaces-agents or AGENTS_CLAUDE found 0 matches. doctor's shaDriftedSinceInstall (installer.ts:659-664) would hit the same EISDIR as soon as a record exists.",
    "class_scope": {
      "sites": [
        "src/integrations/installer.ts:447-454 (custom-surface recordSurfaceInstalled with writtenPaths=[directory], no hashPaths)",
        "src/integrations/install-state.ts:55-59 (sha256OfFile reads a directory)",
        "src/integrations/installer.ts:659-664 (doctor shaDriftedSinceInstall, same read on the recorded path)",
        "src/integrations/surfaces-agents.ts:121-123 (settingsFile/relativePath point at a directory, unlike every other surface)"
      ],
      "enumeration_method": "Ran the CLI end to end in scratch repos with and without .metaproject. Traced every consumer of surface.relativePath/settingsFile that assumes a file (install record, doctor hash, uninstall dry-run pathExists)."
    },
    "impact": "The documented bulk path (OQ-W2.2, guide 'keryx integrations install --runtime <id> --surface agents') is broken in every real project. It reports failure after writing files. Nothing is recorded, so doctor shows the surface as 'not recorded' and drift tracking never works.",
    "suggested_fix": "For the agents surface, record the actual written file paths returned by installAgentsExports, or pass hashPaths: [] for directory-backed custom surfaces. Make sha256OfFile skip non-files. Add an installIntegration test for `--surface agents` in a root that contains .metaproject, covering the doctor round trip.",
    "evidence": "scratchpad/review310/repo3 (.metaproject present): 'keryx integrations install ... ✗ EISDIR: illegal operation on a directory, read', exit=1, `ls .claude/agents | wc -l` = 10. repo2 (no .metaproject): installed, exit 0.",
    "confidence": "high"
  },
  {
    "id": "R1-F3",
    "severity": "major",
    "title": "Export follows symlinks: a dangling symlink or symlinked agents directory makes keryx write outside the project root",
    "file": "src/agents/export.ts",
    "line": 284,
    "detail": "planAgentExport reads the target through readFile, which follows symlinks. A dangling symlink returns ENOENT, so the action is 'create', and writeAgentExport then calls mkdir + writeFile, which also follow symlinks. Reproduced: in a repo containing `.claude/agents/code-explorer.md -> <outside>/outside-target.txt` (dangling), `keryx agents export --runtime claude code-explorer` reported 'action: create ... written: true' and created the outside file. With `.codex/agents -> <outside-dir>` the export wrote planner.toml into the outside directory. A cloned repo controls both the symlink and the content, because a project `.metaproject/agents/<name>.md` overrides the bundled body. That makes this an attacker-controlled write outside the root, reachable through `agents export` and through `integrations install --surface agents`. removeManagedAgentExports skips symlinked files (Dirent.isFile), but it still descends into a symlinked agents directory and deletes sentinel-bearing files outside the root.",
    "class_scope": {
      "sites": [
        "src/agents/export.ts:119-127 (readExistingFileContent follows symlinks)",
        "src/agents/export.ts:284-286 (mkdir/writeFile follow symlinks, no containment check)",
        "src/agents/export.ts:311-336 (removeManagedAgentExports walks a symlinked directory)",
        "src/integrations/surfaces-agents.ts:55-75 (bulk install path reaches the same writer)"
      ],
      "enumeration_method": "Listed every fs call in export.ts and surfaces-agents.ts. Reproduced the file-symlink and directory-symlink cases with the real CLI in scratchpad/review310/repo4 and repo5."
    },
    "impact": "Running export/install in an untrusted checkout writes attacker-chosen content to an attacker-chosen path under the user's account, for example a shell rc file or an autostart location.",
    "suggested_fix": "lstat the target and every parent from the root. Refuse when any component is a symlink, or when realpath(dirname) is not inside realpath(root) (src/lib/fs isPathInside already exists). Write through a temp file plus rename. Apply the same guard in removeManagedAgentExports. Add regression tests for a dangling-file symlink and a directory symlink.",
    "evidence": "repo4: 'action: create / path: .claude/agents/code-explorer.md / written: true'; `ls -la outside-target.txt` shows 2433 bytes. repo5: outside-dir contains planner.toml.",
    "confidence": "high"
  },
  {
    "id": "R1-F4",
    "severity": "major",
    "title": "Empty or fully-unmapped tools[] yields a Claude `tools:` null, which inherits ALL tools; the audit passes it",
    "file": "src/agents/compile.ts",
    "line": 201,
    "detail": "The schema and the guide say an empty tools[] means 'no tools beyond the target harness's own read-only baseline'. renderClaudeExport emits `tools: ${mappedTools.join(', ')}`. When tools is [], or contains only entries with no claude mapping (get_cwd, graph_affected, memory_search), the output is the bare `tools: ` line, which YAML parses as null. The probe confirms parsed tools=null for both cases. Claude Code's documented behaviour is that an omitted tools field inherits every tool (Read, Edit, Write, Bash, ...), so the most restricted definition becomes the least restricted export. checkAgentUnrestrictedTools only tests whether a `tools` key is present, so the audit reports nothing. verify does not flag an empty or fully-dropped tool list either.",
    "class_scope": {
      "sites": [
        "src/agents/compile.ts:196-201 (claude tools line when mappedTools is empty)",
        "src/security/audit-harness/checks.ts:474-480 (md branch treats key presence as a restriction, so `tools:` null passes)",
        "src/agents/verify.ts:180-185 (no check that a host export keeps at least the intended restriction)"
      ],
      "enumeration_method": "probe-formats.ts cases adv-empty-tools and adv-unmapped for all four hosts (kiro emits [] correctly; opencode's permission map denies correctly; codex governs access by sandbox_mode). Also read the audit md branch."
    },
    "impact": "Least-privilege inversion on the one host marked 'verified/native': a definition that intends no tools exports as a Claude subagent with full edit and shell access.",
    "suggested_fix": "When mappedTools is empty, emit an explicit minimal allowlist (for example `tools: Read`, matching the documented read baseline) or refuse the claude export with a named reason. Never emit an empty `tools:` line. Have the audit treat a null or empty `tools` as unrestricted.",
    "evidence": "probe output: 'adv-empty-tools claude PARSE OK ... tools=null'; 'adv-unmapped claude PARSE OK ... tools=null'.",
    "confidence": "medium"
  },
  {
    "id": "R1-F5",
    "severity": "major",
    "title": "Claude and Kiro exporters ignore policy_profile: a read-only definition exports with Edit/Bash (claude) and write/shell (kiro)",
    "file": "src/agents/compile.ts",
    "line": 196,
    "detail": "Only the opencode renderer combines tools[] with policy_profile (canWrite gate). renderClaudeExport and renderKiroExport map tools[] as written. A read-only definition naming apply_patch or shell_exec therefore exports as Claude `tools: Read, Edit, Bash` and Kiro `tools: [read, write, shell]`, while the same definition exports as edit: deny / bash: deny for opencode and sandbox_mode = read-only for codex. verify never flags the inconsistency. The guide promises 'read-only — no mutation tools'. No bundled agent triggers this today, but nothing prevents a project definition from doing so.",
    "class_scope": {
      "sites": [
        "src/agents/compile.ts:195-215 (claude)",
        "src/agents/compile.ts:301-320 (kiro)",
        "src/agents/verify.ts:180-197 (no tools-vs-policy_profile consistency check)",
        "src/agents/compile.ts:335-344 (opencode: the one correct site, reference implementation)"
      ],
      "enumeration_method": "probe-formats.ts adv-ro-write compiled for all four hosts. Also read every renderer for policy_profile usage."
    },
    "impact": "Host-dependent privilege for the same definition. The read-only guarantee holds on opencode, codex and keryx-shell but not on claude or kiro.",
    "suggested_fix": "Filter mutation tools (apply_patch, shell_exec) out of claude and kiro output when policy_profile is read-only, and report them in droppedTools. Also add a verify problem (for example 'tools-exceed-policy') so the definition fails verify.",
    "evidence": "probe: 'adv-ro-write claude ... tools=\"Read, Edit, Bash\"'; 'adv-ro-write kiro ... tools=[\"read\",\"write\",\"shell\"]'; 'adv-ro-write opencode perm={edit:deny,bash:deny,...}'.",
    "confidence": "high"
  },
  {
    "id": "R1-F6",
    "severity": "major",
    "title": "The keryx-shell policy sidecar is unenforced and presented as enforcement; workspace-write agents compile to children that cannot write or run anything",
    "file": "src/agents/compile.ts",
    "line": 170,
    "detail": "compileKeryxShell puts tools/policy_profile/isolation into a `policy` sidecar ({profile, toolAllowlist, isolation}). Nothing in the codebase consumes it. spawn_subagent builds the child's tool set from `mode` only (spawn-subagent-tool.ts:688-698), and the `general` branch there is 'still no shell_exec' and gives the SAME read-only and metaproject tools as read_only. So the four workspace-write bundled agents (tdd-guide, refactor-cleaner, doc-updater, e2e-runner) compile to children with no apply_patch, shell_exec or web tools. isolation: worktree (tdd-guide, refactor-cleaner) is never requested either. Yet planAgentExport reports droppedTools: [] ('nothing is silently dropped for keryx-shell'). The CLI prints '## policy {profile: shellParentProfile, toolAllowlist: [...]}' with no not-enforced note. The guide says workspace-write means 'mutation allowed' and that isolation is honoured 'where the target supports it' (keryx-shell does support worktree isolation). skills, output_contract and stacks are not projected anywhere. In the AC2 test, the field→destination table is `void`-ed ('documents intent') and labels those fields 'header' although they are not in the header. AC2's 'none silently dropped' therefore holds only on paper.",
    "class_scope": {
      "sites": [
        "src/agents/compile.ts:154-177 (sidecar produced; no consumer)",
        "src/agents/export.ts:184-193 (droppedTools: [] claim for keryx-shell)",
        "src/commands/agents-catalog.ts:216,287-288 (CLI prints the sidecar as if applied)",
        "docs/docs/guides/agent-catalog.md:35,85-87 (isolation and 'mutation allowed' claims)",
        "src/agents/compile.spawn-subagent.test.ts:104-118 (voided destinations table)",
        "src/agents/policy.ts:36-45 (shellParentProfile name never resolved by any caller)"
      ],
      "enumeration_method": "Searched for consumers of `policy.toolAllowlist`/`profileName`/`policy.isolation` outside src/agents (none). Read spawn_subagent's mode→tools construction. Compared every AgentDefinition field against the compiled input and sidecar."
    },
    "impact": "Orchestrators that dispatch the compiled tdd-guide/refactor-cleaner/e2e-runner through keryx-shell get children that cannot do their job. Operators reading the CLI or docs believe a tool allowlist and worktree isolation apply when they do not.",
    "suggested_fix": "Within D-2, report every tools[] entry the chosen mode cannot provide in droppedTools for keryx-shell (for general: apply_patch, shell_exec, web_*). Report isolation: worktree as 'not requestable via spawn_subagent input'. Label the sidecar 'advisory — not enforced by spawn_subagent' in the CLI, JSON and guide. Fix the guide's 'mutation allowed' line. Replace the voided destinations table with assertions, or document skills, output_contract and stacks as intentionally not dispatched.",
    "evidence": "spawn-subagent-tool.ts:688-698 (`// v1 general: still no shell_exec`, identical tool lists). A search for toolAllowlist outside src/agents finds no consumer. compile.spawn-subagent.test.ts:118 `void destinations`.",
    "confidence": "high"
  },
  {
    "id": "R1-F7",
    "severity": "minor",
    "title": "AC6 stack-pack check fails open through path traversal in origin.sourceRef",
    "file": "src/agents/verify.ts",
    "line": 106,
    "detail": "defaultStackPackExists joins sourceRef under <bundled>/stacks without validating its shape. A generated definition with `sourceRef: ../agents` resolves to the existing bundled agents directory and passes verify. `..` or any absolute or relative path to an existing directory passes too, so the 'fail closed unless positively confirmed' gate can be satisfied by any directory.",
    "class_scope": {
      "sites": [
        "src/agents/verify.ts:102-113"
      ],
      "enumeration_method": "Ran the CLI in scratchpad/review310/repo6 with gen-trav.md (sourceRef ../agents): 'ok: true ● gen-trav (project)'."
    },
    "impact": "A generated or imported definition can claim provenance from a non-existent stack pack and still verify.",
    "suggested_fix": "Require sourceRef to match the stack-pack id pattern (for example ^[a-z][a-z0-9-]*$) before resolving, and confirm the resolved path stays inside stacksRoot.",
    "evidence": "repo6 run output shown above.",
    "confidence": "high"
  },
  {
    "id": "R1-F8",
    "severity": "minor",
    "title": "Opt-in agents surface is still probed by default doctor (10 'not yet exported' lines per runtime); uninstall dry-run misreports",
    "file": "src/integrations/installer.ts",
    "line": 696,
    "detail": "doctorIntegration iterates adapter.surfaces without the optIn filter. In a project that never opted in, `keryx integrations doctor --runtime claude` now prints '· agents (agents) — invalid (not recorded)' plus one line per catalogue agent. codex, kiro and opencode behave the same, and `--json` has the same content. ok stays true, but the default doctor output regressed from what it showed before this PR. Separately, customUninstallDryRun (installer.ts:271) has no inspect for agents and reports 'would-remove' whenever the directory exists, even when it holds only user-owned files that the real uninstall would leave alone. Default `integrations uninstall --runtime claude` leaves exported agent files in place (opt-in exclusion). That is acceptable, but the guide does not document it.",
    "class_scope": {
      "sites": [
        "src/integrations/installer.ts:696-708 (doctor ignores optIn)",
        "src/integrations/installer.ts:260-273 (dry-run uninstall judged by directory existence)"
      ],
      "enumeration_method": "Ran `integrations doctor` before install in a scratch repo. Read every adapter.surfaces loop in installer.ts."
    },
    "impact": "Noisy, misleading doctor output for every user of four runtimes. Dry-run and real uninstall disagree.",
    "suggested_fix": "In doctor, skip an optIn surface that has no install record, or show it as 'opt-in, not installed'. Give the agents surface an inspect() that counts sentinel files.",
    "evidence": "Doctor output in a fresh repo: '· agents (agents) — invalid (not recorded)' followed by 10 'claude/<name>: not yet exported' lines.",
    "confidence": "high"
  },
  {
    "id": "R1-F9",
    "severity": "minor",
    "title": "A hand-edited managed export is silently overwritten, contrary to the guide",
    "file": "src/agents/export.ts",
    "line": 145,
    "detail": "decideAction treats any file containing the sentinel prefix as keryx-owned and returns 'update' whenever its content differs. The sentinel hashes the SOURCE definition, not the rendered content, so hand edits to an exported file (with the sentinel line kept) are lost without warning on the next export or install. The guide says export 'will not silently clobber a file you edited by hand'. The substring match anywhere in the file also means a user file that merely quotes the sentinel prefix counts as managed.",
    "class_scope": {
      "sites": [
        "src/agents/export.ts:143-153",
        "docs/docs/guides/agent-catalog.md:148-150"
      ],
      "enumeration_method": "Code trace of decideAction against the guide claim."
    },
    "impact": "Silent data loss of local edits to exported agent files.",
    "suggested_fix": "Store a hash of the rendered content in the sentinel, or recompute the expected content for the recorded source hash, and refuse or report 'locally-modified' on mismatch. Match the sentinel only on its expected line.",
    "evidence": "export.ts:151-152: `if (existing === generated) return unchanged; return { action: \"update\" }` with no content-hash check.",
    "confidence": "high"
  },
  {
    "id": "R1-F10",
    "severity": "minor",
    "title": "Import cycle integrations/registry ↔ surfaces-agents ↔ agents/export has a TDZ crash when surfaces-agents loads first",
    "file": "src/integrations/registry.ts",
    "line": 55,
    "detail": "surfaces-agents.ts imports agents/catalog and agents/export, and export.ts imports integrations/registry. If surfaces-agents.ts is the first module loaded, registry evaluates HARNESS_ADAPTERS while AGENTS_CLAUDE is still uninitialised. Every other entry point (agents/export, verify, index, service, audit-harness/surfaces, registry, integrations/index) loads fine. The failure is latent today because only registry imports surfaces-agents, but a test or tool that imports it directly crashes at load.",
    "class_scope": {
      "sites": [
        "src/integrations/registry.ts:37,55 (eager array literal referencing AGENTS_*)",
        "src/integrations/surfaces-agents.ts:30-31 (imports back into src/agents)",
        "src/agents/export.ts:26-27 (imports registry/matrix)"
      ],
      "enumeration_method": "Imported each of the 8 modules first in a fresh bun process and read getHarnessAdapter('claude').surfaces."
    },
    "impact": "Fragile module-load order. It will break the first direct import of surfaces-agents.",
    "suggested_fix": "Break the cycle. Inject the catalog/export functions into the surface via a lazy import() inside customInstall/probe, or move agentExportSupport's registry read behind a lookup parameter supplied by integrations.",
    "evidence": "`bun -e \"await import('./src/integrations/surfaces-agents.ts')\"` → ReferenceError: Cannot access 'AGENTS_CLAUDE' before initialization at registry.ts:55:121.",
    "confidence": "high"
  },
  {
    "id": "R1-F11",
    "severity": "minor",
    "title": "Agent-catalog guide makes claims the code does not back",
    "file": "docs/docs/guides/agent-catalog.md",
    "line": 25,
    "detail": "(a) The frontmatter table lists `schema_version` as 'string, required: yes'. The schema and validator make it an optional integer const 1. (b) Line 29 says an empty tools[] means 'no tools beyond the harness's own read baseline', which is false for claude (R1-F4). (c) Lines 130-132 say verify checks 'every export target named on a definition has a corresponding support record'. Definitions name no targets; verify computes all five, agentExportSupport never throws, and the 'no-export-support' reason is unreachable. (d) Lines 166-169 say the audit scans '.metaproject/agents/ and .claude/agents/'. After T13 it scans all four host directories plus .toml/.json. (e) The 'mutation allowed' and isolation claims are covered in R1-F6.",
    "class_scope": {
      "sites": [
        "docs/docs/guides/agent-catalog.md:25",
        "docs/docs/guides/agent-catalog.md:29",
        "docs/docs/guides/agent-catalog.md:130-132",
        "docs/docs/guides/agent-catalog.md:166-169",
        "src/agents/verify.ts:216-227 (unreachable no-export-support branch)"
      ],
      "enumeration_method": "Checked each factual sentence in the guide against schema.ts, verify.ts, compile.ts and audit-harness/surfaces.ts."
    },
    "impact": "Users author definitions against a wrong field type and trust guarantees that do not exist.",
    "suggested_fix": "Correct the table and the listed sentences. Either drop 'no-export-support' or make it reachable (for example, a native/adapter level with no renderer).",
    "evidence": "schema.ts:187 requires schema_version === 1; agentExportSupport (export.ts:79-85) has no throwing path.",
    "confidence": "high"
  },
  {
    "id": "R1-F12",
    "severity": "info",
    "title": "Audit agent-definitions checks are presence-only; the model_tier= fallback is not anchored to the sentinel",
    "file": "src/security/audit-harness/checks.ts",
    "line": 500,
    "detail": "MODEL_TIER_SENTINEL_RE is tested against the whole file, so a hand-written .claude/agents or .opencode/agents file that mentions 'model_tier=deep' anywhere, even in body prose, suppresses agent-missing-model-tier. tomlHasKey('model') is a multiline ^model= regex, so it also matches a line inside developer_instructions. The allowlist checks accept `sandbox_mode = \"danger-full-access\"`, `permission: {bash: allow}` and `tools:` null (R1-F4) as restricted. .toml/.json files under .metaproject/agents and .claude/agents are now scanned as agent files, a small false-positive surface. Acceptable for a low-severity heuristic, but the fallback should match only the sentinel line.",
    "class_scope": {
      "sites": [
        "src/security/audit-harness/checks.ts:456,494-500",
        "src/security/audit-harness/checks.ts:434-436",
        "src/security/audit-harness/surfaces.ts:580,594-604"
      ],
      "enumeration_method": "Code read of the T13 check changes."
    },
    "impact": "Low-severity suppression is possible in hand-written host files. No regression for existing fixtures: the audit-harness suite passes.",
    "suggested_fix": "Anchor the regex to the sentinel text ('keryx-managed: keryx agents export (... model_tier=X)'). Parse TOML keys only outside multiline strings, or match only before developer_instructions.",
    "evidence": "checks.ts:500 `|| MODEL_TIER_SENTINEL_RE.test(content)` on the full content.",
    "confidence": "high"
  },
  {
    "id": "R1-F13",
    "severity": "info",
    "title": "xref guard now accepts catalogue agent names as dispatch targets on every host",
    "file": "src/gdskills/agent-catalogue-xref.test.ts",
    "line": 153,
    "detail": "knownAgentNames() now includes every bundled or project agent-definition name. A shipped skill writing `subagent_type: \"planner\"` passes the guard, but that dispatch resolves on a host only after the user has opted in to `--surface agents` and the export parses (see R1-F1/F2). The guard is looser by design (AC5), but it should not imply the name is always dispatchable.",
    "class_scope": {
      "sites": [
        "src/gdskills/agent-catalogue-xref.test.ts:141-144,153"
      ],
      "enumeration_method": "Code read."
    },
    "impact": "A skill could rely on an agent that is absent on hosts without the opt-in export.",
    "suggested_fix": "Accept catalogue names only in keryx-shell dispatch positions, or document the opt-in dependency next to the guard.",
    "evidence": "Line 153: `for (const name of knownAgentCatalogNames()) names.add(name);`.",
    "confidence": "medium"
  },
  {
    "id": "R1-F14",
    "severity": "info",
    "title": "One AC3 guard test is tautological",
    "file": "src/agents/baseline.test.ts",
    "line": 60,
    "detail": "The 'divergent copy' test asserts only JavaScript string semantics (`x + ' '` includes x but does not equal x) and exercises no compiler code. A lightly edited copy of the baseline inside a body (reworded or re-wrapped) is not detected: compileAgentHeader checks exact includes() only. AC3 coverage of bundled × host exports lives in export.test.ts:213-226 and is real. keryx-shell over the bundled catalogue is covered only by 2 fixtures.",
    "class_scope": {
      "sites": [
        "src/agents/baseline.test.ts:60-66",
        "src/agents/compile.ts:427"
      ],
      "enumeration_method": "Code read of all PROMPT_DEFENSE_BASELINE test usages."
    },
    "impact": "The test gives false assurance about drift detection.",
    "suggested_fix": "Replace it with a compiler-level check, for example flagging bodies that share a long n-gram with the baseline, or delete it.",
    "evidence": "Lines 63-65.",
    "confidence": "high"
  },
  {
    "id": "R1-F15",
    "severity": "info",
    "title": "Bundled agent names match a well-known third-party agent catalogue name for name",
    "file": "src/gdskills/bundled/agents",
    "line": 1,
    "detail": "The ten names (planner, architect, tdd-guide, refactor-cleaner, doc-updater, e2e-runner, security-reviewer, ...) come from the W2 spec, and no external project is named anywhere in the diff (searched). Because they match an existing public catalogue verbatim, the 'redesign, don't copy' rule deserves an owner check. Info only; the spec fixes these names, not this PR.",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/agents/*.md"
      ],
      "enumeration_method": "Name comparison; diff search for external project names returned 0 matches."
    },
    "impact": "Possible provenance or optics concern.",
    "suggested_fix": "Owner decision; no code change required.",
    "evidence": "W2 spec and bundled file list.",
    "confidence": "medium"
  }
]
```
