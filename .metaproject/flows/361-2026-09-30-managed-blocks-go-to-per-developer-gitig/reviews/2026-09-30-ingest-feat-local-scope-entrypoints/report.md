**Changes requested — 0 Blocker, 5 Major, 4 Minor, 4 Info.** Reviewed `578a14bd` against `d360fdd7` (round 1, flow 361, no PR yet). The Claude hooks move holds (every settings writer resolves through `resolveClaudeSettingsTarget`; one file, never both), restore-from-HEAD is gated correctly and a second run is idempotent. The risk is in the ignore migration, the shared `info/exclude` across worktrees, manifest-controlled paths, and CRLF handling on the strip-only path.

### Major
**F-001. Manifest local-target paths are written verbatim into `info/exclude`.** `src/rules/entrypoint-targets.ts` safeRelativePath, in the diff. Verified by execution.

**F-002. Codex override `source` is read through an escaping symlink.** `src/rules/entrypoint-writers.ts` writeCodexLocalTargets, in the diff. Verified by execution.

**F-004. .gitignore migration cannot restore HEAD when the legacy writer deduplicated team lines.** `src/lib/metaproject-gitignore.ts` moveBlockOutOfGitignore, in the diff. Verified by execution.

**F-005. Shared `info/exclude` block is trimmed against one worktree's .gitignore.** `src/lib/metaproject-gitignore.ts` wantedIgnoreLines, in the diff. Verified by execution.

**F-008. Strip-only path mangles CRLF files.** `src/rules/entrypoint-writers.ts` removeBlock, in the diff. Verified by execution.

### Minor
- **F-006.** tracked `.claude/settings.local.json` deleted when switching to shared.
- **F-009.** strip-only paths never warn that the index still holds the block.
- **F-010.** keryx-generated AGENTS.override.md keeps shadowing after AGENTS.md is removed.
- **F-011.** block written into a tracked CLAUDE.local.md.

### Info
- F-003, F-007, F-012, F-013.

### How this review was run
- **Workflow:** `review-orchestrator`; scope `origin/main...HEAD`, pre-filter dropped 0.
- **Subagents:** review-logic x2, review-security-code (tier standard, inherit); review-verifier (tier light).
- **Not run:** review-regression / scope B — cost cap; review-architecture, review-testing-practices, review-style — cost cap; PR-only steps — no pull request.
- **Verification:** annotate; confirmed 12, refuted 0, unverifiable 1, unverified 0.


```json keryx:findings
[
  {
    "id": "F-001",
    "dedupe_key": "RS-1",
    "severity": "major",
    "reviewer": "review-security-code",
    "file": "src/rules/entrypoint-targets.ts",
    "quote": "  if (value.split(/[\\\\/]/).includes(\"..\")) return undefined;",
    "problem": "Entry-form local root target `path` from the tracked manifest is kept verbatim (only abs/.. /NUL rejected) and appended raw into <git-common-dir>/info/exclude by wantedIgnoreLines -> replaceLocalIgnoreBlock; leading '!', globs, '#', embedded newlines (incl. a fake '# keryx:end') are accepted. The same path is where writeClaudeLocalTarget creates/appends the block.",
    "impact": "A cloned repo whose committed metaproject.json has root [{runtime:'claude',scope:'local',path:'!.env'}] makes `keryx update` write `!.env` into info/exclude, overriding the developer's core.excludesFile ignore of .env -> `?? .env`, staged by `git add -A`. Newlines inject extra lines and break the managed block.",
    "suggested_fix": "Force the standard local path per runtime (as claudeSettings does), or reject control chars and leading '!'/'#' in safeRelativePath; write local-target lines as anchored literal patterns.",
    "evidence": "Reviewer scratch scripts (scratchpad/rs-WShC/): normalizeEntrypointTargets accepts both; syncMetaprojectIgnoreRules on a throwaway repo wrote `!.env`, `!*.pem`, `# keryx:end` into info/exclude; git status showed `?? .env` after the line was added.",
    "confidence": "high",
    "location_class": "in-diff",
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
    "dedupe_key": "RS-2",
    "severity": "major",
    "reviewer": "review-security-code",
    "file": "src/rules/entrypoint-writers.ts",
    "quote": "    const sourcePath = path.join(projectRoot, entry.source);",
    "problem": "writeCodexLocalTargets reads the manifest's Codex `source` with readFile (follows symlinks) and copies it into AGENTS.override.md without refuseEscapingSymlink; the pre-scaffold guard only covers root-level sources found by readdir, so a subdirectory source through an escaping symlink is never checked.",
    "impact": "A cloned repo commits `home -> /Users/<name>` and a codex entry source 'home/.aws/credentials'; `keryx update`/`rules distill` copies the out-of-repo file into AGENTS.override.md, which Codex loads as instructions and sends to the model provider.",
    "suggested_fix": "refuseEscapingSymlink(projectRoot, entry.source) before reading (writeCodexLocalTargets, codexOverrideState, codexOverrideByteSize); or restrict source to a root-level team file.",
    "evidence": "Reviewer scratch script on a throwaway project: with home -> ../outside, writeCodexLocalTargets produced an AGENTS.override.md containing the outside secret line.",
    "confidence": "high",
    "location_class": "in-diff",
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
    "dedupe_key": "RS-3",
    "severity": "info",
    "reviewer": "review-security-code",
    "file": "src/lib/git-head.ts",
    "quote": "  const result = await runGit(projectRoot, [\"diff\", \"--quiet\", \"--\", relativePath]);",
    "problem": "Paths after `--` are still pathspecs (glob/magic); a manifest path with glob chars can make worktreeFileIsClean/indexHoldsFile answer for other files.",
    "impact": "Wrong classification/notice only; no data loss reproduced.",
    "suggested_fix": "--literal-pathspecs or GIT_LITERAL_PATHSPECS=1 in runGit.",
    "evidence": "Throwaway repo: `git diff --quiet -- 's*'` matched modified src.ts.",
    "confidence": "medium",
    "location_class": "in-diff"
  },
  {
    "id": "F-004",
    "dedupe_key": "RL2-1",
    "severity": "major",
    "reviewer": "review-logic",
    "file": "src/lib/metaproject-gitignore.ts",
    "quote": "  if (sameApartFromBlankLines(stripped, head)) {",
    "problem": "moveBlockOutOfGitignore restores HEAD only when file-minus-block equals HEAD, but origin/main's legacy writer also deleted team lines outside the block that duplicated keryx's lines (and a blanket .metaproject/ line). Those repos fall to strip-only and the team's lines stay deleted.",
    "impact": "HEAD .gitignore `node_modules/\\n.metaproject/runtime/\\n`, working tree left by the legacy writer as node_modules/ + block: `keryx update` leaves ` M .gitignore` with `-.metaproject/runtime/` and calls it the user's edit; AC8 `git diff --quiet` fails.",
    "suggested_fix": "Before comparing, remove from HEAD the lines the legacy writer would have removed; if equal, take the restore-from-HEAD branch.",
    "evidence": "scratchpad/rl2-gitignore-probe.ts against a temp repo: result file `node_modules/\\n`, status ` M .gitignore`, diff `-.metaproject/runtime/`.",
    "confidence": "high",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/lib/metaproject-gitignore.ts moveBlockOutOfGitignore"
      ],
      "enumeration_method": "Compared origin/main syncMetaprojectGitignore (withoutLegacyMetaprojectIgnore) with every restore-eligibility check in moveBlockOutOfGitignore"
    }
  },
  {
    "id": "F-005",
    "dedupe_key": "RL2-2",
    "severity": "major",
    "reviewer": "review-logic",
    "file": "src/lib/metaproject-gitignore.ts",
    "quote": "    if (explanation.ignored && !explanation.managed && !fromPendingBlock) covered.add(pattern);",
    "problem": "info/exclude in the common dir is shared by all worktrees and the block is keyed only by subdirectory prefix; wantedIgnoreLines trims entries against the CURRENT worktree's .gitignore, so update in a worktree whose branch already ignores them shrinks the shared block for every other worktree.",
    "impact": "update in `feature` (no keryx lines in .gitignore) writes 36 entries; update in `main` (lines committed) shrinks the shared block to 1; in `feature` `.metaproject/runtime/` is no longer ignored and shows in git status. Flip-flops per last worktree.",
    "suggested_fix": "Do not trim the shared block against one worktree's .gitignore; always write all entries (redundant is harmless), or key the block per worktree.",
    "evidence": "scratchpad/rl2-worktree-probe.ts: after sync in main the notice says 1 entry; `git check-ignore --no-index .metaproject/runtime/x` in feature exits 1.",
    "confidence": "high",
    "location_class": "in-diff",
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
    "dedupe_key": "RL2-3",
    "severity": "minor",
    "reviewer": "review-logic",
    "file": "src/integrations/claude-settings-migration.ts",
    "quote": "    if (nothingElse) await removeContained(projectRoot, from);",
    "problem": "Moving hooks to shared deletes/rewrites .claude/settings.local.json without the HEAD/index check the toLocal branch has.",
    "impact": "A repo that commits settings.local.json with only keryx hooks gets ` D .claude/settings.local.json` on switching to shared.",
    "suggested_fix": "Apply the same tracked check; strip and report instead of removing.",
    "evidence": "Code trace of moveClaudeSettingsHooks !toLocal branch.",
    "confidence": "medium",
    "location_class": "in-diff"
  },
  {
    "id": "F-007",
    "dedupe_key": "RL2-4",
    "severity": "info",
    "reviewer": "review-logic",
    "file": "src/lib/git-local-ignore.ts",
    "quote": "export async function ensureLocalIgnorePatterns(",
    "problem": "ensureLocalIgnorePatterns has no non-test caller and ignores the subdirectory prefix.",
    "impact": "None today.",
    "suggested_fix": "Delete it with its tests or route through blockMarkers.",
    "evidence": "keryx ctx rg ensureLocalIgnorePatterns src excluding tests: definition only.",
    "confidence": "high",
    "location_class": "in-diff"
  },
  {
    "id": "F-008",
    "dedupe_key": "RL1-1",
    "severity": "major",
    "reviewer": "review-logic",
    "file": "src/rules/entrypoint-writers.ts",
    "quote": "  const before = content.slice(0, start).replace(/\\n+$/, \"\");",
    "problem": "removeBlock trims with LF-only regexes and rejoins with bare \\n, so the strip-only path leaves mixed CRLF/LF and an extra blank line in CRLF files.",
    "impact": "CRLF AGENTS.md on a strip-only path (other uncommitted edits, untracked, no git, block in HEAD) becomes `Intro line\\r\\n\\r\\n\\n\\r\\nAfter line`; notice tells the user to commit it.",
    "suggested_fix": "Detect EOL, trim /(\\r?\\n)+$/ and /^(\\r?\\n)+/, rejoin with the detected EOL; add a CRLF test.",
    "evidence": "scratchpad/rl-crlf.ts on a non-git temp dir reproduced the output.",
    "confidence": "high",
    "location_class": "in-diff",
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
    "dedupe_key": "RL1-2",
    "severity": "minor",
    "reviewer": "review-logic",
    "file": "src/rules/entrypoint-writers.ts",
    "quote": "  await writeContained(projectRoot, relativePath, removeBlock(content, filePath, head));",
    "problem": "Strip-only paths never check whether the index still holds the block; staged-never-committed file called 'untracked'.",
    "impact": "A previously `git add`-ed AGENTS.md keeps the block in the index silently; a plain commit commits it.",
    "suggested_fix": "After a strip, if the index differs, print the restore --staged hint.",
    "evidence": "Trace of moveBlockOutOfTeamFile strip branches.",
    "confidence": "medium",
    "location_class": "in-diff"
  },
  {
    "id": "F-010",
    "dedupe_key": "RL1-3",
    "severity": "minor",
    "reviewer": "review-logic",
    "file": "src/rules/entrypoint-writers.ts",
    "quote": "    if (!(await pathExists(sourcePath))) {",
    "problem": "When AGENTS.md is gone, an existing keryx-generated AGENTS.override.md stays and keeps shadowing; update only says 'skipped'.",
    "impact": "Codex keeps following stale team text after AGENTS.md is deleted/renamed; doctor reports source-missing.",
    "suggested_fix": "Remove a provenance-carrying untracked override in this branch, or name it in the notice.",
    "evidence": "Trace of writeCodexLocalTargets / codexOverrideState.",
    "confidence": "high",
    "location_class": "in-diff"
  },
  {
    "id": "F-011",
    "dedupe_key": "RL1-4",
    "severity": "minor",
    "reviewer": "review-logic",
    "file": "src/rules/entrypoint-writers.ts",
    "quote": "  await ensureMetaprojectReference(filePath, blockOptions);",
    "problem": "writeClaudeLocalTarget writes the block into CLAUDE.local.md without checking whether it is tracked.",
    "impact": "A repo committing CLAUDE.local.md shows it dirty after every update.",
    "suggested_fix": "Skip with a notice when tracked.",
    "evidence": "Trace of writeEntrypointBlocks -> writeClaudeLocalTarget.",
    "confidence": "medium",
    "location_class": "in-diff"
  },
  {
    "id": "F-012",
    "dedupe_key": "RL1-5",
    "severity": "info",
    "reviewer": "review-logic",
    "file": "src/rules/entrypoint-writers.ts",
    "quote": "    } else if (holdsOnlyLocalHeading(next) && !(await tracked(unused.path))) {",
    "problem": "A developer's empty or heading-only CLAUDE.local.md is deleted on local->shared switch (no provenance).",
    "impact": "No content lost.",
    "suggested_fix": "Require the heading keryx writes, or a marker.",
    "evidence": "Trace of planLocalLeftovers.",
    "confidence": "high",
    "location_class": "in-diff"
  },
  {
    "id": "F-013",
    "dedupe_key": "RL1-6",
    "severity": "info",
    "reviewer": "review-logic",
    "file": "src/rules/entrypoint-writers.ts",
    "quote": "      agentsFile !== undefined && !hasClaudeFile",
    "problem": "codex shared + claude local without CLAUDE.md: CLAUDE.local.md gets the block plus @AGENTS.md which also carries it.",
    "impact": "Index block loaded twice (duplicated context).",
    "suggested_fix": "Skip the block when the imported file is a shared target carrying it.",
    "evidence": "Trace of writeEntrypointBlocks.",
    "confidence": "medium",
    "location_class": "in-diff"
  }
]
```
