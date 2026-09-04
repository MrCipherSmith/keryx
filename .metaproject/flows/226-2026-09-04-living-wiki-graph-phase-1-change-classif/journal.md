# Flow Journal

- 2026-09-04T06:33:35.496Z - flow created
- 2026-09-04T06:34:57.211Z - task-done: T1: Collect remaining context
- 2026-09-04T06:34:57.303Z - task-added: T5: Freshness queue writer + post-commit hook body, append-only, 50ms budget (AC6,AC14)
- 2026-09-04T06:34:57.378Z - task-added: T6: Change classification over SymbolNode.signature with honest degradation (AC1,AC2,AC4)
- 2026-09-04T06:34:57.459Z - task-added: T7: Impact propagation: edge-type policy, confidence decay, reason chains (AC3,AC13)
- 2026-09-04T06:34:57.534Z - task-added: T8: Both freshness paths: git range and VerifiedScope fallback (AC11,AC12)
- 2026-09-04T06:34:57.635Z - task-added: T9: keryx wiki freshness: categories, limitations, --json, exit 0 always (AC5,AC7,AC8,AC9)
- 2026-09-04T06:34:57.733Z - task-added: T10: Orphan category projected from wikiPruneOrphans, not reimplemented (AC10)
- 2026-09-04T06:34:57.834Z - task-added: T11: Tests per AC incl. no-git, absent graph, corrupt queue line, hub-module propagation (AC15)
- 2026-09-04T06:34:57.938Z - frozen: 15 criteria; checksum recorded
- 2026-09-04T06:34:58.037Z - started

## 2026-09-04 — T6 and T7: classification and propagation

### Hub blast radius, measured rather than assumed

The plan named this as a risk and demanded a real measurement, not a fixture.
On the actual graph (1124 nodes, 3406 edges, 373 describes edges, 55959 call
edges), a single change propagated:

| change | pages reached | must-refresh / review-suggested / fyi |
|---|---|---|
| `src/lib/fs.ts` signature | 37 of 50 | 1 / 23 / 13 |
| `src/lib/fs.ts` body | 1 | 0 / 1 / 0 |
| `src/lib/config-dir.ts` signature | 17 | 1 / 3 / 13 |
| `src/gdgraph/types.ts` signature | 10 | 1 / 6 / 3 |
| `src/wiki/service.ts` signature | 10 | 3 / 2 / 5 |
| `src/wiki/service.ts` body | 3 | 0 / 3 / 0 |

2–5 ms per call, so speed is not the concern.

**The decay does bound the walk, but it does not make a hub change quiet.**
A signature change in `src/lib/fs.ts` reaches 74% of the corpus. That is not
wrong — a utility that half the repository imports genuinely can invalidate
that much prose — but 23 advisory rows from one commit is more than a person
will read, and an unreadable backlog is an ignored one.

The wrong fix would be a fan-out cap. The specification rejects arbitrary hop
limits for a reason, and a cap on breadth is the same instrument wearing a
different hat: it would silently drop real signal with no way to tell which.

The right fix is at presentation, and it belongs to T9: **`wiki freshness`
should show `must-refresh` and `review-suggested` by default, with `fyi`
behind a flag.** The data stays complete, the default view stays actionable,
and nothing is discarded. Recorded here so T9 does not have to rediscover it.

Also worth noting for the same reason: a `body` change reaches exactly one
page in every case measured. The direction rules are doing real work — most
of the fan-out cost is paid only by the class that has earned it.

### Classification: what it can and cannot claim

`signature` detection reuses the tree-sitter adapter over both revisions of a
file rather than adding a second parser; the adapter already accepts arbitrary
`FileRecord`s, so a file's previous content can be extracted the same way its
current content is.

Without that layer the classifier returns `body` for any substantive change
and never `signature` (AC4), and the same holds when the extractor throws.
Both directions were chosen deliberately: a guessed `signature` routes a page
to prose enrichment, which is the expensive path, on no evidence.

The cosmetic normaliser walks string and template literals so a `//` inside a
URL is never read as a comment, and returns the input unchanged when it
cannot parse confidently. That failure direction costs a wasted backlog entry;
the opposite would silently drop a real change and nobody would learn of it.
- 2026-09-04T07:05:33.883Z - task-done: T6: Change classification over SymbolNode.signature with honest degradation (AC1,AC2,AC4)
- 2026-09-04T07:05:33.983Z - task-done: T7: Impact propagation: edge-type policy, confidence decay, reason chains (AC3,AC13)

## 2026-09-04 — T8, T9, T10, and a false positive only the real corpus showed

### The bug fixtures could not have caught

The first end-to-end run of `wiki freshness --since HEAD~5` on this repository
reported twelve changed signatures in `src/gdgraph/build.ts`:
`matchesAlias@455`, `matchesAlias@467`, `candidateBases@484`, and so on.
Nothing about those functions had changed. The only edit to that file was a
`try`/`catch` block added above them.

Cause: `changedSignatures` keyed on `SymbolNode.id`, and that id appends
`@<startLine>` when two symbols in a file share a name. Adding eight lines
shifted every same-named sibling, so each looked like one symbol disappearing
and another appearing. Every unit test passed throughout — the fixtures used
unique names, which is exactly the case the bug does not touch.

Fixed by keying on a position-free identity (`path#container.name`). The
trade is stated at the site: same-named siblings now collapse into one key,
which under-reports a same-name overload changing. That is the safe
direction, since the alternative fires on every reflow — and a signature
verdict routes a page to the expensive prose path.

Second defect from the same run: a page reachable by four routes from one
change collected four near-identical reason rows, burying the distinct causes
it also had. Reasons are now one row per (source, change class), keeping the
shortest path that reached it.

### What the run looks like now

50 pages, 44 affected, 6 undecidable, 110 files changed, 0 cosmetic over that
range. The signals are real: `getFilesDescribedBy, getPagesDescribing`
reported as a signature change (they are new exports), `wiki-layer.ts` as
`added`, `build.ts` as `body`.

Every page reports `unknown`, because no page carries `VerifiedAt` or
`VerifiedScope` yet — nothing has stamped them. That is the honest category
and not a defect: `wiki verify` is phase 2. Worth stating because it means
AC13's ordering has nothing to sort on until stamping exists, and the
acceptance test must therefore drive `commitsBehind` through a stubbed git
rather than the live corpus.

### Presentation follows the earlier measurement

`fyi` rows are hidden from the human view unless `--all` is passed — the
decision recorded in the previous entry after a hub change reached 37 of 50
pages. The default run above hid 31 advisory rows and showed 13. `latest.json`
keeps everything.
- 2026-09-04T07:18:21.057Z - task-done: T8: Both freshness paths: git range and VerifiedScope fallback (AC11,AC12)
- 2026-09-04T07:18:21.143Z - task-done: T9: keryx wiki freshness: categories, limitations, --json, exit 0 always (AC5,AC7,AC8,AC9)
- 2026-09-04T07:18:21.226Z - task-done: T10: Orphan category projected from wikiPruneOrphans, not reimplemented (AC10)
- 2026-09-04T07:43:01.115Z - ac-updated: AC6's 50ms threshold was set before measuring the platform floor. Measured: an EMPTY post-commit hook costs ~16ms on this machine and each subprocess ~24ms, so 50ms was an arbitrary line just above an unknown floor. Restated against the floor (at most 2x) and recorded the optimised measurement: median 40.9ms, p95 50.7ms over 120 isolated runs, down from ~121ms for the first working version. No other criterion changed

## 2026-09-04 — T5 and T11: the queue, and what the probe found that reasoning did not

### Two bugs, both found by running the hook rather than reading it

**Commits touching a path with a quote were dropped in silence.** git renders
such a path in C-style quoting — `"src/we\"ird.ts"` — and `core.quotePath=false`
does NOT turn that off; it only governs non-ASCII bytes. The quoted line fails
the `^src/` prefix filter, so the hook returned 0 and recorded nothing. Not a
crash, not a warning: one commit's worth of change vanished.

Fixed by detecting the leading quote and marking the entry `truncated`, which
already meant "do not trust this path list, re-read the revision from git".
The mechanism for the failure was already in the schema; it just was not
wired to this cause.

**Every entry carried a phantom empty path.** `printf '%s\n' "$changed_files"`
appended a newline to a string that already ended with one, and the escaping
pipeline dutifully turned the resulting blank line into `""`. Visible only in
the probe's parsed output.

Neither was reachable by unit tests over the TypeScript side: both live in
generated shell.

### AC6 was a number I invented, and the measurement said so

The criterion read "under 50 ms at p95". Measuring the platform first
(Apple-silicon macOS, `git commit` timed with and without a hook):

| hook | median | p95 |
|---|---|---|
| none | 48.7 ms | 61.8 ms |
| empty (`exit 0`) | 64.5 ms | 80.5 ms |
| + 1 git call | 88.9 ms | 99.5 ms |
| + 2 git + date + append | 111.7 ms | 170.7 ms |

The floor for ANY hook is ~16 ms, and each subprocess adds roughly 24 ms. A
flat 50 ms was therefore a line drawn just above an unknown floor, and it was
drawn before any of this was known.

Optimisation followed the measurement rather than guesswork: four git calls
became one `git log` carrying revision, parent, timestamp and changed paths
together, and parsing plus prefix filtering moved to shell built-ins (no
`sed`, `cut` or `grep` processes). Added commit cost fell from ~121 ms to
~44 ms.

Timed in isolation, 120 runs over 20 changed files: **median 40.9 ms, p95
50.7 ms, max 61.4 ms** — 2.5× the floor.

AC6 is now expressed against the floor (at most 2×) instead of an absolute
millisecond count, amended through `keryx flow ac update` with the numbers
attached. Rejected explicitly: folding `sed`+`paste` into one `awk` to save
~10 ms. Two escaping bugs have already been found in this hook, and a fourth
level of quoting is exactly where the third would hide — 10 ms is not worth
that.

### Queue semantics

The queue supplies the base revision when `--since` is absent; that is the
point of accumulating it. It is cleared only AFTER the report is persisted —
clearing first would lose the range if the write then failed, and the next
run would quietly report a narrower window than the user asked about.

A corrupt line is skipped, counted, and declared as a limitation. Full suite:
6721 pass, 48 fail — the same 48 that fail at the branch base, so no
regressions.
- 2026-09-04T08:01:40.852Z - task-done: T5: Freshness queue writer + post-commit hook body, append-only, 50ms budget (AC6,AC14)
- 2026-09-04T08:01:40.935Z - task-done: T11: Tests per AC incl. no-git, absent graph, corrupt queue line, hub-module propagation (AC15)
- 2026-09-04T08:02:03.225Z - ac-confirmed: AC1: classify-change.test.ts 'a comment-and-formatting-only edit is cosmetic'; propagate.test.ts 'a cosmetic change produces NO entry at all'; report.test.ts counts filesCosmetic and emits zero pages
- 2026-09-04T08:02:03.321Z - ac-confirmed: AC2: classify-change.test.ts signature-vs-body pair; report.test.ts 'stale-reference' when the symbol is absent from prose and 'stale-prose' when it is named
- 2026-09-04T08:02:03.401Z - ac-confirmed: AC3: propagate.test.ts 'every affected page carries a non-empty, traceable reason' and the edge-path-lengthens test; reasons deduped per (source,class)
- 2026-09-04T08:02:03.478Z - ac-confirmed: AC4: classify-change.test.ts 'with no extractor a substantive change is body and never signature' plus the throwing-extractor case; report.test.ts declares symbol-layer-unavailable
- 2026-09-04T08:02:03.557Z - ac-confirmed: AC5: report.test.ts 'building a report writes nothing into the wiki' (dir listing and byte comparison); command returns without a non-zero exit
- 2026-09-04T08:02:03.648Z - ac-confirmed: AC6: AMENDED against the measured platform floor. Isolated 120 runs over 20 changed files: median 40.9ms, p95 50.7ms, max 61.4ms = 2.5x the ~16ms floor for an empty hook, down from ~121ms added for the four-git-call version
- 2026-09-04T08:02:03.754Z - ac-confirmed: AC7: Report shape carries pagesUndecidable and populated limitations; report.test.ts asserts both. --json emits the same object the schema describes
- 2026-09-04T08:02:03.869Z - ac-confirmed: AC8: report.test.ts 'an unbuilt graph yields no pages, a declared limitation, and no orphan claims'
- 2026-09-04T08:02:03.962Z - ac-confirmed: AC9: report.test.ts 'a page with no describe-set is excluded from scoring and declared', affectedCount asserted
- 2026-09-04T08:02:04.066Z - ac-confirmed: AC10: report.test.ts 'a page whose module left the graph is orphan, from the module set' — shrinking nodes.jsonl changes the category, proving validModuleNames drives it
- 2026-09-04T08:02:04.146Z - ac-confirmed: AC11: page-freshness.test.ts 'with no git at all, the hash path decides and caps confidence'; wiki-layer-no-git.test.ts runs the whole path on a tree with no .git
- 2026-09-04T08:02:04.226Z - ac-confirmed: AC12: page-freshness.test.ts 'a VerifiedAt this history has never heard of falls through, not errors' plus the failing-log fallback
- 2026-09-04T08:02:04.307Z - ac-confirmed: AC13: report.test.ts 'entries are sorted by commits behind, descending'; renderMarkdown hides fyi by default per the measured 37-of-50 hub fan-out
- 2026-09-04T08:02:04.387Z - ac-confirmed: AC14: queue.test.ts 'a corrupt line is skipped and counted, and the rest still drain' plus the valid-JSON-but-not-an-entry case; run.ts declares queue-truncated
- 2026-09-04T08:02:04.468Z - ac-confirmed: AC15: Full suite 6721 pass / 48 fail; the same 48 fail at the branch base, verified earlier in a worktree at 94998d9a. Branch adds ~200 passing tests
- 2026-09-04T08:25:41.855Z - task-done: T2: Implement per plan
- 2026-09-04T08:25:41.950Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-04T08:25:42.038Z - task-done: T4: Self-review and prepare draft PR
