# Flow 361 review round 4 — verification at PR #811 head b0e9609f

Verification-only round, past the CLI's 3-round cap: the owner (MrCipherSmith) instructed
the merge of PR #811 in this session on 2026-10-01, which is the operator decision the cap
asks for. No new reviewer fan-out and no code change since round 3: the branch was only
rebased onto a newer main (#810, 0.3.44; base 51497ac5). The fourteen findings are carried
forward unchanged, and review-verifier re-ran every fixed finding's reproduction against
the code at head b0e9609f. After the rebase the fix commits are f40b7245 (round 1,
F-001…F-011; was e0d930f0) and 387ec28f (F-014; was 93200604), both contained in b0e9609f.

- F-001…F-011: fixed in f40b7245; every reproduction re-run at b0e9609f no longer reproduces.
- F-014: fixed in 387ec28f; r2-worktree-ac6-probe.ts no longer reproduces at b0e9609f.
- F-012, F-013 (info): not fixed; dismissed by the owner (decided-by: MrCipherSmith, 2026-10-01).

F-013 is carried from round 1's record: round 2's per-reviewer findings cap truncated it,
so this round is ingested with --max-findings 20 to hold all fourteen.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "Entry-form local root target `path` from the tracked manifest is kept verbatim (only abs/.. /NUL rejected) and appended raw into <git-common-dir>/info/exclude by wantedIgnoreLines -> replaceLocalIgnoreBlock; leading '!', globs, '#', embedded newlines (incl. a fake '# keryx:end') are accepted. The same path is where writeClaudeLocalTarget creates/appends the block.",
    "impact": "A cloned repo whose committed metaproject.json has root [{runtime:'claude',scope:'local',path:'!.env'}] makes `keryx update` write `!.env` into info/exclude, overriding the developer's core.excludesFile ignore of .env -> `?? .env`, staged by `git add -A`. Newlines inject extra lines and break the managed block.",
    "suggested_fix": "Force the standard local path per runtime (as claudeSettings does), or reject control chars and leading '!'/'#' in safeRelativePath; write local-target lines as anchored literal patterns.",
    "evidence": "Reviewer scratch scripts (scratchpad/rs-WShC/): normalizeEntrypointTargets accepts both; syncMetaprojectIgnoreRules on a throwaway repo wrote `!.env`, `!*.pem`, `# keryx:end` into info/exclude; git status showed `?? .env` after the line was added.",
    "confidence": "high",
    "file": "src/rules/entrypoint-targets.ts",
    "line": 191,
    "quote": "  if (value.split(/[\\\\/]/).includes(\"..\")) return undefined;",
    "dedupe_key": "RS-1",
    "class_scope": {
      "sites": [
        "src/rules/entrypoint-targets.ts safeRelativePath",
        "src/rules/entrypoint-targets.ts rootEntryFromRecord",
        "src/rules/entrypoint-writers.ts ignoredLocalTargetPaths",
        "src/lib/metaproject-gitignore.ts wantedIgnoreLines",
        "src/lib/git-local-ignore.ts replaceLocalIgnoreBlock",
        "src/rules/entrypoint-writers.ts writeClaudeLocalTarget"
      ],
      "enumeration_method": "keryx ctx rg for consumers of localTargetPaths/ignoredLocalTargetPaths (init.ts, update.ts, entrypoint-inspection.ts) plus both info/exclude writers"
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "writeCodexLocalTargets reads the manifest's Codex `source` with readFile (follows symlinks) and copies it into AGENTS.override.md without refuseEscapingSymlink; the pre-scaffold guard only covers root-level sources found by readdir, so a subdirectory source through an escaping symlink is never checked.",
    "impact": "A cloned repo commits `home -> /Users/<name>` and a codex entry source 'home/.aws/credentials'; `keryx update`/`rules distill` copies the out-of-repo file into AGENTS.override.md, which Codex loads as instructions and sends to the model provider.",
    "suggested_fix": "refuseEscapingSymlink(projectRoot, entry.source) before reading (writeCodexLocalTargets, codexOverrideState, codexOverrideByteSize); or restrict source to a root-level team file.",
    "evidence": "Reviewer scratch script on a throwaway project: with home -> ../outside, writeCodexLocalTargets produced an AGENTS.override.md containing the outside secret line.",
    "confidence": "high",
    "file": "src/rules/entrypoint-writers.ts",
    "line": null,
    "quote": "    const sourcePath = path.join(projectRoot, entry.source);",
    "dedupe_key": "RS-2",
    "class_scope": {
      "sites": [
        "src/rules/entrypoint-writers.ts writeCodexLocalTargets",
        "src/rules/entrypoint-writers.ts codexOverrideState",
        "src/rules/agent-entrypoints.ts findAgentEntrypoints",
        "src/rules/distill.ts writeCodexLocalTargets call"
      ],
      "enumeration_method": "keryx ctx rg for writeCodexLocalTargets / assertMetaprojectReferenceSafe / findAgentEntrypoints callers"
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "Paths after `--` are still pathspecs (glob/magic); a manifest path with glob chars can make worktreeFileIsClean/indexHoldsFile answer for other files.",
    "impact": "Wrong classification/notice only; no data loss reproduced.",
    "suggested_fix": "--literal-pathspecs or GIT_LITERAL_PATHSPECS=1 in runGit.",
    "evidence": "Throwaway repo: `git diff --quiet -- 's*'` matched modified src.ts.",
    "confidence": "medium",
    "file": "src/lib/git-head.ts",
    "line": 87,
    "quote": "  const result = await runGit(projectRoot, [\"diff\", \"--quiet\", \"--\", relativePath]);",
    "dedupe_key": "RS-3"
  },
  {
    "id": "F-004",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "moveBlockOutOfGitignore restores HEAD only when file-minus-block equals HEAD, but origin/main's legacy writer also deleted team lines outside the block that duplicated keryx's lines (and a blanket .metaproject/ line). Those repos fall to strip-only and the team's lines stay deleted.",
    "impact": "HEAD .gitignore `node_modules/\\n.metaproject/runtime/\\n`, working tree left by the legacy writer as node_modules/ + block: `keryx update` leaves ` M .gitignore` with `-.metaproject/runtime/` and calls it the user's edit; AC8 `git diff --quiet` fails.",
    "suggested_fix": "Before comparing, remove from HEAD the lines the legacy writer would have removed; if equal, take the restore-from-HEAD branch.",
    "evidence": "scratchpad/rl2-gitignore-probe.ts against a temp repo: result file `node_modules/\\n`, status ` M .gitignore`, diff `-.metaproject/runtime/`.",
    "confidence": "high",
    "file": "src/lib/metaproject-gitignore.ts",
    "line": null,
    "quote": "  if (sameApartFromBlankLines(stripped, head)) {",
    "dedupe_key": "RL2-1",
    "class_scope": {
      "sites": [
        "src/lib/metaproject-gitignore.ts moveBlockOutOfGitignore"
      ],
      "enumeration_method": "Compared origin/main syncMetaprojectGitignore (withoutLegacyMetaprojectIgnore) with every restore-eligibility check in moveBlockOutOfGitignore"
    }
  },
  {
    "id": "F-005",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "info/exclude in the common dir is shared by all worktrees and the block is keyed only by subdirectory prefix; wantedIgnoreLines trims entries against the CURRENT worktree's .gitignore, so update in a worktree whose branch already ignores them shrinks the shared block for every other worktree.",
    "impact": "update in `feature` (no keryx lines in .gitignore) writes 36 entries; update in `main` (lines committed) shrinks the shared block to 1; in `feature` `.metaproject/runtime/` is no longer ignored and shows in git status. Flip-flops per last worktree.",
    "suggested_fix": "Do not trim the shared block against one worktree's .gitignore; always write all entries (redundant is harmless), or key the block per worktree.",
    "evidence": "scratchpad/rl2-worktree-probe.ts: after sync in main the notice says 1 entry; `git check-ignore --no-index .metaproject/runtime/x` in feature exits 1.",
    "confidence": "high",
    "file": "src/lib/metaproject-gitignore.ts",
    "line": null,
    "quote": "    if (explanation.ignored && !explanation.managed && !fromPendingBlock) covered.add(pattern);",
    "dedupe_key": "RL2-2",
    "class_scope": {
      "sites": [
        "src/lib/metaproject-gitignore.ts wantedIgnoreLines",
        "src/lib/git-local-ignore.ts replaceLocalIgnoreBlock / blockMarkers"
      ],
      "enumeration_method": "Traced every input to the block content and its one writer"
    }
  },
  {
    "id": "F-006",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Moving hooks to shared deletes/rewrites .claude/settings.local.json without the HEAD/index check the toLocal branch has.",
    "impact": "A repo that commits settings.local.json with only keryx hooks gets ` D .claude/settings.local.json` on switching to shared.",
    "suggested_fix": "Apply the same tracked check; strip and report instead of removing.",
    "evidence": "Code trace of moveClaudeSettingsHooks !toLocal branch.",
    "confidence": "medium",
    "file": "src/integrations/claude-settings-migration.ts",
    "line": 148,
    "quote": "    if (nothingElse) await removeContained(projectRoot, from);",
    "dedupe_key": "RL2-3"
  },
  {
    "id": "F-007",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "ensureLocalIgnorePatterns has no non-test caller and ignores the subdirectory prefix.",
    "impact": "None today.",
    "suggested_fix": "Delete it with its tests or route through blockMarkers.",
    "evidence": "keryx ctx rg ensureLocalIgnorePatterns src excluding tests: definition only.",
    "confidence": "high",
    "file": "src/lib/git-local-ignore.ts",
    "line": null,
    "quote": "export async function ensureLocalIgnorePatterns(",
    "dedupe_key": "RL2-4"
  },
  {
    "id": "F-008",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "removeBlock trims with LF-only regexes and rejoins with bare \\n, so the strip-only path leaves mixed CRLF/LF and an extra blank line in CRLF files.",
    "impact": "CRLF AGENTS.md on a strip-only path (other uncommitted edits, untracked, no git, block in HEAD) becomes `Intro line\\r\\n\\r\\n\\n\\r\\nAfter line`; notice tells the user to commit it.",
    "suggested_fix": "Detect EOL, trim /(\\r?\\n)+$/ and /^(\\r?\\n)+/, rejoin with the detected EOL; add a CRLF test.",
    "evidence": "scratchpad/rl-crlf.ts on a non-git temp dir reproduced the output.",
    "confidence": "high",
    "file": "src/rules/entrypoint-writers.ts",
    "line": null,
    "quote": "  const before = content.slice(0, start).replace(/\\n+$/, \"\");",
    "dedupe_key": "RL1-1",
    "class_scope": {
      "sites": [
        "src/rules/entrypoint-writers.ts removeBlock",
        "src/rules/entrypoint-writers.ts moveBlockOutOfTeamFile",
        "src/rules/entrypoint-writers.ts planLocalLeftovers"
      ],
      "enumeration_method": "Every caller of the non-exported removeBlock in entrypoint-writers.ts"
    }
  },
  {
    "id": "F-009",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Strip-only paths never check whether the index still holds the block; staged-never-committed file called 'untracked'.",
    "impact": "A previously `git add`-ed AGENTS.md keeps the block in the index silently; a plain commit commits it.",
    "suggested_fix": "After a strip, if the index differs, print the restore --staged hint.",
    "evidence": "Trace of moveBlockOutOfTeamFile strip branches.",
    "confidence": "medium",
    "file": "src/rules/entrypoint-writers.ts",
    "line": null,
    "quote": "  await writeContained(projectRoot, relativePath, removeBlock(content, filePath, head));",
    "dedupe_key": "RL1-2"
  },
  {
    "id": "F-010",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "When AGENTS.md is gone, an existing keryx-generated AGENTS.override.md stays and keeps shadowing; update only says 'skipped'.",
    "impact": "Codex keeps following stale team text after AGENTS.md is deleted/renamed; doctor reports source-missing.",
    "suggested_fix": "Remove a provenance-carrying untracked override in this branch, or name it in the notice.",
    "evidence": "Trace of writeCodexLocalTargets / codexOverrideState.",
    "confidence": "high",
    "file": "src/rules/entrypoint-writers.ts",
    "line": 222,
    "quote": "    if (!(await pathExists(sourcePath))) {",
    "dedupe_key": "RL1-3"
  },
  {
    "id": "F-011",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "writeClaudeLocalTarget writes the block into CLAUDE.local.md without checking whether it is tracked.",
    "impact": "A repo committing CLAUDE.local.md shows it dirty after every update.",
    "suggested_fix": "Skip with a notice when tracked.",
    "evidence": "Trace of writeEntrypointBlocks -> writeClaudeLocalTarget.",
    "confidence": "medium",
    "file": "src/rules/entrypoint-writers.ts",
    "line": 381,
    "quote": "  await ensureMetaprojectReference(filePath, blockOptions);",
    "dedupe_key": "RL1-4"
  },
  {
    "id": "F-012",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "A developer's empty or heading-only CLAUDE.local.md is deleted on local->shared switch (no provenance).",
    "impact": "No content lost.",
    "suggested_fix": "Require the heading keryx writes, or a marker.",
    "evidence": "Trace of planLocalLeftovers.",
    "confidence": "high",
    "file": "src/rules/entrypoint-writers.ts",
    "line": 475,
    "quote": "    } else if (holdsOnlyLocalHeading(next) && !(await tracked(unused.path))) {",
    "dedupe_key": "RL1-5"
  },
  {
    "id": "F-013",
    "reviewer": "review-logic",
    "severity": "info",
    "problem": "codex shared + claude local without CLAUDE.md: CLAUDE.local.md gets the block plus @AGENTS.md which also carries it.",
    "impact": "Index block loaded twice (duplicated context).",
    "suggested_fix": "Skip the block when the imported file is a shared target carrying it.",
    "evidence": "Trace of writeEntrypointBlocks.",
    "confidence": "medium",
    "file": "src/rules/entrypoint-writers.ts",
    "line": 325,
    "quote": "      agentsFile !== undefined && !hasClaudeFile",
    "dedupe_key": "RL1-6"
  },
  {
    "id": "F-014",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "F-005 residual: the shared info/exclude block is still trimmed against the current worktree's .gitignore when that worktree's branch ignores .metaproject/ as a whole (AC6). wantedIgnoreLines then drops every .metaproject entry (and any covered local target), and the block in the common dir shrinks for every other worktree.",
    "impact": "main commits a blanket `.metaproject/` line, feature does not. update in feature writes 36 entries; update in main rewrites the shared block to 1 entry (CLAUDE.local.md); in feature `.metaproject/runtime/` (and `.metaproject/data/security/raw/`, the local HMAC key) is no longer ignored and `git add -A` stages it. Flip-flops per last worktree, as F-005 did.",
    "suggested_fix": "Do not let a per-branch .gitignore decide the content of the per-clone block at all: always write the full .metaproject entry set (a line redundant with the blanket rule is harmless), and drop the ignoredAsWhole trim of local targets too.",
    "evidence": "scratchpad/r2-worktree-ac6-probe.ts (throwaway repo + linked worktree): feature after its own update exit 0 (.metaproject/runtime/x ignored via info/exclude:10); main update notice 'managed block (1 entries)'; feature after main's update `git check-ignore --no-index .metaproject/runtime/x` exit 1; block now holds only CLAUDE.local.md.",
    "confidence": "high",
    "file": "src/lib/metaproject-gitignore.ts",
    "line": 176,
    "quote": "    ...(ignoredAsWhole ? [] : renderMetaprojectGitignoreBlock().trim().split(\"\\n\")),",
    "dedupe_key": "R2-1",
    "class_scope": {
      "sites": [
        "src/lib/metaproject-gitignore.ts wantedIgnoreLines (candidates, line 176)",
        "src/lib/metaproject-gitignore.ts wantedIgnoreLines (covered trim, line 194)"
      ],
      "enumeration_method": "Every input to the block content in wantedIgnoreLines that is read from the current worktree rather than the clone"
    }
  }
]
```
