# Review report — flow 360, closing round (r04)

Head 3cf1d7811f82b252a03344b24e6c6dedd8d6cade (PR #812 head; merged to main as 0ba8816ec840ea20300cf1df7bae591d6f393102).

This round raises nothing new. It carries every finding at minor or above from rounds 1-3
(57: F-001..F-027, G-001..G-018, H-001..H-012) with their original global_id, so each one's
latest record is this round's, and records an independent re-verification of each against the PR head.
Info findings (F-028..F-031, G-019..G-030, H-013..H-020) are not carried: info never blocks.

Round cap: rounds 1-3 used the three-round budget. This fourth ingest is the operator's decision —
the user chose "merge and flow complete" (relayed by flow-orchestrator, dispatch 360-close-review,
2026-10-01); it is a verification record, not a further review/fix round.

Verifiers: `close-verifier-360` (the agent dispatched for this closing round; raised none of these
findings) re-ran the reviewers' behaviour probes and mutants on a throwaway `git archive` of the PR
head, one test file per run, no suite runs; `review-verifier` claims restate the T31 targeted
verification at 3cf1d781 recorded in the flow journal (H-001..H-005 by execution, H-011/H-012 by reading).

Not closed: **F-010** (minor, review-testing-practices). Its name half reproduces at the head — mutant
R02 survives; see its verification. It needs a fix or a recorded human decision; nothing here dismisses it.

Also observed, not a finding of any round: round-2 mutant R06 (trailing-slash normalisation of a
registry path in resolveTarget) survives remove-skill.test.ts and skills-remove.test.ts.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "skills remove deletes outside the project through a symlinked project-skills component, then fails half-way.",
  "impact": "A symlinked .metaproject/project-skills/<module> makes the real run delete <link target>/<name>; the run then throws ENOTDIR, leaving the registry entry and catalog row removed and the report in place, and a second run reports not found.",
  "suggested_fix": "Realpath the package parent and the project-skills root and require containment before any mutation; use removeContained / rmdirIfEmptyContained.",
  "evidence": "Reproduced by the security and architecture probes and by review-verifier f001.ts with a symlinked module directory, a symlinked project-skills root and an unregistered module/name.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 130,
  "class_scope": {
   "sites": [
    "src/gdskills/remove-skill.ts:130",
    "src/gdskills/remove-skill.ts:148",
    "src/gdskills/remove-skill.ts:210",
    "src/gdskills/remove-skill.ts:221"
   ],
   "enumeration_method": "every rm/rmdir call and every containment check in remove-skill.ts, read in full; no other module removes project-skill paths"
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-001"
 },
 {
  "id": "F-002",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "A registry path is not bound to its own module/name.",
  "impact": "Entry review/alpha with path .metaproject/project-skills/review deletes every skill in the module; a path naming another skill deletes that skill while the named one stays on disk.",
  "suggested_fix": "Accept a registered path only when it equals .metaproject/project-skills/<entry.module>/<entry.name>.",
  "evidence": "Reproduced by the security probe and review-verifier f002.ts for both scenarios.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 125,
  "class_scope": {
   "sites": [
    "src/gdskills/remove-skill.ts:125",
    "src/gdskills/remove-skill.ts:242"
   ],
   "enumeration_method": "every read of a registry entry's path in remove-skill.ts (resolveTarget and isTargetEntry)"
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-002"
 },
 {
  "id": "F-003",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "Import guards test the raw package name while the writer uses the slug.",
  "impact": "A tree with review_logic and review_house_api imported with --only 'review*' overwrites an existing review/review-house-api and registers a project reviewer named review-logic without --force; the dry run says would-import.",
  "suggested_fix": "Slugify once when the source is built and use that value for the guards, the destination and the reported row.",
  "evidence": "Reproduced by the security probe and review-verifier f003.ts on HEAD; base review import refused the tree.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 621,
  "class_scope": {
   "sites": [
    "src/gdskills/import-skills.ts:176",
    "src/gdskills/import-skills.ts:435",
    "src/gdskills/import-skills.ts:568",
    "src/gdskills/import-skills.ts:621"
   ],
   "enumeration_method": "every comparison of a source package name against BUNDLED_NAMES or an existing destination in import-skills.ts"
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-003"
 },
 {
  "id": "F-004",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "rules/project is keyed on the rule basename.",
  "impact": "An import citing core/x.mdc and house/x.mdc with different contents installs only the first; the second is reported differs against the just-written file, shadowedRules points both refs at one file, and the dry run promised a different destination.",
  "suggested_fix": "Key the project slot on the full reference: rules/project/<dir>/<name>.",
  "evidence": "Reproduced by the logic and architecture probes and review-verifier f004.ts.",
  "confidence": "high",
  "file": "src/gdskills/rule-references.ts",
  "line": 36,
  "class_scope": {
   "sites": [
    "src/gdskills/rule-references.ts:36",
    "src/gdskills/rule-references.ts:61",
    "src/gdskills/import-skills.ts:904",
    "src/gdskills/import-skills.ts:950"
   ],
   "enumeration_method": "every caller of projectRulePath and every place that builds a rules/project path, found by searching src for projectRulePath and PROJECT_RULES_DIR"
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-004"
 },
 {
  "id": "F-005",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "Technology-pair prose becomes a path trigger and gates the reviewer off every round.",
  "impact": "A description 'React/Next.js conventions reviewer.' with no glob yields paths [React/Next.js] and pathsSource description; on base it was none (dispatched every round), and the paths-none warning is suppressed.",
  "suggested_fix": "Accept a literal path only when the description also yields at least one glob.",
  "evidence": "Reproduced by the logic probe and review-verifier f005.ts on HEAD and base.",
  "confidence": "high",
  "file": "src/review/reviewers.ts",
  "line": 272,
  "class_scope": {
   "sites": [
    "src/review/reviewers.ts:272",
    "src/review/reviewers.ts:295",
    "src/review/reviewers.ts:325"
   ],
   "enumeration_method": "isLiteralFilePath and its two callers (descriptionPathTriggers, reviewerPathGate); the import warning reads the same gate"
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-005"
 },
 {
  "id": "F-006",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "metadata.flags entries are taken verbatim.",
  "impact": "flags: [vantage], ['--Vantage '] and 'flags: --vantage --house' produce unmatched entries; a YAML block list is ignored; three spellings of one flag give familyFlags [] so the correctly spelled reviewer is dispatched without the path gate.",
  "suggested_fix": "Normalise entries and drop those not matching ^--[a-z][a-z0-9-]*$ with a visible warning.",
  "evidence": "Reproduced by the logic probe and review-verifier f006.ts with a control case.",
  "confidence": "high",
  "file": "src/review/reviewers.ts",
  "line": 338,
  "class_scope": {
   "sites": [
    "src/review/reviewers.ts:215",
    "src/review/reviewers.ts:338",
    "src/review/reviewers.ts:501"
   ],
   "enumeration_method": "metadataList, reviewerFlags and the familyFlags computation — every reader of metadata.flags in src"
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-006"
 },
 {
  "id": "F-007",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "Registry module and name are interpolated unvalidated into the report path.",
  "impact": "A crafted registry entry makes skills remove delete <outside>/a-b-verification.json.",
  "suggested_fix": "Apply the SEGMENT check to registered entries.",
  "evidence": "Security probe with module ../../../../../outside/a and name b.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 319,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-007"
 },
 {
  "id": "F-008",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "An imported package that declares another reviewer's unique flag turns it into a family flag for both.",
  "impact": "The existing reviewer silently becomes path-gated under its own explicit flag.",
  "suggested_fix": "Warn at import on a flag collision with an existing project reviewer.",
  "evidence": "Logic probe with two reviewers sharing one previously unique flag.",
  "confidence": "high",
  "file": "src/review/reviewers.ts",
  "line": 501,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-008"
 },
 {
  "id": "F-009",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "An empty --only value is dropped.",
  "impact": "--only \"\" with --module quality imports the whole tree.",
  "suggested_fix": "Error on an empty value.",
  "evidence": "Logic probe through optionValues.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 67,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-009"
 },
 {
  "id": "F-010",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The SEGMENT check and the root-equality clause of resolveTarget have no failing test.",
  "impact": "Under the mutants skills remove ../skills deletes .metaproject/skills and a registry path equal to the root deletes every project skill, with the suite green.",
  "suggested_fix": "Add the two cases.",
  "evidence": "Mutation pass: both mutants survived.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.test.ts",
  "line": 1,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-010"
 },
 {
  "id": "F-011",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "No test drives --only through either command.",
  "impact": "The three wiring sites (import-skills.ts, import-reviewers.ts:55, review.ts:498) can be removed with the suite green.",
  "suggested_fix": "One test per command through skillsCommand / reviewCommand.",
  "evidence": "Mutation pass: all three wiring mutants survived.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 1118,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-011"
 },
 {
  "id": "F-012",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The AC4 fixture only collides on a keryx-shipped rule name.",
  "impact": "The collides clause at import-skills.ts:950 never decides; under the mutant a project-owned rules/house/own.mdc is overwritten in place.",
  "suggested_fix": "Add a collision under a non-shipped name.",
  "evidence": "Mutation pass: mutant survived.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.test.ts",
  "line": 1,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-012"
 },
 {
  "id": "F-013",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "--only anchoring, ? and literal escaping are unpinned.",
  "impact": "A glob matcher that matches prefixes or treats dots as wildcards passes the suite.",
  "suggested_fix": "Add a prefix-sharing sibling, a ? case and a dotted name.",
  "evidence": "Mutation pass on import-skills.ts:422-424.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.test.ts",
  "line": 1,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-013"
 },
 {
  "id": "F-014",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The report lookup by body and by conventional name mask each other.",
  "impact": "Either branch can be removed with the suite green.",
  "suggested_fix": "One non-conventional filename with a matching skillPath and one conventional name with an unrelated body.",
  "evidence": "Mutation pass; behaviour correct on an eight-file probe.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.test.ts",
  "line": 1,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-014"
 },
 {
  "id": "F-015",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "Rule-import branches have no fixture.",
  "impact": "Rules for deprecated- or bundled-skipped sources, the post-gate present re-check, a gate-blocked rule and a direct project/x.mdc citation are unpinned.",
  "suggested_fix": "Add fixtures for each branch.",
  "evidence": "Mutation pass: surviving mutants in those branches.",
  "confidence": "medium",
  "file": "src/gdskills/import-skills.ts",
  "line": 885,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-015"
 },
 {
  "id": "F-016",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The catalog-row module cell, the installed-tree half of the bundled refusal and the path clause of isTargetEntry are unpinned.",
  "impact": "Removing the wrong module's catalog row passes the suite.",
  "suggested_fix": "A fixture with one name in two modules.",
  "evidence": "Mutation pass: three mutants survived.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 242,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-016"
 },
 {
  "id": "F-017",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "Small parse clauses are unpinned.",
  "impact": "metadata-level deprecated, flag de-duplication, .MD case-folding, the .. exclusion and the packaged-first order in defaultBundledSourceRoot can regress unnoticed.",
  "suggested_fix": "Pin each with one assertion.",
  "evidence": "Mutation pass: mutants survived.",
  "confidence": "medium",
  "file": "src/review/reviewers.ts",
  "line": 215,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-017"
 },
 {
  "id": "F-018",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "First production gdskills to review import.",
  "impact": "The two directories are now mutually dependent.",
  "suggested_fix": "Move reviewerPathGate and its pure helpers into gdskills and re-export.",
  "evidence": "Import graph traced; no file-level cycle, three import orders run.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 16,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-018"
 },
 {
  "id": "F-019",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "remove-skill hand-copies the on-disk format project-skills.ts writes.",
  "impact": "Lock path, catalog markers, empty row and report name can drift between writer and remover.",
  "suggested_fix": "Export and share them.",
  "evidence": "Traced, not run.",
  "confidence": "medium",
  "file": "src/gdskills/remove-skill.ts",
  "line": 63,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-019"
 },
 {
  "id": "F-020",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "A skills subcommand needs four registrations with no parity test.",
  "impact": "A routed subcommand can be unreachable or undocumented with the suite green.",
  "suggested_fix": "Add the source-derived parity test the review group has.",
  "evidence": "Compared with the review drift guard in cli.test.ts.",
  "confidence": "high",
  "file": "src/commands/skills.ts",
  "line": 1758,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-020"
 },
 {
  "id": "F-021",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "The import re-implements the resolution order resolveRuleReference owns.",
  "impact": "Two copies of the project-first order can diverge.",
  "suggested_fix": "Call resolveRuleReference.",
  "evidence": "Traced, not run.",
  "confidence": "medium",
  "file": "src/gdskills/import-skills.ts",
  "line": 903,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-021"
 },
 {
  "id": "F-022",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "frontmatterCategory matches category: anywhere in the file.",
  "impact": "A two-package non-review tree with a fenced category: review example in one body is refused as targeting module review.",
  "suggested_fix": "One frontmatter-bounded reader for category, name and deprecated.",
  "evidence": "Architecture probe.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 1043,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-022"
 },
 {
  "id": "F-023",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "problem": "importReferencedRules outgrew one responsibility.",
  "impact": "About 130 lines interleave citation collection, status decision and gated writing; F-004 lives in that interleaving.",
  "suggested_fix": "Split along those seams.",
  "evidence": "Read, not run.",
  "confidence": "medium",
  "file": "src/gdskills/import-skills.ts",
  "line": 885,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-023"
 },
 {
  "id": "F-024",
  "reviewer": "review-clean-code",
  "severity": "minor",
  "problem": "The generic optionValues argv helper lives in the importer.",
  "impact": "A third argv tokenizer outside src/lib/args.ts.",
  "suggested_fix": "Move it to src/lib/args.ts.",
  "evidence": "Read, not run.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 67,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-024"
 },
 {
  "id": "F-025",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "The new text names a keryx install command that does not exist.",
  "impact": "An agent following the text runs a command that exits 1 with Unknown command: install. Also at SKILL.detail.md:205 and :434, review-orchestrator/SKILL.detail.md:80, import-skills.ts:276 and :926, reviewers.ts:600.",
  "suggested_fix": "Name keryx skills install / init / update.",
  "evidence": "Ran keryx install: Unknown command, exit 1.",
  "confidence": "high",
  "file": "src/gdskills/bundled/skills/core/reviewer-skill-creator/SKILL.detail.md",
  "line": 139,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-025"
 },
 {
  "id": "F-026",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "AC13 says SKILL.md contains the end-to-end example; it lives in SKILL.detail.md.",
  "impact": "The criterion cannot be confirmed as written.",
  "suggested_fix": "Amend AC13 through keryx flow ac update.",
  "evidence": "SKILL.md is pinned at 280 lines; the example is in the companion file.",
  "confidence": "high",
  "file": ".metaproject/flows/360-2026-09-30-reviewer-import-fixes/acceptance-criteria.md",
  "line": 26,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-026"
 },
 {
  "id": "F-027",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "'In the bundled half means installed' is false when bundledSource is package.",
  "impact": "A project with no installed review tree lists all 28 bundled reviewers, so not-installed is never recorded. Also SKILL.detail.md:177 and SKILL.md:1088.",
  "suggested_fix": "Qualify with bundledSource: project.",
  "evidence": "Ran review reviewers in a project without an installed review tree.",
  "confidence": "high",
  "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md",
  "line": 121,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes#F-027"
 },
 {
  "id": "G-001",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "writePlacedRule writes rules with raw mkdir + writeFileAtomic and no containment, so a symlinked directory component (rules/project/<dir>, rules/project, rules/<dir>) is followed out of the project.",
  "impact": "Importing an overlay citing a matching rule creates or (with --force) overwrites <name>.mdc outside the project; the dry run names an in-project target and refuses nothing.",
  "suggested_fix": "Write through writeContained, run the same check in decideRule so dry-run refuses, and add import-skills.ts to the contained-write ratchet.",
  "evidence": "verified — review-verifier/sec002.ts: variants A-D wrote into the outside dir at HEAD; A new in the fix range, B from the round-1 range, C/D pre-existing on main. Also review-security-code/p3-rules.ts.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 1193,
  "class_scope": {
   "sites": [
    "src/gdskills/import-skills.ts:1194",
    "src/gdskills/import-skills.ts:1195"
   ],
   "enumeration_method": "keryx ctx rg for contained helpers and node:fs imports in import-skills.ts: writePlacedRule is the only rule writer and no contained helper is imported."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-001"
 },
 {
  "id": "G-002",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "The frontmatter-bounded reader splits on \\n and requires content.startsWith('---'); CRLF lines end in \\r and a BOM fails the fence test, so category/name/deprecated are not read.",
  "impact": "A CRLF or BOM SKILL.md named review-lint with metadata.category quality is imported into module review at HEAD and into quality on main; a tree of such files is refused as targeting review; deprecated is not honoured.",
  "suggested_fix": "Strip a leading BOM and split on /\\r?\\n/ in every frontmatter reader; add CRLF and BOM tests.",
  "evidence": "verified — review-verifier/log001.ts: HEAD lf->quality, crlf->review, bom->review; main and 43e803be all quality.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 384,
  "class_scope": {
   "sites": [
    "src/gdskills/import-skills.ts:384",
    "src/gdskills/reviewer-triggers.ts:67",
    "src/gdskills/reviewer-triggers.ts:85",
    "src/gdskills/skill-frontmatter.ts:94"
   ],
   "enumeration_method": "keryx ctx rg for startsWith(\"---\") / indexOf(\"\\n---\") frontmatter readers reachable from the importer and the inventory, each run on CRLF/BOM fixtures."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-002"
 },
 {
  "id": "G-003",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "metadataList does not strip YAML trailing comments; flag normalisation splits the comment into flags and a paths item keeps the comment text.",
  "impact": "'- --a # family flag' yields flags --a, --family, --flag; '- src/x/** # the x tree' yields one unmatched trigger with pathsSource metadata and no warning, gating the reviewer off every round.",
  "suggested_fix": "Strip ' #...' outside quotes in metadataList; test both keys and both list shapes.",
  "evidence": "verified — review-verifier/log002.ts: HEAD flags [--a,--family,--flag], paths ['src/x/** # the x tree']; 43e803be and main: [] / none.",
  "confidence": "high",
  "file": "src/gdskills/reviewer-triggers.ts",
  "line": 248,
  "class_scope": {
   "sites": [
    "src/gdskills/reviewer-triggers.ts:51",
    "src/gdskills/reviewer-triggers.ts:63",
    "src/gdskills/reviewer-triggers.ts:248",
    "src/gdskills/import-skills.ts:395"
   ],
   "enumeration_method": "every frontmatter value reader in reviewer-triggers.ts and import-skills.ts, run on commented inline and block fixtures."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-003"
 },
 {
  "id": "G-004",
  "reviewer": "review-architecture",
  "severity": "major",
  "problem": "declaredPathsFromContent reads only a scalar metadata.paths while metadataList now reads a YAML block list; two parsers of one field disagree.",
  "impact": "A conventions skill with a block-list metadata.paths is gated by review reviewers but treated as unrestricted by review jev-rules (clauseApplicability on docs/tools/readme.ts returns applicable true).",
  "suggested_fix": "Call the exported metadataList from src/gdskills/reviewer-triggers.ts; test scalar, flow and block spellings.",
  "evidence": "verified — review-verifier/arc001.ts with a scalar control returning applicable false.",
  "confidence": "medium",
  "file": "src/commands/review-jev-rules.ts",
  "line": 133,
  "class_scope": {
   "sites": [
    "src/commands/review-jev-rules.ts:133",
    "src/commands/review-jev-rules.ts:229"
   ],
   "enumeration_method": "keryx ctx rg for metadataScalar / declaredPathsFromContent and reviewer-triggers importers: metadata.paths has exactly two parsers."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-004"
 },
 {
  "id": "G-005",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "problem": "The F-003 slug fix is pinned only on the tree path; reverting it at the file source, URL source or ownModule leaves every test green.",
  "impact": "The round-1 major can return unnoticed: a SKILL.md named review_logic is imported over the bundled reviewer, and a review_a/review_b tree imports into review without --only.",
  "suggested_fix": "Add tests for file, URL, --name and module inference.",
  "evidence": "verified by the raising reviewer — mutations I07, I08, I16 survived; probe-import.test.ts.txt is green on HEAD and red under each.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 664,
  "class_scope": {
   "sites": [
    "src/gdskills/import-skills.ts:654",
    "src/gdskills/import-skills.ts:664",
    "src/gdskills/import-skills.ts:562"
   ],
   "enumeration_method": "every projectSkillSlug / .slug use in import-skills.ts reverted in turn: :362, :678, :551, :705 killed; :654, :664, :562 survive."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-005"
 },
 {
  "id": "G-006",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "Registry, catalog and report matching is exact-case, but the unregistered-package fallback asks the case-insensitive filesystem.",
  "impact": "On macOS, skills remove Review/Alpha with review/alpha registered deletes the package and reports registry/catalog/report absent, leaving all three pointing at nothing.",
  "suggested_fix": "Require the exact on-disk spelling via readdir; refuse a case-insensitive registry match that is not exact.",
  "evidence": "verified — review-verifier/sec001.ts: after the real run registry ['review/alpha'], catalog row present, package gone, report present.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 278,
  "class_scope": {
   "sites": [
    "src/gdskills/remove-skill.ts:278",
    "src/gdskills/remove-skill.ts:283"
   ],
   "enumeration_method": "every pathExists/lstat in remove-skill.ts that decides identity from a composed path; the other comparisons are exact string matches."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-006"
 },
 {
  "id": "G-007",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "The report is removed last and resolveTarget only recognises a skill by registry entry or package directory.",
  "impact": "With a read-only reports directory the run throws EACCES after registry, catalog and package are gone; the next run says not found and the report is orphaned, contrary to the help text.",
  "suggested_fix": "Remove the report before the package, or let resolveTarget accept a key whose report still exists.",
  "evidence": "verified — review-verifier/sec003.ts.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 139,
  "class_scope": {
   "sites": [
    "src/gdskills/remove-skill.ts:139",
    "src/gdskills/remove-skill.ts:225",
    "src/gdskills/remove-skill.ts:278"
   ],
   "enumeration_method": "forced a failure at each of the five planned parts in order; only the report step leaves a state resolveTarget rejects."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-007"
 },
 {
  "id": "G-008",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "Hand copies of the on-disk format remain in verify.ts, commands/skills.ts, governance/stocktake.ts, install.ts and import-skills.ts; the catalog column order has two owners.",
  "impact": "A change in project-skills.ts leaves verify, skills list, stocktake and install on the old value with no failing test.",
  "suggested_fix": "Use the shared constants; export the catalog row builder and key.",
  "evidence": "verified by search — 15 hits in 5 files.",
  "confidence": "high",
  "file": "src/gdskills/verify.ts",
  "line": 87,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-008"
 },
 {
  "id": "G-009",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "REVIEW_MODULE, projectReviewerFlags and addFlagCollisionWarnings duplicate the module constant, enumerator and family-flag rule in reviewers.ts.",
  "impact": "The import warning can describe a family the inventory does not report.",
  "suggested_fix": "Move them into reviewer-triggers.ts and call them from both.",
  "evidence": "verified by reading both sites.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 465,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-009"
 },
 {
  "id": "G-010",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "No warning when a --force overwrite removes a flag from one of exactly two carriers.",
  "impact": "The remaining reviewer silently goes from path-gated to dispatched outright under that flag.",
  "suggested_fix": "Warn in that direction too.",
  "evidence": "verified — review-logic/imports.ts S6 e.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 520,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-010"
 },
 {
  "id": "G-011",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "A bare '-' item ends a block list; keys nested under another mapping inside metadata are read as metadata fields.",
  "impact": "'- --a', '-', '- --b' yields [--a]; metadata.nested.category: review routes a package to module review.",
  "suggested_fix": "Accept an empty item; match only keys at the first metadata key's indent.",
  "evidence": "verified — review-logic/triggers.ts and imports.ts S7.",
  "confidence": "high",
  "file": "src/gdskills/reviewer-triggers.ts",
  "line": 67,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-011"
 },
 {
  "id": "G-012",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "projectSkillSlug falls back to 'entity' for a name with no [a-z0-9]; refuseSharedDestinations runs before the deprecated skip.",
  "impact": "A directory ___ imports as <module>/entity silently; a deprecated alias beside its target refuses --only '*'.",
  "suggested_fix": "Refuse a name that slugs to the fallback; drop deprecated-skipped sources first.",
  "evidence": "verified — review-logic/imports.ts S1b, S2.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 678,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-012"
 },
 {
  "id": "G-013",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "Nine refusals and clauses in remove-skill.ts survive deletion.",
  "impact": "E.g. R29 deletes an unrelated json naming the package and R33 treats an unparseable manifest as empty, with the suite green.",
  "suggested_fix": "Add the fixtures in probe-remove.test.ts.txt.",
  "evidence": "verified — mutations R01, R05, R12, R14, R17, R25, R26, R29, R33 survived.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 246,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-013"
 },
 {
  "id": "G-014",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The lock-absence assertion cannot fail because withFileLock removes the lock in finally.",
  "impact": "Moving planning under the lock keeps the suite green while a refused run creates .metaproject/data/gdskills/.",
  "suggested_fix": "Assert on the lock's parent or spy on withFileLock.",
  "evidence": "verified — R32 survived.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.test.ts",
  "line": 315,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-014"
 },
 {
  "id": "G-015",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "Import gates survive deletion: opening fence, inMetadata scope, KNOWN_CATEGORIES filter, review-module half of isWritten, commandLabel hand-off.",
  "impact": "Correct today; the next edit to these gates is unprotected.",
  "suggested_fix": "Add the reviewer's fixtures.",
  "evidence": "verified — I22, I25, I27, I35, O3 survived.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 384,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-015"
 },
 {
  "id": "G-016",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The ratchet misses fs.promises.rm on a default import and '{ promises as fsp }'.",
  "impact": "A raw recursive rm can return to the deleting command with the ratchet green.",
  "suggested_fix": "Match both shapes.",
  "evidence": "verified — C7, C8 survived.",
  "confidence": "high",
  "file": "src/lib/contained-write.ratchet.test.ts",
  "line": 163,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-016"
 },
 {
  "id": "G-017",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The gdskills->review guard ignores type-only imports.",
  "impact": "Type-level mutual dependency can return with the guard green.",
  "suggested_fix": "Count type-only edges or document the exemption.",
  "evidence": "verified — P2 survived.",
  "confidence": "medium",
  "file": "src/lib/import-policy.live.test.ts",
  "line": 341,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-017"
 },
 {
  "id": "G-018",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "Docs say a declared metadata.flags always replaces description flags; the code does so only when the list has at least one entry.",
  "impact": "An author writing flags: [] to switch description flags off is told it works; it does not.",
  "suggested_fix": "Say 'when it has at least one entry' at every site.",
  "evidence": "verified — doc-gate/probe4.sh.",
  "confidence": "high",
  "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.detail.md",
  "line": 17,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r02#G-018"
 },
 {
  "id": "H-001",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "skills remove finds the package only by its exact readdir spelling. When registered review/alpha lives on disk as review/Alpha or Review/alpha (case-insensitive FS), it reports package:absent and still removes the catalog row and the registry entry.",
  "impact": "The package stays on disk and in `keryx review reviewers`, so it is still dispatched, while remove reported success. Reachable through keryx itself once a case-variant module dir exists: `skills create beta --module quality` writes into an existing Quality/ dir.",
  "suggested_fix": "When a registered entry's exact path is missing, look for a case-insensitive match in readdir; if found, refuse and name the on-disk spelling (as spelledOtherwise does for input) instead of reporting absent.",
  "evidence": "verified — r360-3/review-security-code/n-remove.ts N1 and review-verifier/v1.sh cases A and B at HEAD: parts report:absent,catalog:removed,package:absent,registry:removed; review/Alpha/SKILL.md left on disk; inventory still lists it. Verifier: confirmed.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 256,
  "class_scope": {
   "sites": [
    "src/gdskills/remove-skill.ts:255",
    "src/gdskills/remove-skill.ts:256"
   ],
   "enumeration_method": "keryx ctx rg 'exactEntry\\(' over src: 1 definition, 3 callers (256, 449 lstatExact, 477 isRealDirectoryChain); only 255/256 decide the package part."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-001"
 },
 {
  "id": "H-002",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "ruleReferences matches refs case-insensitively, but the ships-with-keryx guard tests `startsWith(\"core/\")`. A ref Core/<shipped>.mdc is written to .metaproject/rules/Core/…, which on a case-insensitive FS is rules/core/….",
  "impact": "The overlay's rule lands in the slot keryx init/update/skills install overwrite; after `skills install` the overlay content is gone and the reviewer reads keryx's rule. Main misplaces it the same way; this is a gap in the branch's new guard, not a regression.",
  "suggested_fix": "Compare the first segment case-insensitively, or lower-case refs in ruleReferences before planning.",
  "evidence": "verified — n-import.ts I2 and review-verifier/v2.sh: Core/security-baseline.mdc imported to rules/Core (= rules/core), marker gone after `skills install`; the lower-case control goes to rules/project/core and survives. Verifier: confirmed.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 1242,
  "class_scope": {
   "sites": [
    "src/gdskills/import-skills.ts:1242"
   ],
   "enumeration_method": "keryx ctx rg 'startsWith\\(\"core/\"\\)' over src: 1 hit."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-002"
 },
 {
  "id": "H-003",
  "reviewer": "review-security-code",
  "severity": "major",
  "problem": "resolveRuleReference accepts any existing path (pathExists), so a directory at a cited rule's path reaches readFile and the whole import, dry and real, aborts with a bare EISDIR naming no path.",
  "impact": "The import is refused with an unlabelled error; main imported the skill (reporting the rule present). A regression from main.",
  "suggested_fix": "stat the resolved candidate; if it is not a regular file, return an unresolved row or a labelled refusal naming the path.",
  "evidence": "verified — n-partial.ts (d) and review-verifier/v3.sh: HEAD dry and real print only 'EISDIR: illegal operation on a directory, read'; main reports 'house/x.mdc: present' and imports. Verifier: confirmed.",
  "confidence": "medium",
  "file": "src/gdskills/import-skills.ts",
  "line": 1265,
  "class_scope": {
   "sites": [
    "src/gdskills/import-skills.ts:1265"
   ],
   "enumeration_method": "keryx ctx rg 'readFile\\(path.join\\(options.projectRoot, existing\\)' over src: 1 hit; resolveRuleReference (rule-references.ts:79) is its only feeder."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-003"
 },
 {
  "id": "H-004",
  "reviewer": "review-testing-practices",
  "severity": "major",
  "problem": "The lock-path containment preflight (:159) and createProjectSkill's preflight call (:200) can each be deleted with every focused suite green (mutants W04, W06 survive).",
  "impact": "With .metaproject/data symlinked outside the project, under W04 `keryx skills import --from <SKILL.md> --module quality` exits 0 and creates <outside>/gdskills; under W06 `skills create` leaks outside and its dry run is not refused. HEAD itself refuses correctly; the guard is unpinned.",
  "suggested_fix": "Add the probe (review-testing-practices/probe-w04.test.ts.txt, review-verifier/probe.test.ts VP1-VP3) as tests for import and skills create.",
  "evidence": "verified — m-r3.ts W04/W06 survived; review-verifier mutated fresh copies: focused suites 284 pass / 0 fail under both, probes fail, CLI under W04 exits 0 and creates <outside>/gdskills. Verifier: confirmed.",
  "confidence": "high",
  "file": "src/gdskills/project-skills.ts",
  "line": 159,
  "class_scope": {
   "sites": [
    "src/gdskills/project-skills.ts:159",
    "src/gdskills/project-skills.ts:200"
   ],
   "enumeration_method": "mutated every assertWritableContained/assertProjectWritesContained/refuseUncontainedWrites call site: contained-write.ts:229, project-skills.ts:159/:161/:200, import-skills.ts:205-207/:250/:286; only :159 and :200 survived."
  },
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-004"
 },
 {
  "id": "H-005",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "The refusal for a package directory with no letter or digit advises `--name`, but under `keryx review import` that option is rejected as unknown; reviewer-skill-creator SKILL.detail.md:91 quotes the same advice.",
  "impact": "An operator following the advice gets exit 1 'Unknown option'. Only `skills import --module review --name` works.",
  "suggested_fix": "Under commandLabel `keryx review import`, advise `keryx skills import --from <dir>/SKILL.md --module review --name <name>`; update SKILL.detail.md:91 and its projection.",
  "evidence": "verified — review-logic/doc/probe5.sh (out5.log).",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 812,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-005"
 },
 {
  "id": "H-006",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "25 of 61 mutants of the consolidated reader survive; real gaps F03, F06, F12, F13, F14, F22, F23, F26, F35, F37, F42, F44, F45, F46, F49, F51, F52, F54, F55, F58, F59, F60, F63 (I25r, F34 equivalent).",
  "impact": "The subset promised in the module header (fence whitespace, quoted keys, anchors unsupported, quote escapes, it's, comma inside quotes, tabs, `paths: # none`) can regress unnoticed.",
  "suggested_fix": "One table-driven case per surviving mutant in skill-frontmatter.test.ts.",
  "evidence": "verified — r360-3/review-testing-practices/mutation-table.md.",
  "confidence": "high",
  "file": "src/gdskills/skill-frontmatter.ts",
  "line": 68,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-006"
 },
 {
  "id": "H-007",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "remove-skill survivors: N21-N24 (documented input spellings in normalizeSkillKey), N12/N13 (failure message 'Still in place'), N28 (catalog with no end marker), N33 (conventional-report symlink refusal), N25; N15, N16, N19 only observable under concurrency.",
  "impact": "`skills remove .metaproject/project-skills/review/x/` or `review/x/SKILL.md` could stop resolving and the recovery message could list the wrong parts with the suite green.",
  "suggested_fix": "Add input-spelling cases, an exact failure-message assertion and a catalog-without-end-marker fixture.",
  "evidence": "verified — m-r3.ts N01-N34.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 411,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-007"
 },
 {
  "id": "H-008",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "Surviving mutants T05 (literal without /), T15 (*.ext glob), T18 (flag inside a word), V01 (symlinked reviewer dir in skillPackageNames), W16 (dry-run --force reason).",
  "impact": "A description like 'Reviews *.ts files' could stop gating the reviewer unnoticed.",
  "suggested_fix": "Add those cases.",
  "evidence": "verified — m-r3.ts T/V/K/W series.",
  "confidence": "high",
  "file": "src/gdskills/reviewer-triggers.ts",
  "line": 124,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-008"
 },
 {
  "id": "H-009",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The ratchet now catches C7/C8 but misses `const fsp = fs.promises` (C8c), `const { rm } = fs.promises` (C8d) and `require(\"node:fs\").promises.rm` (C8e).",
  "impact": "A raw recursive rm can return to an owned module in these spellings with the ratchet green.",
  "suggested_fix": "Flag any `.promises` binding/destructuring and require(\"node:fs\") in owned modules.",
  "evidence": "verified — m-guards-r3.ts.",
  "confidence": "high",
  "file": "src/lib/contained-write.ratchet.test.ts",
  "line": 199,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-009"
 },
 {
  "id": "H-010",
  "reviewer": "review-testing-practices",
  "severity": "minor",
  "problem": "The dry-run test's lock-absence assertion cannot fail (withFileLock removes the lock in finally); expectRefusedUntouched (:312-313) is vacuous in report fixtures; skill-frontmatter.test.ts:150-153 never reaches readBlockList's break.",
  "impact": "Tests read as guarding the lock and block-list end but pass for other reasons (F34/F35 survive); only remove-skill.test.ts:890 really guards the lock.",
  "suggested_fix": "Assert on the lock's parent; give the block-list test a deeper non-item line.",
  "evidence": "verified — reading plus F34/F35 survival.",
  "confidence": "medium",
  "file": "src/gdskills/remove-skill.test.ts",
  "line": 189,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-010"
 },
 {
  "id": "H-011",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "G-008 residue: withoutCatalogRow reads the catalog row by cell index while projectSkillCatalogRow (project-skills.ts:134) writes it; the <module>/<name> key (:165, :220, :314) and package path (:254, :338) are rebuilt by hand.",
  "impact": "A change to the row or key format in project-skills.ts leaves skills remove reporting the catalog absent and the row in place, with no failing test at the writer.",
  "suggested_fix": "Export a row parser beside projectSkillCatalogRow; use projectSkillKey / projectSkillPackagePath.",
  "evidence": "verified — keryx ctx rg for projectSkillKey|projectSkillCatalogRow|projectSkillPackagePath and hand-built templates.",
  "confidence": "high",
  "file": "src/gdskills/remove-skill.ts",
  "line": 544,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-011"
 },
 {
  "id": "H-012",
  "reviewer": "review-architecture",
  "severity": "minor",
  "problem": "G-009 residue: literal \"review\" at :367, :370, :776, :788, :1357 in the file that imports and uses PROJECT_REVIEWER_MODULE at :497 and :552.",
  "impact": "Renaming the reviewer module leaves the import summary, inference and wiring note on the old name.",
  "suggested_fix": "Use PROJECT_REVIEWER_MODULE at all five sites.",
  "evidence": "verified — keryx ctx rg.",
  "confidence": "high",
  "file": "src/gdskills/import-skills.ts",
  "line": 367,
  "global_id": "2026-09-30-ingest-worktree-reviewer-import-fixes-r03#H-012"
 }
]
```
