# Review — flow 356, PR #782 (MrCipherSmith/keryx), round 1

Base 081f092288f843c1149d182b1dd1940bb04e3695 .. Head 0998ca2d472077cf833b4e3cc325b7b4768c0034
Branch fix/audit-remediation-3. Deep round: scope A (diff, 53 files retained / 55 seen) + scope B
(blast radius, 40 files, depth <= 2).

Reviewers dispatched: review-architecture, review-logic, review-regression (with blast-radius),
review-security-code, review-testing-practices. Wave C: review-verifier.

## Verifier outcome

review-verifier checked all 9 consolidated findings by execution or site-check (never by re-reading).
All 9 confirmed. Zero refuted, zero unverifiable. See keryx:verifications file for the
per-finding method and evidence (commands run, outputs observed).

## Note on REG-2

review-regression reproduced this defect empirically but did not include it in its own
keryx:findings block, reasoning that it is a defect in new code itself (G-5's prune logic) rather
than an existing behaviour an in-scope caller regressed against, so it failed the skill's own
scope-B class-scope test. The orchestrator is filing it here as an ordinary scope-A finding (the
defect is in files this PR itself changed), attributed to review-regression since that is who found
and reproduced it. review-verifier independently re-reproduced it before this ingest.

```json keryx:findings
[
  {
    "id": "ARCH-R1-F1",
    "severity": "minor",
    "reviewer": "review-architecture",
    "problem": "src/impact-evidence/provider.ts imports loadSecurityConfig and resolveImpactEvidenceConfigTrusted directly from ../security/config instead of through security/service.ts, the security zone's stated facade, even though security/service.ts already re-exports both names.",
    "impact": "Now that impact-evidence is an independent top-level core zone (promoted out of src/security/ by this PR), this edge is a cross-owner reference that skips the facade the project otherwise disciplines strictly. Invisible to import-policy.ts (only polices zone-level crossings; security and impact-evidence resolve to the same core bucket). Inconsistent with the one other caller of these helpers, commands/security-impact-evidence.ts, which does go through security/service.ts.",
    "suggested_fix": "Change src/impact-evidence/provider.ts's import of loadSecurityConfig/resolveImpactEvidenceConfigTrusted from '../security/config' to '../security/service', matching commands/security-impact-evidence.ts's usage.",
    "evidence": "src/impact-evidence/provider.ts: import { loadSecurityConfig, resolveImpactEvidenceConfigTrusted } from \"../security/config\";",
    "file": "src/impact-evidence/provider.ts",
    "confidence": "high"
  },
  {
    "id": "L1",
    "severity": "major",
    "reviewer": "review-logic",
    "file": "src/harness/provider/compat/openai-compat-provider.ts",
    "quote": "const status = numericStatus ?? (stringCode === \"context_length_exceeded\" ? 400 : 500);",
    "problem": "The new L-16 in-band-error branch synthesizes an HTTP-like status from the in-band error.code/type. When that code is a non-numeric string other than \"context_length_exceeded\" (e.g. OpenAI's real invalid_api_key / invalid_request_error shape), it defaults to 500, which classifyHttpError maps to kind:\"unavailable\", retryable:true.",
    "impact": "Non-retryable failures (bad API key, invalid request, content policy violations, etc.) delivered as an in-band SSE error get classified as retryable server outages. The harness will retry a request that can never succeed, wasting attempts/cost and surfacing a misleading 'unavailable' error to the user instead of the real cause.",
    "suggested_fix": "Do not default an unrecognized non-numeric error.code to 500/unavailable. Map well-known non-retryable OpenAI-shaped codes explicitly, and fall back to a non-retryable classification when the code can't be mapped.",
    "evidence": "Ran OpenAiCompatEngine.stream() with SSE body {\"error\":{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"Incorrect API key provided\"}}; observed provider_error { kind: \"unavailable\", retryable: true }. Confirmed via keryx ctx rg \"classifyHttpError\\(\" that the pre-2xx call site always passes a real response.status, unlike this new synthesized-status call site. review-verifier independently reproduced, plus control cases (context_length_exceeded -> non-retryable; numeric 429 -> correct retryable) confirming this is a default-case bug specific to unrecognized non-numeric codes.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/harness/provider/compat/openai-compat-provider.ts — the `status = numericStatus ?? (... ? 400 : 500)` line inside the new L-16 `if (data.error !== undefined)` block"],
      "enumeration_method": "keryx ctx rg \"classifyHttpError\\(\" on the file found exactly 3 call sites (definition, the pre-2xx HTTP path, and this new in-band-error path); only the new path synthesizes a status from a string code, confirmed by direct execution."
    }
  },
  {
    "id": "L2",
    "severity": "major",
    "reviewer": "review-logic",
    "file": "src/commands/doctor.ts",
    "quote": "async function isKeryxProject(cwd: string): Promise<boolean> {\n  if (existsSync(path.join(resolveProjectRoot(cwd), \".metaproject\"))) {",
    "problem": "isKeryxProject (new, AC6/backlog item 12) delegates to contained-path.ts's resolveProjectRoot, which walks upward from cwd with NO ceiling until it finds an ancestor containing .git or .metaproject. Any ancestor of a bare/temp directory acquiring a stray .git or .metaproject causes isKeryxProject to wrongly report true.",
    "impact": "bun test src/commands/doctor.test.ts in the reviewed worktree reproduces this directly: the PR's own new test \"a directory with nothing initialized at all...: one warn line replaces every project-scoped check\" FAILS because an ancestor of the mkdtemp'd fixture (in this environment, /tmp itself) contains a stray .metaproject. This directly contradicts AC8's claim that every touched test file passes, and demonstrates the detection is not hermetic against realistic shared-tmp conditions. review-verifier proved causation directly: the identical probe against a verified-clean ancestor chain (TMPDIR=/dev/shm) passes.",
    "suggested_fix": "Give the ancestor walk a ceiling (stop at os.homedir(), or don't treat an ancestor as authoritative once above a conventional temp root), or have isKeryxProject check only cwd's own markers and the git-worktree main root directly rather than delegating to the generic unbounded walker.",
    "evidence": "bun test src/commands/doctor.test.ts fails on the quoted test, reproduced 4 times across two independent reviewers plus the verifier. A probe script calling resolveProjectRoot(mkdtempDir) confirmed it returns the ancestor holding the stray .metaproject rather than reporting 'no project'; the same probe against a clean ancestor chain (/dev/shm) passes.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/doctor.ts — isKeryxProject, the sole new caller using resolveProjectRoot for this project/not-project gate", "src/lib/contained-path.ts — resolveProjectRoot (pre-existing, unbounded upward walk, no ceiling)"],
      "enumeration_method": "Ran bun test src/commands/doctor.test.ts and observed the failure directly, 4 times total across independent runs. Wrote and ran a probe script calling resolveProjectRoot/resolveMainCheckoutRoot on the same mkdtemp() path the test uses, both with and without ancestor pollution."
    }
  },
  {
    "id": "L3",
    "severity": "minor",
    "reviewer": "review-logic",
    "file": "src/gdgraph/query.ts",
    "quote": "const arrayPattern = /preload\\s*=\\s*\\[([^\\]]*)\\]/gs;",
    "problem": "bunfigPreloadRoots's regex matches the substring \"preload = [...]\" anywhere in bunfig.toml's text, with no comment-awareness and no anchor to a real key position — it matches inside a #-commented-out line and would also match any key merely ending in \"preload\".",
    "impact": "A commented-out (no longer active) preload = [...] line still adds its file(s) to roots, permanently suppressing them from gdgraph orphans even once they become genuinely dead code — a false negative in the exact detection A-8 exists to provide.",
    "suggested_fix": "Strip #-comments before matching, and anchor the key match to a line start (optionally preceded by whitespace), e.g. /^[ \\t]*preload\\s*=\\s*\\[([^\\]]*)\\]/gm.",
    "evidence": "Probe script: text = '# preload = [\"./ghost.ts\"]\\n'; arrayPattern still matched the full commented line and extracted './ghost.ts' as a root. review-verifier independently reproduced with the exact regex.",
    "confidence": "medium"
  },
  {
    "id": "REG-1",
    "severity": "major",
    "reviewer": "review-regression",
    "file": "src/security/service.ts",
    "quote": "A-1 (flow 356, audit remediation 3): this used to ALSO re-export the impact-evidence module's own public door (appendLogRecord, computeImpactEvidence, createImpactEvidenceProvider, hostDeliveryStatus, normalizeRequestFiles, readLogRecords, renderEvidenceBlock, plus their types) from ./impact-evidence",
    "problem": "The A-1 cycle-cut removes security/service.ts's re-export of the impact-evidence module's public API (7 functions + 5 types). security/service.ts is re-exported wholesale as the `security` namespace by src/core.ts (export * as security from \"./security/service\"), and src/core.ts's namespaces are the whole published surface of the npm package (package.json exports: only \".\" -> \"./dist/core.js\"). Before this diff, core.security.readLogRecords (and the other 6 functions/5 types) worked; after it, that path is gone.",
    "impact": "Any external consumer of the npm package calling core.security.readLogRecords/appendLogRecord/computeImpactEvidence/createImpactEvidenceProvider/hostDeliveryStatus/normalizeRequestFiles/renderEvidenceBlock gets a runtime TypeError with no compile-time warning. No internal caller or test observes this: core-package.test.ts asserts nothing about the security namespace's member names.",
    "suggested_fix": "Either re-export the impact-evidence public door from src/core.ts itself as an 11th namespace (export * as impactEvidence from \"./impact-evidence\"), or, if intentional pre-1.0 API churn, record it explicitly in CHANGELOG.md and findings.md, and add an assertion to core-package.test.ts pinning core.security's member list.",
    "evidence": "package.json exports only \".\" -> \"./dist/core.js\"; src/core.ts: export * as security from \"./security/service\" (only 10 facade namespaces total). Base commit 081f0922's src/security/service.ts contains the 7-function+5-type re-export block; git diff base..head shows both blocks deleted. Grepped the whole worktree for a replacement re-export elsewhere — none found. Grepped core-package.test.ts for any assertion on security's member list — zero matches. review-verifier independently re-read core.ts's 10 facade lines and re-diffed base vs head service.ts, confirming.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/core.ts:52 (export * as security from \"./security/service\")", "src/security/service.ts (diff removes the 7-function + 5-type re-export block sourced from ./impact-evidence)"],
      "enumeration_method": "Read package.json's full exports map; read every one of src/core.ts's 10 facade export lines and checked which touch security/service.ts, wiki/service.ts, or any other file reaching the 4 moved symbols — only security matched. Diffed base vs head src/security/service.ts verbatim. Grepped whole worktree for any surviving/replacement re-export of the same 7 symbols outside internal-only callers."
    }
  },
  {
    "id": "REG-2",
    "severity": "major",
    "reviewer": "review-regression",
    "file": "src/lib/git-worktrees.ts",
    "quote": "hasUncommittedChanges uses git status --porcelain to decide a worktree is \"clean\"",
    "problem": "keryx update's stale-worktree prune (G-5) treats a worktree as safe to delete once it is >=7 days old, has no commits ahead of main, and is \"clean\" per `git status --porcelain`. That command never reports gitignored files. A worktree holding only a committed .gitignore (e.g. listing .env) plus a real, uncommitted, gitignored .env file with actual secret/local content reads as fully clean and is deleted — the gitignored file is destroyed with no warning and no --force needed. git worktree remove's own built-in safety check uses the same clean definition, so it does not catch this either. The confirmation prompt in commands/update.ts (offerStaleWorktreePrune) tells the operator the candidates are \"merged into main, and clean\" — an overstated guarantee — and --yes skips the prompt outright.",
    "impact": "Silent, irreversible data loss of gitignored local content (.env files, scratch notes, local data) inside any `.claude/worktrees/*` directory that ages past 7 days with no tracked changes and no commits ahead of main. This is exactly the kind of directory an agent working through this project's own flow/worktree workflow would use to hold a real .env or local override file.",
    "suggested_fix": "Extend the clean-tree check to also detect gitignored-but-present files (e.g. `git status --porcelain --ignored` or an explicit walk that flags any tracked-by-gitignore file with content) and refuse/warn before pruning a worktree that has any, or exclude worktrees containing gitignored files from the age/no-commits-ahead auto-candidate set entirely. Correct the confirmation prompt's \"and clean\" wording so it does not overstate the guarantee actually being made.",
    "evidence": "Reproduced directly: created worktree w1, committed only .gitignore containing \".env\", then wrote real content to .env (uncommitted, gitignored). `git status --porcelain` -> empty. `git worktree remove w1` succeeded with no --force. `.env` and the whole directory were gone afterward. src/lib/git-worktrees.test.ts's 9 tests (all pass) cover uncommitted/untracked-but-not-ignored changes and unmerged commits, never a gitignored-file scenario. review-verifier independently reproduced twice, including by calling the PR's own hasUncommittedChanges/findStaleWorktrees directly against a fresh fixture.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/lib/git-worktrees.ts — hasUncommittedChanges (git status --porcelain, blind to gitignored content)", "src/lib/git-worktrees.ts — pruneWorktree / git worktree remove (same clean definition)", "src/commands/update.ts — offerStaleWorktreePrune confirmation prompt wording"],
      "enumeration_method": "Read git-worktrees.ts and update.ts in full; read git-worktrees.test.ts's 9 tests to confirm which boundaries are covered; reproduced the gitignored-file deletion directly with real git commands against a scratch worktree outside the tracked tree, twice, by two independent agents."
    }
  },
  {
    "id": "SEC-356-01",
    "severity": "major",
    "reviewer": "review-security-code",
    "problem": "By default (respectIgnoreRules: true), keryx security scan now silently skips any path the repository's own .gitignore/--exclude-standard rules cover, with no carve-out for well-known secret-bearing filenames (.env, .env.*, *.pem, id_rsa, credentials files, etc.).",
    "impact": ".env is gitignored in nearly every real project, and is the single most common place a developer leaves a genuinely leaked/forgotten live credential on disk. An operator running `keryx security scan .` as a pre-publish credential audit now gets coverage.status: \"complete\" while the scan never opened the exact file most likely to hold a real secret. The only signals are a terse CLI count (easy to skim past) and result.warnings gets nothing about the skip at all; only the full report's coverage.skipped array names .env explicitly.",
    "suggested_fix": "Carve out well-known secret-bearing filename patterns (.env, .env.*, *.pem, *_rsa, id_ed25519, .npmrc, .netrc, credential/service-account JSON patterns) from the ignore-skip even when respectIgnoreRules is true, or surface a real warning (not just a count) in the default human CLI output and result.warnings whenever a skipped path matches a secret-like name heuristic. At minimum add a test pinning today's actual behaviour for a gitignored .env-with-fake-secret fixture (currently absent).",
    "evidence": "Reproduced live: git-initialized fixture, .gitignore containing \".env\", .env holding fake AWS_SECRET_ACCESS_KEY/GITHUB_TOKEN. Result: coverage: {\"status\":\"complete\",\"required\":true,\"reasons\":[],\"skipped\":[\".env\",\".git\"]}, contents.some(c => c.path === \".env\") === false. With respectIgnoreRules: false the same fixture yields .env present in contents. src/commands/security.ts terse-output coverage line shows only a count, no filenames. CHANGELOG.md and findings.md G-2 row describe the change only as coverage improving, no caveat for this case. review-verifier independently built its own fixture and reproduced the same result.",
    "file": "src/security/path-scan.ts",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/security/path-scan.ts: visit() ignore-check (single call site, gates all traversal)", "src/commands/security.ts: handleScan terse-output coverage line (single site)"],
      "enumeration_method": "Read full diff of path-scan.ts/service.ts/types.ts/security.ts; grepped for respectIgnoreRules across the worktree; ran the actual scanner against a constructed git fixture with a gitignored .env containing fake credentials to confirm behaviour empirically."
    }
  },
  {
    "id": "SEC-356-02",
    "severity": "major",
    "reviewer": "review-security-code",
    "problem": "AC7 (frozen) states parseGrokToml \"never echoes a raw value into a problem message.\" The PR fixes exactly two message-construction sites (the key/value parsing branches) and adds matching tests. Two other pre-existing sites in the same function — compat.ts:280 and compat.ts:302, both `problems.push({ file, message: \\`line ${lineNo}: \"${line}\" is not a table header this reader understands\\` })` — still interpolate the full raw line verbatim and were not touched by this diff.",
    "impact": "Reproduced directly: parseGrokToml(\"/g.toml\", \"[[mcp_servers.docs sk-live-classifiedSECRETVALUE1234]]\\n\") and an unclosed-bracket variant reaching the generic catch-all branch both return a problem message containing the full raw line, secret-shaped content included. Per the code's own comments these messages reach mcp list --json warnings, mcp doctor, and the /mcp panel — the exact sinks S-11 was written to close. This contradicts AC7's frozen wording, not just the PR body's summary.",
    "suggested_fix": "Apply the same treatment used for the key/value sites: replace \"${line}\" at compat.ts:280 and compat.ts:302 with a non-content description (line number, or a shape description of the bracketed content) so no raw line content is ever interpolated. Add tests mirroring the two new S-11 tests but targeting the header-rejection branches.",
    "evidence": "src/mcp-servers/compat.ts lines 275-305 (arrayHeader and generic bracket-catch-all branches, both untouched by the S-11 diff, both interpolating ${line}). Reproduced via direct call to parseGrokToml with crafted inputs containing secret-shaped strings; both cases echoed the full raw line in problems[].message. review-verifier independently reproduced both sites with its own crafted inputs.",
    "file": "src/mcp-servers/compat.ts",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/mcp-servers/compat.ts:280 (arrayHeader-under-mcp_servers rejection)", "src/mcp-servers/compat.ts:302 (generic bracket-line catch-all rejection)"],
      "enumeration_method": "Grepped all message:/.push({ sites in compat.ts (17 matches), read each in context to classify which interpolate raw line/value content, reproduced leakage empirically for the two remaining raw-echo sites via crafted parseGrokToml inputs."
    }
  },
  {
    "id": "TEST-1",
    "severity": "major",
    "reviewer": "review-testing-practices",
    "problem": "The new doctor.test.ts test 'a directory with nothing initialized at all (no .metaproject, no git): one warn line replaces every project-scoped check, nothing is fail, never throws' is not hermetically isolated from ambient filesystem state above its own mkdtemp fixture, and fails as a result whenever an ancestor of the OS temp directory happens to contain a .metaproject or .git marker.",
    "impact": "Reproduced 4 times across independent runs (full-file run, isolated with -t, and by two separate reviewing agents plus the verifier): the test expects report.checks ids to equal [...GLOBAL_CHECK_IDS, 'project'], but gets the full project-scoped check set instead, because isKeryxProject()/resolveProjectRoot() walks upward from the fixture with no boundary other than the OS filesystem root. This directly undermines the AC6 claim this test is meant to pin, and the PR body's claim that all 2725 tests pass, in any environment where an ancestor of the temp dir carries such a marker — a realistic condition on a long-lived shared dev/CI machine running many concurrent keryx worktrees/flows (this project's own normal usage pattern).",
    "suggested_fix": "Make the fixture immune to ancestor pollution: inject/stub the project-root boundary for this test (a seam to take an explicit 'stop climbing here' root), or have the test assert its own precondition first and fail loudly if any ancestor up to / already contains .metaproject or .git, or anchor the fixture to a git-init'd temp root the way the sibling 'plain git repo... is STILL not a keryx project' test does. Also fix or explicitly bound resolveProjectRoot's upward walk (contained-path.ts) so a bare OS temp directory can never resolve to a project by way of an unrelated ancestor.",
    "evidence": "bun test src/commands/doctor.test.ts (18 pass / 1 fail) and bun test src/commands/doctor.test.ts -t \"one warn line replaces every project-scoped check\" (0 pass / 1 fail), reproduced 4 times total. Standalone probe confirmed resolveProjectRoot(mkdtemp dir) resolves upward past the fixture to an ancestor carrying a stray .metaproject, and passes against a verified-clean ancestor chain. The sibling git-worktrees.test.ts 'outside a git repository' test passes because resolveMainCheckoutRoot delegates to `git rev-parse --git-common-dir`, which has real repository-boundary semantics.",
    "file": "src/commands/doctor.test.ts",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/doctor.test.ts: test \"a directory with nothing initialized at all (no .metaproject, no git): one warn line replaces every project-scoped check, nothing is fail, never throws\""],
      "enumeration_method": "Ran bun test src/commands/doctor.test.ts (18 pass / 1 fail) and re-ran the single test in isolation with -t, 4 times total across independent agents, all reproducing the same failure. Traced the cause with a standalone probe calling resolveProjectRoot()/resolveMainCheckoutRoot() against a fresh mkdtemp dir, with and without ancestor pollution."
    }
  }
]
```
