# Review round 2 (verifier-only) — flow 356, PR #782

- Round ref (head under review): `7457ed83a6a4980594577810f53df98e2b232638` (PR #782 head, confirmed via
  `gh pr view 782 --json headRefOid` at dispatch time).
- Range: `081f092288f843c1149d182b1dd1940bb04e3695..7457ed83a6a4980594577810f53df98e2b232638`
- `is_fix_round: true`; this round answers a completion-gate defect, not a new code change. Round 1
  (`2026-09-28-pr-782-round1`, head `0998ca2d472077cf833b4e3cc325b7b4768c0034`) raised nine findings:
  ARCH-R1-F1, L1, L2, L3, REG-1, REG-2, SEC-356-01, SEC-356-02, TEST-1. The single fix commit
  `7457ed83` ("fix: flow 356 review round 1 — safe worktree prune, secret files scanned despite
  ignore rules, core.impactEvidence, bounded project search, compat in-band codes") addresses all
  nine. This round re-checks each by execution/site-check against that fix commit and re-reports it
  under its ORIGINAL round-1 `global_id`, per AC9/the flow 353/355 round-5/6 pattern (see
  `.metaproject/flows/355-2026-09-28-audit-remediation-2-security-depth-entro/reviews/2026-09-28-pr-781-round5-verdicts/`),
  so `keryx review complete` and `keryx flow status 356` read a verifier `refuted` verdict against
  the finding that was actually raised, not a bare `acted-on` with no verification record.
- Executed against a read-only detached worktree at the PR head:
  `git worktree add --detach /home/altsay/keryx-v356 7457ed83a6a4980594577810f53df98e2b232638`.
- `verification_mode: filter`
- No domain reviewers dispatched this round (budget-conscious, narrow round) — `review-verifier`
  only, re-checking each round-1 finding by re-running the reviewer's own recorded repro against the
  fix commit. No new findings are raised. Two spot-checks on behaviour the fix introduced were run
  (a gitignored `node_modules/.env` vs a gitignored `config/.env` at depth ≤3 for the SEC-356-01
  carve-out; an `update` prune of a worktree whose only ignored content is `.metaproject/data/` for
  the REG-2 allowlist) — both confirmed the intended, documented behaviour and neither reproduced a
  defect, so neither is filed as a finding.

## Prior findings — disposition at this head

| id | severity | disposition | evidence |
|---|---|---|---|
| ARCH-R1-F1 | minor | **closed** | Site-check: `src/impact-evidence/provider.ts:18` now reads `import { loadSecurityConfig, resolveImpactEvidenceConfigTrusted } from "../security/service";` (was `../security/config`), matching `commands/security-impact-evidence.ts`'s own use of the facade. `security/service.ts` still re-exports both names. |
| L1 | major | **closed** | `bun test src/harness/provider/stream-contract.test.ts -t "L1"` -> 4 pass, 0 fail. The new `inBandErrorStatusFor(stringCode)` defaults an unmapped in-band `error.code` to 400 (non-retryable), not 500; the finding's own repro (SSE body with `invalid_api_key`/`invalid_request_error`) no longer classifies as retryable `unavailable`. |
| L2 | major | **closed** | `bun test src/commands/doctor.test.ts` -> 20 pass, 0 fail (was 18 pass / 1 fail). Direct causation re-probe: created a stray `/tmp/.metaproject` (the exact ancestor-pollution condition round 1 found) and ran `buildDoctorReport` against a fresh `mkdtemp()` dir — still correctly resolves to "not a keryx project" (`isKeryxProject`'s new `findMetaprojectUpward`/`isExcludedProjectRootCandidate` explicitly excludes `/`, `/tmp`, and `os.tmpdir()` as candidates). |
| L3 | minor | **closed** | `bun test src/gdgraph/query.test.ts -t "L3"` -> 2 pass, 0 fail. `bunfigPreloadRoots` now strips `#`-comments via a string-literal-aware `stripTomlComments()` before matching the preload array pattern; a commented-out `# preload = [...]` line no longer contributes a root. |
| REG-1 | major | **closed** | Site-check: `src/core.ts:66` now reads `export * as impactEvidence from "./impact-evidence";`, an 11th facade namespace. `bun test src/core-package.test.ts` -> 12 pass, 0 fail. `core.security.readLogRecords` and its six siblings are reachable again as `core.impactEvidence.*`. |
| REG-2 | major | **closed** | Reproduced the finding's own repro against the fix: fresh worktree with only a committed `.gitignore(.env)` plus a real uncommitted gitignored `.env`. `hasUncommittedChanges(worktreePath)` -> `true` (was `false`), which now blocks the prune instead of silently allowing `git worktree remove` to destroy the file. `git status --porcelain --ignored=matching` plus an allowlist (`node_modules`, `.metaproject/data`, `dist`) replaces the blind `git status --porcelain` check; the `update.ts` prompt wording was corrected from "clean" to "no blocking changes". |
| SEC-356-01 | major | **closed** | Reproduced the finding's own fixture (git repo, gitignored root `.env` with a fake `AWS_SECRET_ACCESS_KEY`) against the fix. `scanContainedPath({respectIgnoreRules: true})` -> `.env` now present in `contents` (was absent). A basename allowlist (`SECRET_BEARING_NAME_PATTERNS`: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa`, `credentials*`, etc.) is scanned regardless of ignore rules, outside the three hardcoded-always-ignored dirs (`.claude/worktrees`, `.git`, `node_modules`). |
| SEC-356-02 | major | **closed** | Called `parseGrokToml` directly with the finding's own crafted secret-shaped inputs. Both remaining raw-echo sites (`compat.ts:280` array-header branch, `compat.ts:302` generic bracket catch-all) now emit a non-content description (`"is not a shape this reader understands…"` / `"not a header this reader recognizes (…)"`) with no raw line content — confirmed by string search over the emitted `problems[].message`. |
| TEST-1 | major | **closed** | `bun test src/commands/doctor.test.ts -t "one warn line replaces every project-scoped check"` -> 1 pass, 0 fail (was 0 pass / 1 fail). Same causation re-probe as L2 (stray `/tmp/.metaproject` present throughout the call) confirms the test's own fixture is no longer sensitive to ambient ancestor state — the production code under test was fixed, not the test. |

## Spot-checks on behaviour the fix introduced (not findings — both confirmed intended)

- **SEC-356-01 carve-out boundary**: built one fixture with `.gitignore` listing `.env`, `config/`,
  and `node_modules/`; a fake-secret `.env` at root, a fake-secret `config/.env` (depth 1, under a
  wholesale-ignored `config/` directory), and a fake-secret `node_modules/.env`. Ran
  `scanContainedPath({respectIgnoreRules: true})` at head `7457ed83`: `contents` includes both
  `.env` and `config/.env`, and excludes `node_modules/.env` entirely (not even peeked into) —
  matching the code's own stated rationale (`node_modules` may be a symlink outside `ownerRoot`, so
  it is never `stat()`-ed even for the secret-name peek, unlike an ordinary ignored directory such as
  `config/`, which the `SECRET_SCAN_IGNORED_DEPTH=3` peek reaches at depth 1). Intended; not filed.
- **REG-2 allowlist boundary**: built a worktree whose only ignored content is `.metaproject/data/`
  (no other tracked/untracked changes, no commits ahead of the worktree's own HEAD). Ran
  `hasUncommittedChanges(worktreePath)` at head `7457ed83`: returns `false` (no blocking changes),
  i.e. the worktree remains a valid prune candidate — matching `ALWAYS_IGNORED_CARRY_OVER`'s stated
  allowlist (`node_modules`, `.metaproject/data`, `dist`). Intended; not filed.

## New findings

None. This round only re-verifies the nine round-1 findings above against their original
`global_id`, and spot-checks two boundaries the fix introduced (both confirmed intended, above).

```json keryx:findings
[
  {
    "id": "ARCH-R1-F1",
    "reviewer": "review-architecture",
    "severity": "minor",
    "problem": "src/impact-evidence/provider.ts imports loadSecurityConfig and resolveImpactEvidenceConfigTrusted directly from ../security/config instead of through security/service.ts, the security zone's stated facade, even though security/service.ts already re-exports both names.",
    "impact": "Now that impact-evidence is an independent top-level core zone (promoted out of src/security/ by this PR), this edge is a cross-owner reference that skips the facade the project otherwise disciplines strictly. Invisible to import-policy.ts (only polices zone-level crossings; security and impact-evidence resolve to the same core bucket). Inconsistent with the one other caller of these helpers, commands/security-impact-evidence.ts, which does go through security/service.ts.",
    "suggested_fix": "Change src/impact-evidence/provider.ts's import of loadSecurityConfig/resolveImpactEvidenceConfigTrusted from '../security/config' to '../security/service', matching commands/security-impact-evidence.ts's usage.",
    "evidence": "src/impact-evidence/provider.ts: import { loadSecurityConfig, resolveImpactEvidenceConfigTrusted } from \"../security/config\";",
    "confidence": "high",
    "file": "src/impact-evidence/provider.ts",
    "global_id": "2026-09-28-pr-782-round1#ARCH-R1-F1",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "L1",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "The new L-16 in-band-error branch synthesizes an HTTP-like status from the in-band error.code/type. When that code is a non-numeric string other than \"context_length_exceeded\" (e.g. OpenAI's real invalid_api_key / invalid_request_error shape), it defaults to 500, which classifyHttpError maps to kind:\"unavailable\", retryable:true.",
    "impact": "Non-retryable failures (bad API key, invalid request, content policy violations, etc.) delivered as an in-band SSE error get classified as retryable server outages. The harness will retry a request that can never succeed, wasting attempts/cost and surfacing a misleading 'unavailable' error to the user instead of the real cause.",
    "suggested_fix": "Do not default an unrecognized non-numeric error.code to 500/unavailable. Map well-known non-retryable OpenAI-shaped codes explicitly, and fall back to a non-retryable classification when the code can't be mapped.",
    "evidence": "Ran OpenAiCompatEngine.stream() with SSE body {\"error\":{\"code\":\"invalid_api_key\",\"type\":\"invalid_request_error\",\"message\":\"Incorrect API key provided\"}}; observed provider_error { kind: \"unavailable\", retryable: true }. Confirmed via keryx ctx rg \"classifyHttpError\\(\" that the pre-2xx call site always passes a real response.status, unlike this new synthesized-status call site. review-verifier independently reproduced, plus control cases (context_length_exceeded -> non-retryable; numeric 429 -> correct retryable) confirming this is a default-case bug specific to unrecognized non-numeric codes.",
    "confidence": "high",
    "file": "src/harness/provider/compat/openai-compat-provider.ts",
    "line": 1153,
    "quote": "const status = numericStatus ?? (stringCode === \"context_length_exceeded\" ? 400 : 500);",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": null
    },
    "class_scope": {
      "sites": [
        "src/harness/provider/compat/openai-compat-provider.ts \u2014 the `status = numericStatus ?? (... ? 400 : 500)` line inside the new L-16 `if (data.error !== undefined)` block"
      ],
      "enumeration_method": "keryx ctx rg \"classifyHttpError\\(\" on the file found exactly 3 call sites (definition, the pre-2xx HTTP path, and this new in-band-error path); only the new path synthesizes a status from a string code, confirmed by direct execution."
    },
    "global_id": "2026-09-28-pr-782-round1#L1",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "L2",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "isKeryxProject (new, AC6/backlog item 12) delegates to contained-path.ts's resolveProjectRoot, which walks upward from cwd with NO ceiling until it finds an ancestor containing .git or .metaproject. Any ancestor of a bare/temp directory acquiring a stray .git or .metaproject causes isKeryxProject to wrongly report true.",
    "impact": "bun test src/commands/doctor.test.ts in the reviewed worktree reproduces this directly: the PR's own new test \"a directory with nothing initialized at all...: one warn line replaces every project-scoped check\" FAILS because an ancestor of the mkdtemp'd fixture (in this environment, /tmp itself) contains a stray .metaproject. This directly contradicts AC8's claim that every touched test file passes, and demonstrates the detection is not hermetic against realistic shared-tmp conditions. review-verifier proved causation directly: the identical probe against a verified-clean ancestor chain (TMPDIR=/dev/shm) passes.",
    "suggested_fix": "Give the ancestor walk a ceiling (stop at os.homedir(), or don't treat an ancestor as authoritative once above a conventional temp root), or have isKeryxProject check only cwd's own markers and the git-worktree main root directly rather than delegating to the generic unbounded walker.",
    "evidence": "bun test src/commands/doctor.test.ts fails on the quoted test, reproduced 4 times across two independent reviewers plus the verifier. A probe script calling resolveProjectRoot(mkdtempDir) confirmed it returns the ancestor holding the stray .metaproject rather than reporting 'no project'; the same probe against a clean ancestor chain (/dev/shm) passes.",
    "confidence": "high",
    "file": "src/commands/doctor.ts",
    "line": 354,
    "quote": "async function isKeryxProject(cwd: string): Promise<boolean> {\n  if (existsSync(path.join(resolveProjectRoot(cwd), \".metaproject\"))) {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": null
    },
    "class_scope": {
      "sites": [
        "src/commands/doctor.ts \u2014 isKeryxProject, the sole new caller using resolveProjectRoot for this project/not-project gate",
        "src/lib/contained-path.ts \u2014 resolveProjectRoot (pre-existing, unbounded upward walk, no ceiling)"
      ],
      "enumeration_method": "Ran bun test src/commands/doctor.test.ts and observed the failure directly, 4 times total across independent runs. Wrote and ran a probe script calling resolveProjectRoot/resolveMainCheckoutRoot on the same mkdtemp() path the test uses, both with and without ancestor pollution."
    },
    "global_id": "2026-09-28-pr-782-round1#L2",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "L3",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "bunfigPreloadRoots's regex matches the substring \"preload = [...]\" anywhere in bunfig.toml's text, with no comment-awareness and no anchor to a real key position \u2014 it matches inside a #-commented-out line and would also match any key merely ending in \"preload\".",
    "impact": "A commented-out (no longer active) preload = [...] line still adds its file(s) to roots, permanently suppressing them from gdgraph orphans even once they become genuinely dead code \u2014 a false negative in the exact detection A-8 exists to provide.",
    "suggested_fix": "Strip #-comments before matching, and anchor the key match to a line start (optionally preceded by whitespace), e.g. /^[ \\t]*preload\\s*=\\s*\\[([^\\]]*)\\]/gm.",
    "evidence": "Probe script: text = '# preload = [\"./ghost.ts\"]\\n'; arrayPattern still matched the full commented line and extracted './ghost.ts' as a root. review-verifier independently reproduced with the exact regex.",
    "confidence": "medium",
    "file": "src/gdgraph/query.ts",
    "line": 123,
    "quote": "const arrayPattern = /preload\\s*=\\s*\\[([^\\]]*)\\]/gs;",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": null
    },
    "global_id": "2026-09-28-pr-782-round1#L3",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "REG-1",
    "reviewer": "review-regression",
    "severity": "major",
    "problem": "The A-1 cycle-cut removes security/service.ts's re-export of the impact-evidence module's public API (7 functions + 5 types). security/service.ts is re-exported wholesale as the `security` namespace by src/core.ts (export * as security from \"./security/service\"), and src/core.ts's namespaces are the whole published surface of the npm package (package.json exports: only \".\" -> \"./dist/core.js\"). Before this diff, core.security.readLogRecords (and the other 6 functions/5 types) worked; after it, that path is gone.",
    "impact": "Any external consumer of the npm package calling core.security.readLogRecords/appendLogRecord/computeImpactEvidence/createImpactEvidenceProvider/hostDeliveryStatus/normalizeRequestFiles/renderEvidenceBlock gets a runtime TypeError with no compile-time warning. No internal caller or test observes this: core-package.test.ts asserts nothing about the security namespace's member names.",
    "suggested_fix": "Either re-export the impact-evidence public door from src/core.ts itself as an 11th namespace (export * as impactEvidence from \"./impact-evidence\"), or, if intentional pre-1.0 API churn, record it explicitly in CHANGELOG.md and findings.md, and add an assertion to core-package.test.ts pinning core.security's member list.",
    "evidence": "package.json exports only \".\" -> \"./dist/core.js\"; src/core.ts: export * as security from \"./security/service\" (only 10 facade namespaces total). Base commit 081f0922's src/security/service.ts contains the 7-function+5-type re-export block; git diff base..head shows both blocks deleted. Grepped the whole worktree for a replacement re-export elsewhere \u2014 none found. Grepped core-package.test.ts for any assertion on security's member list \u2014 zero matches. review-verifier independently re-read core.ts's 10 facade lines and re-diffed base vs head service.ts, confirming.",
    "confidence": "high",
    "file": "src/security/service.ts",
    "line": null,
    "quote": "A-1 (flow 356, audit remediation 3): this used to ALSO re-export the impact-evidence module's own public door (appendLogRecord, computeImpactEvidence, createImpactEvidenceProvider, hostDeliveryStatus, normalizeRequestFiles, readLogRecords, renderEvidenceBlock, plus their types) from ./impact-evidence",
    "locator": {
      "state": "unlocatable",
      "reason": "the quote does not appear in the file",
      "reported_line": null
    },
    "class_scope": {
      "sites": [
        "src/core.ts:52 (export * as security from \"./security/service\")",
        "src/security/service.ts (diff removes the 7-function + 5-type re-export block sourced from ./impact-evidence)"
      ],
      "enumeration_method": "Read package.json's full exports map; read every one of src/core.ts's 10 facade export lines and checked which touch security/service.ts, wiki/service.ts, or any other file reaching the 4 moved symbols \u2014 only security matched. Diffed base vs head src/security/service.ts verbatim. Grepped whole worktree for any surviving/replacement re-export of the same 7 symbols outside internal-only callers."
    },
    "global_id": "2026-09-28-pr-782-round1#REG-1",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "REG-2",
    "reviewer": "review-regression",
    "severity": "major",
    "problem": "keryx update's stale-worktree prune (G-5) treats a worktree as safe to delete once it is >=7 days old, has no commits ahead of main, and is \"clean\" per `git status --porcelain`. That command never reports gitignored files. A worktree holding only a committed .gitignore (e.g. listing .env) plus a real, uncommitted, gitignored .env file with actual secret/local content reads as fully clean and is deleted \u2014 the gitignored file is destroyed with no warning and no --force needed. git worktree remove's own built-in safety check uses the same clean definition, so it does not catch this either. The confirmation prompt in commands/update.ts (offerStaleWorktreePrune) tells the operator the candidates are \"merged into main, and clean\" \u2014 an overstated guarantee \u2014 and --yes skips the prompt outright.",
    "impact": "Silent, irreversible data loss of gitignored local content (.env files, scratch notes, local data) inside any `.claude/worktrees/*` directory that ages past 7 days with no tracked changes and no commits ahead of main. This is exactly the kind of directory an agent working through this project's own flow/worktree workflow would use to hold a real .env or local override file.",
    "suggested_fix": "Extend the clean-tree check to also detect gitignored-but-present files (e.g. `git status --porcelain --ignored` or an explicit walk that flags any tracked-by-gitignore file with content) and refuse/warn before pruning a worktree that has any, or exclude worktrees containing gitignored files from the age/no-commits-ahead auto-candidate set entirely. Correct the confirmation prompt's \"and clean\" wording so it does not overstate the guarantee actually being made.",
    "evidence": "Reproduced directly: created worktree w1, committed only .gitignore containing \".env\", then wrote real content to .env (uncommitted, gitignored). `git status --porcelain` -> empty. `git worktree remove w1` succeeded with no --force. `.env` and the whole directory were gone afterward. src/lib/git-worktrees.test.ts's 9 tests (all pass) cover uncommitted/untracked-but-not-ignored changes and unmerged commits, never a gitignored-file scenario. review-verifier independently reproduced twice, including by calling the PR's own hasUncommittedChanges/findStaleWorktrees directly against a fresh fixture.",
    "confidence": "high",
    "file": "src/lib/git-worktrees.ts",
    "line": null,
    "quote": "hasUncommittedChanges uses git status --porcelain to decide a worktree is \"clean\"",
    "locator": {
      "state": "unlocatable",
      "reason": "no such file at this round's head: src/lib/git-worktrees.ts",
      "reported_line": null
    },
    "class_scope": {
      "sites": [
        "src/lib/git-worktrees.ts \u2014 hasUncommittedChanges (git status --porcelain, blind to gitignored content)",
        "src/lib/git-worktrees.ts \u2014 pruneWorktree / git worktree remove (same clean definition)",
        "src/commands/update.ts \u2014 offerStaleWorktreePrune confirmation prompt wording"
      ],
      "enumeration_method": "Read git-worktrees.ts and update.ts in full; read git-worktrees.test.ts's 9 tests to confirm which boundaries are covered; reproduced the gitignored-file deletion directly with real git commands against a scratch worktree outside the tracked tree, twice, by two independent agents."
    },
    "global_id": "2026-09-28-pr-782-round1#REG-2",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "SEC-356-01",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "By default (respectIgnoreRules: true), keryx security scan now silently skips any path the repository's own .gitignore/--exclude-standard rules cover, with no carve-out for well-known secret-bearing filenames (.env, .env.*, *.pem, id_rsa, credentials files, etc.).",
    "impact": ".env is gitignored in nearly every real project, and is the single most common place a developer leaves a genuinely leaked/forgotten live credential on disk. An operator running `keryx security scan .` as a pre-publish credential audit now gets coverage.status: \"complete\" while the scan never opened the exact file most likely to hold a real secret. The only signals are a terse CLI count (easy to skim past) and result.warnings gets nothing about the skip at all; only the full report's coverage.skipped array names .env explicitly.",
    "suggested_fix": "Carve out well-known secret-bearing filename patterns (.env, .env.*, *.pem, *_rsa, id_ed25519, .npmrc, .netrc, credential/service-account JSON patterns) from the ignore-skip even when respectIgnoreRules is true, or surface a real warning (not just a count) in the default human CLI output and result.warnings whenever a skipped path matches a secret-like name heuristic. At minimum add a test pinning today's actual behaviour for a gitignored .env-with-fake-secret fixture (currently absent).",
    "evidence": "Reproduced live: git-initialized fixture, .gitignore containing \".env\", .env holding fake AWS_SECRET_ACCESS_KEY/GITHUB_TOKEN. Result: coverage: {\"status\":\"complete\",\"required\":true,\"reasons\":[],\"skipped\":[\".env\",\".git\"]}, contents.some(c => c.path === \".env\") === false. With respectIgnoreRules: false the same fixture yields .env present in contents. src/commands/security.ts terse-output coverage line shows only a count, no filenames. CHANGELOG.md and findings.md G-2 row describe the change only as coverage improving, no caveat for this case. review-verifier independently built its own fixture and reproduced the same result.",
    "confidence": "high",
    "file": "src/security/path-scan.ts",
    "class_scope": {
      "sites": [
        "src/security/path-scan.ts: visit() ignore-check (single call site, gates all traversal)",
        "src/commands/security.ts: handleScan terse-output coverage line (single site)"
      ],
      "enumeration_method": "Read full diff of path-scan.ts/service.ts/types.ts/security.ts; grepped for respectIgnoreRules across the worktree; ran the actual scanner against a constructed git fixture with a gitignored .env containing fake credentials to confirm behaviour empirically."
    },
    "global_id": "2026-09-28-pr-782-round1#SEC-356-01",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "SEC-356-02",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "AC7 (frozen) states parseGrokToml \"never echoes a raw value into a problem message.\" The PR fixes exactly two message-construction sites (the key/value parsing branches) and adds matching tests. Two other pre-existing sites in the same function \u2014 compat.ts:280 and compat.ts:302, both `problems.push({ file, message: \\`line ${lineNo}: \"${line}\" is not a table header this reader understands\\` })` \u2014 still interpolate the full raw line verbatim and were not touched by this diff.",
    "impact": "Reproduced directly: parseGrokToml(\"/g.toml\", \"[[mcp_servers.docs sk-live-classifiedSECRETVALUE1234]]\\n\") and an unclosed-bracket variant reaching the generic catch-all branch both return a problem message containing the full raw line, secret-shaped content included. Per the code's own comments these messages reach mcp list --json warnings, mcp doctor, and the /mcp panel \u2014 the exact sinks S-11 was written to close. This contradicts AC7's frozen wording, not just the PR body's summary.",
    "suggested_fix": "Apply the same treatment used for the key/value sites: replace \"${line}\" at compat.ts:280 and compat.ts:302 with a non-content description (line number, or a shape description of the bracketed content) so no raw line content is ever interpolated. Add tests mirroring the two new S-11 tests but targeting the header-rejection branches.",
    "evidence": "src/mcp-servers/compat.ts lines 275-305 (arrayHeader and generic bracket-catch-all branches, both untouched by the S-11 diff, both interpolating ${line}). Reproduced via direct call to parseGrokToml with crafted inputs containing secret-shaped strings; both cases echoed the full raw line in problems[].message. review-verifier independently reproduced both sites with its own crafted inputs.",
    "confidence": "high",
    "file": "src/mcp-servers/compat.ts",
    "class_scope": {
      "sites": [
        "src/mcp-servers/compat.ts:280 (arrayHeader-under-mcp_servers rejection)",
        "src/mcp-servers/compat.ts:302 (generic bracket-line catch-all rejection)"
      ],
      "enumeration_method": "Grepped all message:/.push({ sites in compat.ts (17 matches), read each in context to classify which interpolate raw line/value content, reproduced leakage empirically for the two remaining raw-echo sites via crafted parseGrokToml inputs."
    },
    "global_id": "2026-09-28-pr-782-round1#SEC-356-02",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  },
  {
    "id": "TEST-1",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "The new doctor.test.ts test 'a directory with nothing initialized at all (no .metaproject, no git): one warn line replaces every project-scoped check, nothing is fail, never throws' is not hermetically isolated from ambient filesystem state above its own mkdtemp fixture, and fails as a result whenever an ancestor of the OS temp directory happens to contain a .metaproject or .git marker.",
    "impact": "Reproduced 4 times across independent runs (full-file run, isolated with -t, and by two separate reviewing agents plus the verifier): the test expects report.checks ids to equal [...GLOBAL_CHECK_IDS, 'project'], but gets the full project-scoped check set instead, because isKeryxProject()/resolveProjectRoot() walks upward from the fixture with no boundary other than the OS filesystem root. This directly undermines the AC6 claim this test is meant to pin, and the PR body's claim that all 2725 tests pass, in any environment where an ancestor of the temp dir carries such a marker \u2014 a realistic condition on a long-lived shared dev/CI machine running many concurrent keryx worktrees/flows (this project's own normal usage pattern).",
    "suggested_fix": "Make the fixture immune to ancestor pollution: inject/stub the project-root boundary for this test (a seam to take an explicit 'stop climbing here' root), or have the test assert its own precondition first and fail loudly if any ancestor up to / already contains .metaproject or .git, or anchor the fixture to a git-init'd temp root the way the sibling 'plain git repo... is STILL not a keryx project' test does. Also fix or explicitly bound resolveProjectRoot's upward walk (contained-path.ts) so a bare OS temp directory can never resolve to a project by way of an unrelated ancestor.",
    "evidence": "bun test src/commands/doctor.test.ts (18 pass / 1 fail) and bun test src/commands/doctor.test.ts -t \"one warn line replaces every project-scoped check\" (0 pass / 1 fail), reproduced 4 times total. Standalone probe confirmed resolveProjectRoot(mkdtemp dir) resolves upward past the fixture to an ancestor carrying a stray .metaproject, and passes against a verified-clean ancestor chain. The sibling git-worktrees.test.ts 'outside a git repository' test passes because resolveMainCheckoutRoot delegates to `git rev-parse --git-common-dir`, which has real repository-boundary semantics.",
    "confidence": "high",
    "file": "src/commands/doctor.test.ts",
    "class_scope": {
      "sites": [
        "src/commands/doctor.test.ts: test \"a directory with nothing initialized at all (no .metaproject, no git): one warn line replaces every project-scoped check, nothing is fail, never throws\""
      ],
      "enumeration_method": "Ran bun test src/commands/doctor.test.ts (18 pass / 1 fail) and re-ran the single test in isolation with -t, 4 times total across independent agents, all reproducing the same failure. Traced the cause with a standalone probe calling resolveProjectRoot()/resolveMainCheckoutRoot() against a fresh mkdtemp dir, with and without ancestor pollution."
    },
    "global_id": "2026-09-28-pr-782-round1#TEST-1",
    "reviewer_note": "Re-reported for round-2 verifier-only re-check against PR #782 head 7457ed83 (fix commit for flow 356 review round 1); content unchanged from round 1 (2026-09-28-pr-782-round1) except this note. See verifications for the round-2 refuted verdict."
  }
]

```
