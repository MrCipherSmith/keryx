# W7 — gdgraph & gdctx correctness
Version: 0.1.3

## Summary

Every other workstream in this package (D-8) routes navigation, search, and
large-output reading through `keryx gdgraph` and `keryx ctx`. If those two
tools mislabel clean output as failures, silently drop public information, or
reject the flag syntax an agent already knows, agents route around them —
which is exactly the failure mode this workstream exists to close before any
other wave builds on top of it. This document re-verifies each defect from
an earlier, unpublished investigation live against the current worktree, adds
exact line references, and designs the fixes. Two items that investigation
flagged as open turned out, on this pass, to already have real fixes in code — `keryx gdgraph`
already ships a tri-state freshness check (`src/gdgraph/staleness.ts`), and
generic dynamic-import/re-export/barrel handling already runs through Bun's
transpiler + a regex fallback (`src/gdgraph/build.ts:247-291`), not just the
two self-referential `await import()` call sites that investigation named. Three
defects remain live and reproduced in this session: a keyword-stem error
classifier that mislabels ordinary stdout as a tool failure (GDCTX-1), an
unconditional image-URL redaction rule that makes `ctx read` lossy on any
README with CI/npm badges (GDCTX-2), and a POSIX-bundled-flag rejection in
`ctx rg` (GDCTX-3). A fourth item, the `.metaproject/index.md` hard-gate cost,
is a measured design defect, not a code bug, with a concrete cheaper-gate
proposal already written up. Everything proposed here — regression fixtures,
a correctness benchmark, a hook allowlist, memory entries — is `planned`;
nothing below has been implemented in this pass beyond the fixes explicitly
marked "fixed, verified this session."

## Current state (verified fixed, with proof)

Re-run live in this worktree (`/Users/Goodea/goodea/keryx-agent-platform`,
main-derived branch, `keryx --version` 0.2.154):

- **`ctx diff --stat` matches `git status --short`.** The 2026-07-10
  diff-stat misparse is gone: `keryx ctx diff --stat` reported the same 3
  changed `.metaproject/data/gdgraph/**` paths `git status --short` did, with
  correct per-file byte deltas. No misparse reproduced.
- **`gdgraph build` import resolution.** `keryx gdgraph build` on this
  1,788-node tree: 5,674 edges, 63 unresolved (98.9% resolved). Every
  unresolved edge audited traces to either a genuine external module (4
  Python stdlib imports in a `.py` probe script) or a deliberately-fake
  specifier inside `src/gdgraph`'s own test fixtures (`./a`, `./b`,
  `./style.css`, etc., in `build-lang.test.ts`, `import-kind.test.ts`,
  `service.test.ts`, `fallback.test.ts`). No missed real import found in this
  sample.
- **Dynamic import / re-export / barrel handling is generic, not
  special-cased.** `extractImportRecords` (`src/gdgraph/build.ts:225-291`)
  unions two extractors for every TS/JS file: `Bun.Transpiler#scanImports`
  (`src/gdgraph/build.ts:315-330`, reports `dynamic-import` kind for
  `import()` expressions) and a regex fallback
  (`src/gdgraph/build.ts:332` onward) whose JS/TS pattern set explicitly
  matches `export ... from "..."` re-exports — used specifically to recover
  the type-only re-exports the transpiler erases. This is tested, not just
  present: `import-kind.test.ts:264` (`export { type X } from './m'`
  classified type-only) and `wiki-layer.test.ts:161` /
  `wiki-layer-no-git.test.ts:20` (`export * from "./run"`, a barrel-style
  re-export) both exercise it directly. A barrel `index.ts` using
  `export * from "./foo"` therefore produces a real graph edge, not a gap —
  this closes the "no `export *` handling found" open item from an earlier,
  unpublished investigation; it existed, just not under the two call sites
  that investigation searched.
- **Freshness self-check already exists and is wired in.**
  `src/gdgraph/staleness.ts` (`checkGraphStaleness`, flow 234 AFC-10) reads
  `.provenance.json` (commit/branch/`builtAt`, written by every
  `gdgraph build`) and diffs it against `git` state, returning a tri-state
  `fresh | stale | unknown` — `unknown` on a git failure, never silently
  downgraded to `fresh`. `src/commands/gdgraph.ts:577-593`
  (`printStaleNote`) prints `STALE_NOTE`/`UNKNOWN_NOTE` plus reasons whenever
  a query command's result would otherwise look unconditionally current.
  This is real, tested code (`staleness.test.ts`, 15 assertions including
  "never built" → `stale` not a git-failure `unknown`, and the graph's own
  build residue never triggering a false-stale). **What is not yet
  established**: whether every read path that reports something as fact
  (`gdgraph affected`, `gdgraph query`) actually calls `printStaleNote` —
  confirmed for at least one call site in `commands/gdgraph.ts`; a full
  audit of every subcommand is listed under Open questions, not claimed here.
- **`ctx rg` completeness labeling is accurate.** `keryx ctx rg "TODO" src`
  (14 of 17 matches, `partial`) vs. `--all` (17 of 17, `complete`) — the
  disclosed counts matched actual totals in both calls; not a defect.
- **`ctx read` large-file compaction recovers correctly.** `keryx ctx read
  README.md` (837 lines) omits ranges with recoverable pointers
  (`keryx ctx show <raw-log> --raw --lines N-M`); the disclosure/recovery
  contract in `src/ctx/lines.ts` (`omissionNote`, `shownSuffix`,
  `omittedRanges`) works as documented.

## Defect register

| id | symptom | repro command | evidence | root cause (file:line) | severity | fix direction |
|---|---|---|---|---|---|---|
| GDCTX-1 | `ctx run`/`ctx rg` output classifies ordinary stdout as "Errors / Warnings" by English keyword stem, regardless of exit code or stderr | `keryx ctx run -- printf 'refuse this\n'` | Reproduced this session: exit 0, stderr bytes 0, `refuse this` duplicated into both "Errors / Warnings" and "Output" | `src/ctx/lines.ts:46` — `FAILURE_STEMS` regex (`\b(fail\|error\|...\|refus\|reject\|...)/i`) applied unconditionally to every line of arbitrary stdout, not just tool-verdict output | High — actively misleads an agent into treating a clean command as failed, on ordinary English (commit messages, doc prose, code comments containing "refuse," "reject," "cannot," "crash") | Make classification stream- and exit-code aware (see Design §1): only promote a line to "Errors / Warnings" when it came from stderr, or the command's own exit code was non-zero, or it matches a `REPO_FAILURE_MARKER` (already source-scoped, e.g. `(fail)`, `✗`) — never a bare English stem on stdout of a clean run |
| GDCTX-2 | `ctx read`/`ctx run` redacts `<img src>`/markdown-image URLs as `[REDACTED:url]` even for public, non-sensitive URLs, in files explicitly tagged `source: "trusted-project"` | `keryx ctx read README.md --mode full` | Reproduced this session: CI badge, npm badge, and the repo's own logo `<img>` all redacted; outer `<a href="https://github.com/...">` left intact. Root cause traced end to end: `redactRaw` call at `src/commands/ctx.ts:317` passes `source: "trusted-project"`; `buildFinding`/`resolveDecision` (`src/security/resolve.ts:74-189`) select policy purely by `policyFor(match.category, config)` (`resolve.ts:37-51`, category-only, no source parameter) and filter redactable matches purely by `m.mask !== undefined` (`resolve.ts:184`) — `opts.source` is attached to the finding as metadata (`resolve.ts:84-87`) and never consulted for the policy/redaction decision itself. `src/security/types.ts:15-23` documents `trusted-project` as "the operator vetted it by committing it," but nothing in `resolve.ts` reads that field to change the egress/image-URL policy outcome | `src/commands/ctx.ts:317` (call site) + `src/security/resolve.ts:37-51,74-111,184-187` (policy/redaction never branches on `SecuritySource`) | Medium-High — makes `ctx read` lossy on the single most common OSS README pattern (CI/npm/license badges), undermining "read files via `keryx ctx read`" as the routing default this whole program depends on | Give the egress/image-URL policy a source-aware exception: `trusted-project` content keeps public, non-credential-bearing URLs (still redacts anything matching a secret/PII/query-param-with-token pattern) — see Design §2 |
| GDCTX-3 | `ctx rg` rejects bundled POSIX short flags (`-il`) that work fine split (`-i -l`) | `keryx ctx rg -il "todo" src` | Reproduced this session: `keryx ctx rg: unsupported ripgrep option -il. Only a reviewed set of options is forwarded...` vs. `-i -l` (two tokens) succeeding | `src/commands/ctx.ts:961-963` splits each arg only on `=` (inline-value form) before checking `RG_SAFE_FLAGS`/`RG_SAFE_VALUE_FLAGS` (defined `ctx.ts:875-917`); a bundled short-flag token like `-il` is never expanded into `-i`, `-l` before the allowlist check at `ctx.ts:996-1008`, so it fails the exact-string match at the same `RG_SAFE_FLAGS.has(name)` test that would pass either flag individually | Low-Medium — pure friction; pushes an agent toward raw `rg`/an escape marker purely from habit-driven flag syntax, not from any real need for an unreviewed option | Expand bundled short flags into their split form before the allowlist check, using only the already-reviewed boolean-flag set (`RG_SAFE_FLAGS`) — never expand into a value-flag, which cannot legally bundle — see Design §3 |
| GDCTX-4 (historical, fixed) | `ctx diff --stat` previously misparsed diff-stat output | `docs/report/release-readiness-2026-07-10/release-readiness.md:102` | Live re-check this session: `keryx ctx diff --stat` output matches `git status --short` exactly, 3/3 files | unlocated in this checkout (fixed before this branch) | N/A — closed | No action; add a regression fixture (Benchmark §) so it cannot silently regress |
| GDGRAPH-1 (historical, fixed with proof) | gdgraph produced 0 edges for Java/Python-heavy repos | `docs/requirements/gdgraph-java-import-resolution/README.md` | Live build this session: 98.9% resolution, 63/5,674 unresolved, all traced to fixtures/external modules | `src/gdgraph/build.ts` resolver (fixed) | N/A — closed | No action |
| GDGRAPH-2 (verified NOT a gap, corrected from an earlier finding) | Suspected: no `export *`/barrel/dynamic-import handling in gdgraph | n/a (code read, not a live repro) | `src/gdgraph/build.ts:225-330` (`extractImportRecords`, `scanImportsOrEmpty`) + `src/gdgraph/import-kind.test.ts:264`, `wiki-layer.test.ts:161` | `src/gdgraph/build.ts:225-291` | N/A — this session's re-check found this handled and tested, not a gap; the earlier finding only searched the two internal `await import()` call sites, not the general extractor | Record as a confirmed-correct finding; add golden fixtures to the correctness benchmark so the behavior stays pinned rather than re-litigated |
| GDGRAPH-3 (new, suspected gap, unconfirmed as live false negative) | `tsconfig.json` path-alias resolution reads only the root config's own `compilerOptions.paths`/`baseUrl`; an `extends` chain (common in monorepos, e.g. a shared `tsconfig.base.json` carrying `paths`) is never followed | n/a — code read; `keryx ctx rg "extends" src/gdgraph/build.ts` returns 0 matches | `src/gdgraph/build.ts:612-643` (`loadTsconfigResolver` reads only `parsed.compilerOptions`, no `parsed.extends` resolution) | `src/gdgraph/build.ts:612-643` | Medium (scope-dependent — irrelevant to this repo, which has no `extends`; relevant to any consumer repo using a shared base config) | Confirm with a repro fixture (a two-file tsconfig with `extends` + `paths` in the base) before committing to a fix; if confirmed, walk the `extends` chain (bounded depth, cycle-guarded) merging `paths`/`baseUrl` before building the resolver |
| GDCTX-5 (design/measurement defect, not code) | `.metaproject/index.md` hard-gate read (~3,226 tokens) is re-billed every subsequent turn because the transcript re-sends; multiplies per subagent dispatch; `keryx orient` (the intended fix) is not installed, fires per-prompt not per-session, and adds to rather than replaces the gate text | n/a — measured in `docs/requirements/keryx-context-measurement/context-loading.md` against a live transcript (41,556/41,681/41,823/42,133 tokens across 4 turns) | `docs/requirements/keryx-context-measurement/context-loading.md` §§1-3; `src/ctx/orient-runtimes.ts:11` (registers `UserPromptSubmit`, confirmed by reading the file this session) | Design of the `CLAUDE.md`/`index.md` hard-gate rule; `src/ctx/orient-runtimes.ts:11` | High (cost/scale) — explicitly a design defect, not a one-file patch | See Design §5 (index cost reduction options, with the measurement's own proposed ~300-token replacement gate) |
| GDCTX-6 (open feature gap, no defect) | No governed, measurable context-assembly layer; source selection across gdgraph/gdwiki/memory/skills is ad hoc with no provenance/why-chosen trace | n/a | `docs/requirements/keryx-context-operations/2026-07-12/README.md` — status `specification ready — future implementation` | N/A | Informational | Out of scope for W7; scoping context only |

## Hook friction register

The `keryx ctx` PreToolUse hook (`src/ctx/hook-classify.ts`,
`classifyCommand`/`buildBlockMessage`) blocks a narrow, deliberately-scoped
set of raw command families and always prints a self-service escape marker
(`# keryx:raw <reason>`) in its rejection message. Reproduced/verified this
session:

| raw command family | blocked? | routed to | escape marker required |
|---|---|---|---|
| `rg`/`grep`/`egrep`/`fgrep`/`ripgrep` (tree search, `-r`/no-path) | yes | `keryx ctx rg` | yes |
| `cat`/`head`/`tail` (file read) | yes | `keryx ctx read` | yes |
| `sed`/`awk` printing content (not `-i`) | yes | `keryx ctx run -- <command>` | yes |
| `find` (any) | yes | `keryx ctx run -- <command>` | yes |
| recursive `ls -R`/`--recursive` | yes | `keryx ctx run -- <command>` | yes |
| `git diff`/`git log`/`git show` | yes | `keryx ctx diff [--stat\|--staged]` / `keryx ctx run -- git log …` | yes |
| `git status` | **no** — not in `GIT_ROUTABLE` (`/^(diff\|log\|show)$/`, `src/ctx/hook-classify.ts:76`) | n/a | n/a |
| non-recursive `ls`, `wc`, `echo`, `printf` | no | n/a | n/a |

Friction points found, beyond the flag-bundling defect already registered as
GDCTX-3:

1. **The escape hatch is self-service and unaudited.** `escapeReasonOf`
   (`src/ctx/hook-classify.ts:38-57`) accepts any trailing text after
   `# keryx:raw`, including an empty string (`.trim()` on an empty capture
   group still returns `escapeReason: ""`, which the classifier treats as
   "allowed"). Nothing downstream records *why* an agent escaped, beyond
   whatever free text happens to be in the shell history — an agent that
   read the error message once can bypass the gate indefinitely with no
   logged justification. This is documented as a known limitation in the
   module's own comments (`hook-classify.ts:1-13`), not a hidden defect, but
   it is friction worth a design response: a routing audit that distinguishes
   "classified-and-routed" from "classified-and-escaped-with-reason X" from
   "could-not-classify" (the module's own comment at `hook-classify.ts:110-113`
   already names this as the honest next step).
2. **The classifier's own comments document its ceiling.** `stages()`
   (`hook-classify.ts:121-131`) requires `tokens[0]` to match a fixed name
   list; `sh -c '...'`, `$(...)`, backticks, `eval`, and `xargs` all pass
   unclassified — a documented, not accidental, limitation
   (`hook-classify.ts:104-108`).
3. **`git status` is correctly NOT blocked** (bounded output, no routing
   value) — included in the table for completeness, not as a defect.

### Proposed safe read-only allowlist (allowed without routing, not raw-bypassed)

Rather than expanding the escape-marker habit, or routing these through
`keryx ctx run`, add a small, bounded set of read-only git subcommands to a
new `GIT_READONLY_ALLOW` set that the classifier checks *before*
`GIT_ROUTABLE`: matching commands pass through exactly as `git status`
already does today — never blocked, never require `# keryx:raw`, and never
enter `keryx ctx run`'s compaction/redaction path, because their output is
already bounded and there is no routing value to add:

| command | current behavior | proposed |
|---|---|---|
| `git status [--short\|-s]` | passes through unblocked (already bounded) | no change — stays allowed without routing |
| `git blame <file>` | unclassified today (not in `GIT_ROUTABLE`) | add to `GIT_READONLY_ALLOW` — allowed without routing (bounded per-file output); **not** added to `GIT_ROUTABLE` |
| `git branch [-a\|-v]` | unclassified | add to `GIT_READONLY_ALLOW` — allowed without routing |
| `git tag [-l]` | unclassified | add to `GIT_READONLY_ALLOW` — allowed without routing |
| `git show --stat` | currently routed to `keryx ctx diff`/`ctx run` generically | keep routed via `GIT_ROUTABLE`; special-case `--stat` to the same `ctx diff --stat` formatter used for `diff --stat`, for consistent stat-line parsing |
| `git log --oneline -N` (bounded `-N`) | routed to `keryx ctx run -- git log …` today | move to `GIT_READONLY_ALLOW` — allowed without routing (bounded by `-N`); this also removes it from GDCTX-1's blast radius entirely, since it never enters the merged-stream classifier in the first place |
| `git diff --stat` (bounded summary) | routed via `GIT_ROUTABLE` to `keryx ctx diff --stat` today | add to `GIT_READONLY_ALLOW` — bounded summary output, allowed without routing; plain `git diff` (no `--stat`) stays routed to `keryx ctx diff` via `GIT_ROUTABLE` |

`git status`, `git blame`, `git branch`, `git tag`, bounded
`git log --oneline -N`, and `git diff --stat` are allowed without routing via
this new `GIT_READONLY_ALLOW` set in `hook-classify.ts` (checked alongside the
existing `GIT_ROUTABLE` regex at `hook-classify.ts:70-76`) — they are never
blocked by the ctx hook and never require a `# keryx:raw` escape marker.
`git show --stat` is the one entry that stays in `GIT_ROUTABLE` rather than
moving to the allowlist, since it benefits from the same stat-line formatter
as `diff --stat`. Plain `git diff` (no `--stat`) also stays routed via
`GIT_ROUTABLE` to `keryx ctx diff` — only the bounded `--stat` summary form
moves to the allowlist. None of this bypasses redaction or the routing
recorder for the commands that do stay routed; it only removes routing (and
any possibility of a false block) from the genuinely bounded, read-only
commands.

## Design of fixes

### 1. Stream- and exit-code aware error classification (GDCTX-1)

Current `classifyLine` (`src/ctx/lines.ts:73-82`) receives a flat array of
lines with no provenance — `ctx run`'s caller merges stdout and stderr before
classification (confirmed by the repro: a pure-stdout `printf` line was
promoted to "Errors / Warnings"). Fix shape:

- Tag every line with its source stream (`stdout` | `stderr`) before ranking,
  by classifying stdout and stderr separately rather than concatenating them
  first. `REPO_FAILURE_MARKERS` (`(fail)`, `✗`/`✘`/`✖`/`×`) stay
  stream-agnostic — they are explicit verdict glyphs a tool chose to print
  and are still meaningful on stdout (e.g. `bun test`'s own PASS/FAIL
  lines are stdout).
- `FAILURE_STEMS` (the English-word heuristic) is demoted to
  stderr-only, or gated on the command's own exit code being non-zero. A
  clean-exit command's stdout never gets stem-matched; a non-zero-exit
  command's stdout still does, because in that case a plain-English "cannot
  connect" on stdout is genuine signal.
- `importantLines`/`compactLines`/`rankByVerdict` (`lines.ts:84-191`) take an
  additional per-line `{ stream, exitCode }` context instead of a bare
  string array — a signature change, so every call site in
  `src/commands/ctx.ts` needs updating, not just `lines.ts`.
- Regression fixture: the exact repro (`git log --oneline` with a "refuse"
  commit message, exit 0, zero stderr bytes) becomes a permanent case in the
  correctness benchmark (§Correctness benchmark below), asserting zero
  "Errors / Warnings" lines.

### 2. Trust-aware redaction (GDCTX-2)

`resolveDecision`/`buildFinding` (`src/security/resolve.ts`) need a policy
axis that already has the type (`SecuritySource`) but no branch:

- Add a per-category, per-source override table (alongside the existing
  `policies.egress`/`policies.secrets`/etc. in `SecurityConfig`): for
  category `egress`, policy id `image-url` (or whatever `IMAGE_URL`'s
  `policyId` resolves to in `src/security/detect/exfil.ts:1974`), source
  `trusted-project` downgrades the default action from `redact` to `allow`
  **only when the matched URL is not itself parameterized with a
  credential-shaped query string** (reuse the existing secret/PII detectors
  on the URL's query string as a second gate — a badge URL with no query
  string passes; `?token=...`/`?key=...` still redacts even in a trusted
  file). This keeps the exfiltration defense's actual purpose (an
  attacker-controlled or model-generated URL rendering with a leaked query
  param) while stopping it from firing on static, committed, public badge
  markup.
- The override is data (`SecurityConfig.policies.egress.sourceOverrides` or
  similar), not a hardcoded `if (source === "trusted-project")` in
  `resolve.ts`, so a project can tighten it back (e.g. a private repo that
  wants URLs redacted from its own README too) without a code change.
- `buildFinding` still records the match (`resolve.ts:89-110`) even when the
  action becomes `allow` — the finding is a paper trail of "this URL was
  seen and evaluated," not a silent skip, matching the "no silent
  degradation" convention.
- Regression fixture: this repo's own `README.md` badge block becomes a
  golden ctx-read fixture (§Correctness benchmark) — `keryx ctx read
  README.md` must show the CI/npm/license badge URLs unredacted, while a
  synthetic fixture with a `?token=` query string on an otherwise-identical
  `<img src>` must still redact.

### 3. POSIX flag-bundling expansion (GDCTX-3)

In `buildRgCommand` (`src/commands/ctx.ts:932-1022`), before the per-arg
allowlist check at line ~961: when a token matches `/^-[a-zA-Z]{2,}$/` (a
single dash followed by 2+ letters, no `=`), split it into its constituent
single-letter flags (`-il` → `-i`, `-l`) and only accept the expansion when
**every** resulting flag is in `RG_SAFE_FLAGS` (the boolean-only set,
`ctx.ts:875-901`). A bundle containing any value-flag letter (from
`RG_SAFE_VALUE_FLAGS`, e.g. `-e`/`-g`/`-A`) or any unknown letter is refused
whole, with a message naming which letter broke the bundle — bundling a
value flag is not idiomatic ripgrep usage in the first place (`-e` always
takes a following token), so refusing it whole loses nothing a real ripgrep
invocation would have done differently. This is an additive parser-only
change: the existing per-flag allowlist and the mandatory `--` separator
(`ctx.ts:1019-1021`) are unchanged, so the "fails closed on an unknown
option" guarantee this module's own comments (`ctx.ts:870-872`) describe is
preserved — expansion never adds anything to `flags` that individual-flag
parsing would not have added.

### 4. Freshness self-check — already implemented; close the audit gap

`checkGraphStaleness` (`src/gdgraph/staleness.ts`) already provides
`fresh | stale | unknown` with reasons, wired into at least one
`commands/gdgraph.ts` call path. The remaining work is not building a
freshness check — it exists — but auditing that **every** subcommand which
presents `gdgraph` output as current fact (`affected`, `query`, and any
future W-series consumer) calls `printStaleNote`/`checkGraphStaleness`
before returning, and that CI treats a plain `keryx gdgraph build` run
followed immediately by a query as the fixture-verified fresh case.

### 5. Index hard-gate cost reduction (GDCTX-5)

`docs/requirements/keryx-context-measurement/context-loading.md` already
measured the problem and proposed the shape of the fix; W7 adopts it rather
than re-deriving it:

| option | mechanism | measured/estimated cost at 25 turns (main + 3 subagents) |
|---|---|---|
| current | full `.metaproject/index.md` read on the hard gate, re-billed every turn, once per subagent | ~177,430 tokens (routing-index overhead alone) |
| **slim index** (proposed) | replace the 3,226-token index with a ~300-token pointer table (capability → command, no prose/workflow/examples); the hard gate reads this instead of the current file, not in addition to it | ~16,500 tokens (~11× cheaper for the same routing) |
| **orient, as shipped today** | inject ~2,360 tokens via `UserPromptSubmit` (`src/ctx/orient-runtimes.ts:11`) — fires every prompt, not once per session, and does not replace the index-read instruction | strictly worse than current — adds 2,360 to the existing 3,226 per prompt |
| **orient, fixed** (not yet built) | same content, installed into a once-per-session hook point instead of `UserPromptSubmit`, and replacing rather than duplicating the index-read instruction | would need re-measurement once built; not claimed here |
| **inlined dispatch pointers** (subagent-specific) | parent inlines ~300 tokens of routing pointers directly in the dispatch prompt instead of instructing "read index.md"; escalate to a full index read only for navigation-heavy subagents | ~3,000 tokens per subagent over 10 turns, no read round-trip |

W7 recommends the slim-index replacement as the default fix (smallest change,
largest measured win, no new hook plumbing) and the inlined-dispatch-pointer
pattern for subagent prompts specifically, with escalation to a full read
left as a per-dispatch judgment call as the measurement document itself
proposes. Fixing `orient`'s hook point (`UserPromptSubmit` →
session-start-equivalent) is listed as a follow-on, not blocking, since the
slim index alone captures the largest measured share of the cost.

## Correctness benchmark

Two existing assets anchor this rather than starting from nothing:

- **`fixtures/benchmark/keryx/gdctx-fact-preservation.json`** already exists
  and captures real `keryx ctx run -- <command>` compactions of this repo's
  own tree (dogfood), reduced to facts via `extractFacts`
  (`src/metrics/oracle-runner.ts`), scoring `rawFacts` vs. `compactFacts`
  agreement. This becomes the vehicle for the GDCTX-1/GDCTX-2 regressions:
  add two new `inputs[]` entries — the `git log --oneline` "refuse" repro
  (asserting no fact is misfiled into a spurious error/warning fact) and the
  README badge-block `ctx read` (asserting the badge URL facts survive
  compaction unredacted, and that a synthetic `?token=`-bearing URL fact is
  still redacted).
- **A new golden graph-edge fixture set** (`fixtures/benchmark/keryx/gdgraph-edge-fixtures.json`
  or a small fixture directory under `fixtures/gdgraph/`, mirroring the
  existing `src/gdgraph/*.test.ts` fixture style) pinning:
  - a barrel `index.ts` with `export * from "./a"` and `export { type B }
    from "./b"` → both edges present, second marked type-only (locks in the
    GDGRAPH-2 "verified correct" finding so it cannot silently regress);
  - a dynamic `import("./lazy")` in ordinary application code (not
    `src/gdgraph`'s own bootstrap) → edge present, kind `dynamic-import`;
  - a `tsconfig.json` with `extends` + `paths` in the base file (the
    GDGRAPH-3 suspected gap) → either an edge via the inherited alias (if
    fixed) or a documented `unresolved` with the alias visible in the
    fixture's expected output (if left as a known limitation) — this fixture
    is what turns GDGRAPH-3 from "suspected" into "confirmed, with a
    reproducible case";
  - freshness: build the graph, mutate a tracked file without rebuilding,
    assert `checkGraphStaleness` returns `stale` with a reason naming the
    changed file; delete `.provenance.json` and assert `unknown`, not
    `fresh`.
- **CI wiring**: both fixture sets run as part of the existing `bun test`
  suite (not a separate manual step) — `gdctx-fact-preservation.json` via
  whatever runner already consumes `src/metrics/oracle-runner.ts`'s contract,
  the new gdgraph fixtures as ordinary `*.test.ts` files alongside
  `src/gdgraph/build-lang.test.ts` and friends.
- **Thresholds**: fact-preservation fixtures require 100% fact agreement
  (this is a golden-oracle set, not a statistical benchmark — a regression
  here is a hard fail, not a score drop); the gdgraph edge fixtures assert
  exact edge sets (no fuzzy match) because the whole point is pinning a
  specific, previously-unverified behavior.

## Memory entries to create per defect

Each confirmed live defect gets a `keryx memory new known-mistake --title
"<title>"` entry once the fix lands, so the zero-hits gap an earlier,
unpublished investigation found (`keryx memory search "gdgraph"` / `"gdctx"` → 0 results in this
project's store) stops being true for exactly these:

1. `gdctx-stem-classifier-misreads-stdout` — "A keyword-stem classifier
   applied to raw stdout regardless of exit code turns ordinary English
   ("refuse," "cannot," "crash") into a false tool-failure signal; gate
   stem-matching on stderr or a non-zero exit code, not on the words alone."
2. `gdctx-redaction-ignores-trust-tag` — "A `SecuritySource` tag
   (`trusted-project`) can be threaded all the way to a redaction call and
   still have zero effect on the policy outcome if the resolver only
   branches on `category`; verify a trust axis actually changes a decision
   before shipping the tag, not just that the tag is present in the type."
3. `gdctx-flag-allowlist-no-bundle-expansion` — "A per-flag string allowlist
   that doesn't expand POSIX-bundled short flags rejects the idiomatic form
   of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not
   check-then-reject, for any allowlisted boolean-flag set."
4. `keryx-index-hard-gate-cost-not-measured-before-shipping` — "A mandatory
   context-injection rule's per-read cost multiplies by every subsequent
   turn and every subagent dispatch; measure the re-billed cost across a
   realistic turn count and subagent fan-out before setting a rule's default
   scope, not just its one-time size."

## CLI changes

| command | status today | change |
|---|---|---|
| `keryx ctx run -- <command>` | ships; classification mixes stdout/stderr | classification becomes stream+exit-code aware (GDCTX-1); no flag/argument surface change |
| `keryx ctx read <file> [--mode ...]` | ships; unconditional image-URL redaction | trust-aware redaction (GDCTX-2); no flag/argument surface change, output changes for `trusted-project` sources |
| `keryx ctx rg "<pattern>" [path] [flags]` | ships; rejects bundled short flags | accepts bundled boolean short flags (GDCTX-3); unsafe/value-flag bundles still rejected, with a clearer per-letter reason |
| `git blame`/`git branch`/`git tag`/bounded `git log --oneline -N`/`git diff --stat` | unclassified (passes raw) or previously routed | new `GIT_READONLY_ALLOW` entries allow these without routing, alongside `git status` (Hook friction register); plain `git diff` stays routed via `GIT_ROUTABLE` |
| `keryx gdgraph affected`/`query` | freshness check exists in at least one call path | audit and, where missing, add `printStaleNote`-equivalent call before presenting results as current |
| (no new top-level command) | — | this workstream fixes existing commands' internals; it does not add a new CLI surface |

## Integration

- **Every other workstream (D-8).** W1's stack detection, W2's agent
  compiler, W3's learning observer, W4's bundle inspection, W5's harness
  matrix generation, and W8's audit gate all read code and command output
  through `keryx ctx`/`keryx gdgraph` per the repository's own routing rule.
  A misclassified "error" (GDCTX-1) or a silently-redacted public URL
  (GDCTX-2) in any of those workstreams' own tooling reproduces the same
  false signal downstream — fixing it once here is strictly cheaper than
  each workstream discovering and working around it independently.
- **W6 (keryx shell lifecycle hooks).** The ctx routing guard
  (`src/ctx/hook-classify.ts`) is explicitly named in W6 as one of the
  Keryx built-ins registered as a hook (`PreToolUse` (`Bash`)) so the same
  guard runs inside `keryx` shell sessions, not only in host-harness
  PreToolUse hooks. The hook-friction findings here (escape-marker audit gap,
  `GIT_ROUTABLE` gaps) apply identically once W6 wires this guard into the
  shell's own hook runtime — W7's allowlist expansion should land before W6
  packages this guard as a portable built-in, so W6 does not have to repeat
  the same allowlist audit in a second location.
- **W8 (harness-config security audit).** The trust-aware redaction design
  (§2) reuses `SecurityConfig.policies.egress` — the same policy surface
  W8's `audit-harness` command reads when checking for over-permissive
  configuration. A source-override table added here should be visible to,
  and auditable by, W8's config-checksum/policy-drift detectors rather than
  being a special case invisible to the audit.
- **keryx-context-measurement / keryx-wiki-graph-next / keryx-context-operations.**
  GDCTX-5's slim-index proposal directly implements the fix these documents
  already specify; GDGRAPH-2's benchmarking gap (never A/B'd `gdgraph
  affected` against grep) and GDCTX-6's context-assembly gap remain open,
  informational scope for a future package, not this one.

## Risks

- **Redaction relaxation is a security-relevant change.** Loosening
  image-URL redaction for `trusted-project` content, even gated on
  "no credential-shaped query string," changes a defense that exists for a
  real exfiltration vector (`src/security/detect/exfil.ts` documents five
  measured HTML-image spellings it defends against). The query-string gate
  must be implemented and fixture-tested before this ships, not treated as
  an afterthought — a wrong implementation here trades a cosmetic false
  positive for a real false negative.
- **Stream-aware classification changes existing golden output.** Any
  existing fixture or downstream tooling that depends on today's
  merged-stream classification behavior (even if that behavior is the bug)
  needs re-verification — `git log --oneline` output that currently gets
  flagged and is currently being manually filtered by some caller could
  behave differently once the fix lands.
- **Flag-bundling expansion widens the parser's surface, which is exactly
  what `buildRgCommand`'s design comment (`ctx.ts:870-872`) says to be
  conservative about.** The expand-then-check design in §3 is built to add
  zero new reachable flags (only re-derive individually-already-allowed
  ones), but the implementation must be tested against every value-flag
  letter explicitly to avoid a bundling ambiguity (e.g. `-mA` — is `m`
  `--max-count`'s short form, or a bundle-then-value token?) silently
  admitting a value flag through the boolean path.
- **GDGRAPH-3 is unconfirmed.** Committing to a fix before a reproducible
  fixture exists risks solving an imagined problem in a codebase (this one)
  that has no `tsconfig extends` at all — the fixture-first approach in
  §Correctness benchmark exists specifically to avoid that.
- **The index-cost fix is a rule/prose change, not a code change**, which
  means it is easy to under-invest relative to the code-level GDCTX-1..3
  fixes despite being the highest measured token cost — sequencing risk if
  Wave 0 treats "correctness" as only the three code defects.

## Acceptance criteria

- **W7-AC1**: `keryx ctx run -- <command>` with exit code 0 and zero stderr
  bytes never places a stdout line matching only `FAILURE_STEMS` (no
  `REPO_FAILURE_MARKERS` glyph, no non-zero exit) into "Errors / Warnings" —
  verified by the `git log --oneline` "refuse" fixture in the correctness
  benchmark.
- **W7-AC2**: `keryx ctx read <file>` on a `trusted-project`-sourced file
  leaves an `<img src="...">`/markdown-image URL with no credential-shaped
  query string unredacted, while an otherwise-identical URL carrying a
  `?token=`/`?key=`/`?auth=`-shaped query string is still redacted —
  verified by the README-badge and synthetic-token fixtures.
- **W7-AC3**: `keryx ctx rg` accepts any bundled short-flag token composed
  entirely of letters present in `RG_SAFE_FLAGS`, producing the identical
  ripgrep argv as the equivalent split-flag invocation; a bundle containing
  any value-flag or unknown letter is rejected whole with a reason naming
  the offending letter.
- **W7-AC4**: `keryx gdgraph build` followed by `keryx gdgraph affected`/
  `query` on an unmodified tree reports no staleness note; mutating a
  tracked source file without rebuilding causes the next `affected`/`query`
  call to print `STALE_NOTE` with a reason naming the changed file (or
  `UNKNOWN_NOTE` if git itself cannot be queried) rather than silently
  presenting stale results as current.
- **W7-AC5**: The gdgraph golden-edge fixture set passes with exact edge-set
  equality (not fuzzy match) for: a barrel `export *` file, a type-only
  `export { type X } from` re-export, and a runtime `import()` dynamic
  import — pinning the GDGRAPH-2 "verified correct" finding against silent
  regression.
- **W7-AC6**: `fixtures/benchmark/keryx/gdctx-fact-preservation.json` scores
  100% fact-preservation agreement on every fixture, including the two new
  GDCTX-1/GDCTX-2 regression inputs, and runs in CI as part of `bun test`
  (not a manual-only script).
- **W7-AC7**: A `keryx memory search "gdgraph"` or `"gdctx"` after this
  workstream lands returns at least the four `known-mistake` entries listed
  under Memory entries — closing the zero-hits gap an earlier, unpublished
  investigation found.
- **W7-AC8**: `.metaproject/index.md`'s hard-gate content is reduced to a
  pointer-only table under a stated token budget (target: ≤400 tokens,
  matching the ~300-token proposal plus headroom), and the gate instruction
  is updated to read this file in place of, not in addition to, its current
  form (tracks PRD R7.8; see GDCTX-5).
- **W7-AC9**: `git status`, `git blame`, `git branch`, `git tag`, bounded
  `git log --oneline -N`, and `git diff --stat` are never blocked by the ctx
  hook and never require `# keryx:raw` — classified by a new
  `GIT_READONLY_ALLOW` set checked before `GIT_ROUTABLE`, so they pass
  through exactly as `git status` already does today rather than being
  routed or left unclassified. Plain `git diff` (no `--stat`) stays routed
  to `keryx ctx diff` via `GIT_ROUTABLE`, unaffected by this AC.

## Open questions

- Does every `gdgraph` query subcommand (not just the one confirmed call
  site in `commands/gdgraph.ts`) invoke the staleness check before
  presenting results? This needs a full subcommand audit, not assumed from
  one confirmed path — left open for the implementation pass rather than
  claimed here without checking every call site.
- Is GDGRAPH-3 (`tsconfig extends`) worth fixing at all before a real
  consumer repository is known to hit it, or should it stay a documented
  limitation with a fixture proving the current (non-)behavior? The
  correctness-benchmark fixture answers "what happens today" either way;
  the acceptance bar for *fixing* it is left open pending that fixture's
  result.
- Should the trust-aware redaction override (§2) be scoped narrowly to the
  `egress`/image-URL policy only, or does the same "source tag exists in
  the type but never gates a decision" pattern need auditing across every
  other `SecurityCategory` (`secret`, `pii`, `prompt-injection`,
  `artifact-safety`) before this workstream is called complete? This
  document scopes the fix to the one confirmed live defect; a broader audit
  of `resolve.ts`'s source-blindness is a natural W8 audit-gate input, not
  duplicated here.
- Does the escape-marker audit gap (hook friction register, item 1) need a
  W7 fix, or is it correctly W6's concern once the same guard becomes a
  portable hook runtime? This document flags it under W7 evidence because it
  was found auditing `ctx`'s own hook classifier, but the actual logging
  mechanism (where an escape reason gets recorded, and who reviews it)
  belongs to W6's hook-composition design, not a `ctx`-internal change.
