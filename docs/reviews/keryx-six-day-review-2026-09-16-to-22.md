# Six-day review: 2026-09-16 .. 2026-09-22 (0.2.122 -> 0.2.153)

STATUS: DONE_WITH_CONCERNS
Verdict: REQUEST_CHANGES (5 major, 2 minor, 4 info)

## Scope

- Range: merge-base `0f4ea0a6` .. HEAD `25f3c346` - 219 commits, 823 files, +107964 / -3028.
- Mode: diff (scope A). Scope pack: 779 of 825 files retained; the pre-filter dropped 46 files,
  2 blocks and 3 changed lines.
- Reviewer set: `review-logic` + `review-highload`, run sequentially in-session.
- Scope B (blast radius) was NOT computed, and Wave C ran for none of the findings.

The prescribed parallel reviewer fan-out could not run: `spawn_subagent` returned an empty result
twice in this session, so both waves were replaced by sequential reading. That, and not the size
of the range, is why the residual at the end of this document is unreviewed.

## Gates (all green at HEAD)

| Gate | Result |
|---|---|
| `eslint .` | clean |
| `tsc --noEmit` | clean |
| `bun test src/bus src/session src/review` | 1017 pass, 0 fail |
| `bun test src/gdskills` | 576 pass, 0 fail |
| `bun run check:doc-links` | 1505 relative links across 480 files, 0 broken |
| `bun run check:retired-spellings` | 2485 files scanned, 63 retired spellings, 0 undeclared |

`keryx health status` reports a snapshot dated 2026-09-08, older than this window, so it is not
used as evidence here.

## Stage counts

dropped by pre-filter: 46 files, 2 blocks, 3 changed lines. Verification mode: `annotate`.
Verdicts: confirmed 6, refuted 0, unverifiable 0, unverified 5. Retained: 11.

## Findings

Every major below was reproduced by executing the real code, except `WATCH-01`, whose mechanism
is documented by the repository itself but was not executed (no standalone binary was built).

### SEARCH-01 (major) - a refused search is reported as "no results"

`src/harness/search/registry.ts`. The DuckDuckGo descriptor's `search()` decides refusal from two
signals only - the anomaly markers in the body and HTTP 202 - and never reads `response.ok` or
`response.error`. `SandboxedWebTransport.request` signals every non-response outcome as
`{ ok: false, status: 0, text: "", error: "policy-denied" | "transport-failed" | "cancelled" }`,
and against that triple `duckduckgoSearchResponse` parses an empty body into a successful
zero-result set, which the loop then returns; a marker-less non-2xx page takes the same path.

Impact: a sandbox egress denial (a security decision), an operator cancellation, a transport
failure and a marker-less provider error page are all indistinguishable from "the query had no
matches" - to the agent and to the operator, who is then told to rephrase or re-select a
provider. The same descriptor's `testConnection` does reject non-2xx, so one object literal
disagrees with itself about what a non-2xx means.

Evidence (executed): against the real `duckduckgoSearchResponse` / `isDuckDuckGoAnomaly`, a
marker-less body at status 403, 429 and 503, and the denial triple (status 0, empty text), all
yield `anomaly=false, parsed.ok=true, results=0`; the probe printed "SUCCESS, results=0" for
policy-denied, cancelled and transport-failed.

Fix: check `response.ok` (or `response.error`) before parsing in `search()`, mapping
policy-denied / cancelled / transport-failed to their own reasons.

### PLAN-01 (major) - a wrongly-shaped plan.json crashes two different consumers

`src/session/execution-plan.ts`. `readPlanFile`'s shape guard checks only that `items` is an
array, while its own docstring promises a "malformed or wrongly-shaped file is ALSO undefined
rather than a throw". Nothing about an item's shape is validated, while the write-side
`validateItems` does guarantee it, so every consumer inherits an assumption it cannot check. Two
consumers crash on two different corruptions of the same file: `renderExecutionPlanSnapshot` (the
agent turn) on a missing or null `title`, and `formatPlanRow` (the sidebar's session-plan modal)
on an unknown `status`. `planCounts` additionally gains a garbage key, contradicting its own
"every status present, never a partial record" contract.

Impact: the agent path throws from `src/commands/agent.ts:2093`, OUTSIDE the try/catch that
guards the plan read at :2087-2093, so every round of the turn dies instead of the plan being
ignored; the UI path makes the plan modal unopenable. A fix that guards only the title would
relocate the crash rather than remove it.

Evidence (executed): `getExecutionPlan` returned `{"revision":1,"items":[{}]}` and
`renderExecutionPlanSnapshot` threw `TypeError: undefined is not an object (evaluating
'item.title.length')`; `formatPlanRow` on an unknown status threw the same error evaluating
`PLAN_STATUS_LABEL[item.status].padEnd`.

Fix: validate item shape at the READ so the read guard is at least as strong as `validateItems`,
and let an invalid file degrade to `undefined`. One fix covers both sites.

### PROV-01 (major) - provenance is silently not stamped when git cannot answer

`src/sync/provenance.ts`. `recordProvenance` stamps a revision through `gitHead`, the discarding
wrapper that returns `null` for a spawn error AND a non-zero exit alike, so "a repository is
present and git could not answer" collapses into the same silent no-op as "there is no git here".
The file already carries the discriminating primitive for exactly this caller - `resolveGitHead`,
including the outcome documented as NEVER reportable as "no git" - and its own AFC-22 docstring
forbids the flattening.

Impact: in a repository whose HEAD cannot resolve, `keryx gdgraph build` prints its success line
while no `.provenance.json` is written and nothing says so; a later read returns null, the sync
diff has no basis, and the wiki freshness baseline can never be recorded - the flow-280/281
symptom class, with the operator given no diagnostic.

Evidence (executed) in a temp repo whose `.git/HEAD` points at a missing ref: `resolveGitHead`
returned a `failed` resolution while `recordProvenance` wrote nothing and `readProvenance`
returned null.

### BUS-01 (major) - the git-publish floor misses routes its own contract names

`src/lib/command-risk.ts`. `isPublishCommand`'s `PUBLISH_RULES` enumerate five publishing shapes:
`git push`, `gh release`, `gh pr merge`, `npm publish`, `bun publish`. `git tag`, a local
`git merge` and `pnpm`/`yarn publish` are not matched, so the git-publish pause-lease floor does
not apply to them. The module docstring justifies the incompleteness with a posture borrowed from
the destructive classifier - a miss only widens a prompt - which is inverted for this consumer:
here a miss IS the absence of any prompt.

Impact: under permission mode `auto` (and `trust`, since a lone `git tag` is not destructive) a
peer holding a git-publish lease is not prompted, and a release tag or local merge can be created
inside another agent's release window - while the agent-facing contract text promises "must not
push/tag/merge/publish".

Evidence (executed): the real module reports CAUGHT for `git push origin main`, `gh pr merge 431`
and `npm publish`, and MISSED for `git tag -a v0.2.154 -m release`, `git merge main`,
`pnpm publish` and `yarn publish`.

Fix: extend `PUBLISH_RULES` with the missing segments, or derive the rule set from the contract
sentence in `src/commands/agent.ts` so the two cannot drift.

### WATCH-01 (major) - the debug watcher never starts in a standalone binary

`src/tui/debug-watcher.ts`. `spawnDebugWatcher` builds its self-spawn argv from
`process.argv[1]`, assuming that token is this CLI's entry script. The repository already owns the
correct resolution for exactly this question: `keryxSelfCommand` in
`src/harness/tool/builtin/metaproject-tools.ts` documents three shapes of "this keryx" and
returns `[execPath]` - no script argument - for the standalone-compiled-binary case, because
there `Bun.main` lives in bun's embedded filesystem and the executable IS keryx, leaving
`process.argv[1]` as the first USER argument.

Impact: in a standalone binary, `keryx shell --debug` spawns an argv with a duplicated `shell`
token; the watcher dies immediately and, being detached with `stdio: "ignore"`, reports nothing.
The operator believes `--debug` is collecting the kernel-side diagnostics the feature exists for
while no `watcher.ndjson` is ever written.

Evidence: the code, plus `keryxSelfCommand`'s documented three shapes. NOT executed - no
standalone binary was built in this session, so this is the one major without a reproduction.

### BUS-02 (minor) - rate-limit counting parses megabytes inside the append lock

`src/bus/log.ts`. `countRecent` reads the current events segment and the newest rotated segment
in full and JSON-parses every line, and it is invoked from `appendEvent`'s `underLock` hook -
that is, while the clone-wide `append.lock` is held. Every send therefore parses up to two
