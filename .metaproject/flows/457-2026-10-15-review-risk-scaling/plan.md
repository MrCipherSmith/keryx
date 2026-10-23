# Implementation Plan

Status: approved by owner 2026-10-16 (fix all, re-audit across harnesses, eval on 3-4
keryx PRs, release by morning; merge permission granted)

## Workstreams (A, B, C in parallel, isolated worktrees; then D, E)

### A. Radius by symbol, omissions with reasons (T5)
- `src/gdgraph/symbol-reach.ts`: seeds = changed exported symbols (declaration lines AND
  body edits: hunk ranges ∩ symbol spans; `export {a,b}` lists); per reverse edge re-parse
  the importer's import clause (Bun.Transpiler / regex), keep only importers of a changed
  name, `*` or default; barrels (`export *`, `export {x} from`) pass through without a
  hop; hub damping weight Π 1/log2(2+fanIn) with cutoff; fallback to the file edge when
  parsing fails or the change is not an export / is a side effect.
- `src/review/text-links.ts`: string-key/event/CSS-class/config-key consumers via
  fixed-argv `rg -F`, hub keys (> N hits) dropped with a reason.
- Drop reasons `unrelated-symbol`, `hub-damped`, `text-hub` with `detail`; chunks plan only
  `reason:"cap"`; coverage treats reasoned drops as `omitted`; readiness item 2 counts only
  cap drops.
- Bugs: real sizes for chunk halves; changed files from `base...pinnedHead` (not the
  working tree) and layers base from the PR base, never `HEAD~1` silently.

### B. Slices routed by content, depth by risk, operator gate on cost (T6)
- `SliceEntry` gains optional `roles`, `depth`, `risk{score,why}`, `audit`.
- `src/review/slice-routing.ts`: roles per slice from content/path facts
  (`computeHunkRiskFacts` classes, existing path gates, content regexes); `review-logic`
  always; every slice ≥ 1 role. Depth: deep (full core set) when a deterministic risk
  class hits, the slice's symbol reach is high, or optional Jev risk ≥ 0.7; light = the
  content role(s). Audit: deterministic 10-15% of light slices (hash of head+slice id)
  run deep, marked `audit`.
- `requiredSlices` honours `slice.roles`; escalation: a ≥ major finding from a light slice
  re-opens it deep via retry-plan; ledger records audit catch rate.
- `estimate` returns `overThreshold` (config, default 40 dispatches or 90 min) and the
  plan summary; dispatch-check/ledger refuse an over-threshold plan without a recorded
  plan confirmation (`<package>/plan-confirmation.json`, contract shared with C).
- NaN: `waveBytesOf` never NaN; a manifest without sizes is refused with a message.

### C. Harness robustness (T7)
- Per-package results: `<package>/raw/` and `<package>/drivers/` everywhere (verdict,
  retry-plan, ledger, skill), shared dir only as an explicit `--raw`.
- Wave bytes recorded per host in the manifest (keryx shell 5-min deadline vs hosts
  without it).
- Autonomous: prompt passes `--scope`/`--package`, one round unless the head moved, one
  wave-size constant shared with the skill; trigger reviews route to
  `review run --autonomous`.
- Attended derived from mode/flag, not only the autonomous env; `chunks estimate --mode
  automatic` and `publish --yes` gated like attended decisions.
- Cards + TTY gates for mutation waiver, reviewer-set override, `comments reply --final`
  (flow-456 framework), and `review_confirm_plan` writing plan-confirmation.json.
- Item 10: `review start` records a caller token; outside keryx shell item 10 says "not
  observable on this host" instead of a silent PASS.
- Verification commands run by the parent: `keryx review verify-run` (or equivalent) that
  runs a verifier/testing command in a sandbox-free parent context and saves output for
  `context_files`; child-output cut → always parse the saved raw file.
- Global skill drift: warn when an installed host copy of review skills is older than the
  bundled version.

### D. Skill text (T8, after A-C)
Host table (spawn tool, plan tool, question tool, results persistence) for keryx shell /
Claude Code / Codex / others; persistence + ledger rules for every host; Codex preflight
delegates to `review run --autonomous`; planning steps (symbol radius, routing, depth,
estimate card); verifier commands via parent; `review_wave`/`timeout_ms`; fix every stale
line from the audit. Both copies, ≤ 1615 lines.

### E. Evaluation (T9-T10)
- `keryx review plan-eval`: offline, model-free: old vs new plan on a diff + canonical
  findings (review-418/419/427 data and the eval PRs) — does each ground-truth finding
  land in a slice assigned to its reviewer (or a deep slice); dispatches, chunks, minutes.
- Live: new-plan review rounds with subagents on keryx #424, #939 (truth: #988), #940
  (truth: review-418 canonical), #1005 (truth: rounds 1-3), scored with
  `review compare-reference`; report in `eval/` in this flow package.

### F. Ship (T11-T13): review round, PR, merge on green, release 0.3.119, owner check.

## Risks
- Symbol reach misses implicit consumers → text-links + fallback to file edges + deep
  audit sample; measured in E.
- Parallel worktrees conflict in src/commands/review.ts → each lane owns named regions;
  merge in order A, B, C and re-run tests.
- Eval cost → cap live runs at ~4 PRs, light slices one role.
