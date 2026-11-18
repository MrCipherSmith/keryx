---
name: review-ui-ux
model_tier: standard
description: |
  Use when reviewing UI changes or a live page for UX quality and AI-slop (проверь юзабилити
  и доступность интерфейса): usability heuristics, system states, forms, visual hierarchy,
  WCAG 2.2 AA floor, craft thresholds, and the generic AI-generated look. Works on a diff and
  on a rendered URL or screenshots. Dispatched by review-orchestrator for --ui-ux, --all, or
  user-facing markup and stylesheet changes.
  NOT for: React/MobX structure (review-frontend), naming (review-style), re-render cost
  (review-performance), measured pixel geometry and RTL (review-layout), class conventions
  (review-frontend-conventions), or designing a new UI (ui-direction, ui-craft).
triggers:
  - "ux review"
  - "ui/ux review"
  - "проверь юзабилити"
  - "ai slop check"
metadata:
  author: "MrCipherSmith"
  version: "1.3.0"
  origin: "authored"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review — UI/UX & Anti-Slop

Reviewer for what the user sees and does. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs.

Read-only, three passes, cheapest and most objective first: deterministic checks → usability heuristics → aesthetic judgment.
Never edits code; fixes are proposed, not applied.

## Rules This Lens Reads

Read both in `.metaproject/rules/core/` first. Conditions they rate are rated by their **Review severities** tables; this lens states none of them again and keeps only its method and calibration.

| Condition | Rule |
|---|---|
| Tell catalog and tiers, **Applies to** (marketing vs app screens), craft thresholds, slop score, exemptions, invented proof, focus, contrast, states, the WCAG floor | `ui-anti-slop.mdc` |
| Overflow, clipping and sideways scroll at a width, the 320px floor, locale and RTL geometry | `layout-rendering.mdc`, rated by `review-layout`: report none of it here |

## Input Contract

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `branch` | string | no | Branch to review. Defaults to current branch. |
| `commit_range` | string | no | Explicit range. Overrides merge-base detection. |
| `url` | string | no | A running page the payload supplies for live mode (preview, staging); this reviewer never starts one. |
| `screenshots` | string[] | no | Image paths when no URL is available. |
| `primary_task` | string | no | The one job the screen must enable. Inferred and stated if absent. |
| `context_doc` | string | no | Path to job context document. |

## Scope Detection

- **Code mode** — see `.metaproject/skills/gdskills/shared/git-merge-base.md` for `BASE_SHA`; review UI files changed
  in scope (`*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.css`, `*.scss`, `*.html`, theme/token
  files, Tailwind config). Flag only what the diff introduced or touched.
- **Live mode** — only a `url` or `screenshots` the payload supplies; never start a dev server or
  any other process. Render a supplied URL at **1440**, **768**, **390** px; light and dark when supported.
- **Both** — preferred whenever the payload supplies a render. Code shows intent; the render
  shows truth (computed contrast, actual fonts, real target sizes).
- **No render supplied** — finish the code-mode review (`DONE` / `DONE_WITH_CONCERNS`), list the live checks under
  "Checks not run" and state the gap in the summary (a URL or screenshots of which screens would close it).

If there is neither a diff with UI files nor a supplied render, return `NEEDS_CONTEXT`.

Before Pass 1, read the job context and `DESIGN.md` if present, then state the product, audience,
primary task and surface type (marketing/content or app screen, per **Applies to** in the rule).

## Pass 1 — Deterministic checks

Objective, measurable, run first. The signals and thresholds are the rule's; this table is
where each is read in each mode, and each finding cites the measured value and the threshold.

| Check | Code mode | Live mode |
|---|---|---|
| Focus | `outline: none` / `outline-0` without `:focus-visible` | Tab through: ring visible, not hidden by sticky bars |
| Contrast | Token pairs computed from the theme | Computed colors on the render |
| Color-only meaning, targets | Status by class color only; icon buttons with tiny padding | Grayscale read; measured target box |
| Reduced motion | No `prefers-reduced-motion` branch; `transition: all` | Emulate reduced motion: content stays, travel stops |
| Zoom | `user-scalable=no`, `maximum-scale=1` | Pinch-zoom on the render |
| Names & semantics | Icon-only buttons without accessible name; `div` with `onClick`; heading skips | Accessibility tree |
| Forms | Placeholder-as-label, missing `type`/`autocomplete`, pre-disabled submit, paste blocked | Submit empty: first error focused, message next to field |
| Fonts, palette, surfaces, copy | Theme fonts, palette classes, radius/shadow classes, visible strings | Computed font-family, the render, visible text |

## Pass 2 — Usability

Against the stated primary task:

- **Nielsen's 10 heuristics** — status visibility, real-world language, control & undo,
  consistency & standards, error prevention, recognition over recall, accelerators, minimalism,
  error recovery, help. Cite the heuristic number.
- **States** — every interactive element: hover, focus-visible, active, disabled, loading.
  Every data view: loading (timing per the rule), empty (specific reason + action, never
  "No results" while loading), error (near source, cause + remedy, input kept), sparse, dense.
- **Forms** — labels, inline errors, no redundant entry (3.3.7), password managers allowed (3.3.8).
- **Laws of UX** — Fitts (primary large and near, destructive not beside it), Hick (fewer
  choices, recommended marked), Jakob, proximity/common region (grouping matches meaning).
- **Destructive & async** — confirm or Undo; optimistic updates roll back; double-submit guarded.

## Pass 3 — Hierarchy and distinctiveness

- **Squint test** — blur the render; the intended focal element still dominates; contrast
  treatments within the rule's cap and ≤2 large elements per view.
- **Five-second test** — first screen says what this is and what to do.
- **DESIGN.md conformance** — palette roles, type scale, signature element present and single,
  "not doing" list respected. Drift from DESIGN.md is a finding.
- **Swap / competitor test** — could a competitor's logo go on this unnoticed?
- **Slop score** — count tells by tier with the rule's formula on the surfaces **Applies to**
  names, list them, honor exemptions. Score ≥9 → recommend `ui-direction`, not patching.
- **Restraint** — name the one element that should be removed.

## Output Contract

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — no blocker/major findings
- `DONE_WITH_CONCERNS` — one or more blocker/major findings
- `NEEDS_CONTEXT` — no UI in scope and nothing renderable, or primary task unknowable
- `BLOCKED` — cannot access diff or render; state reason

Standalone runs also print a markdown report: Verdict; Context (product, audience, primary
task, surface type, mode); Scores (slop score with T1/T2/T3 counts and band, WCAG 2.2 AA floor
pass/fail, viewports checked or "not run"); Top 3 changes; findings by severity; What works
(keep); Checks not run.

## Iron Laws

### This reviewer's own

| Rule | Why |
|---|---|
| Read-only | Critique and fixing are separate jobs; mixing them hides findings |
| Measure on the render when possible | Class names are intent; pixels are truth. A contrast, size or visual claim without a measurement (computed value, screenshot region, exact token pair) is `info` |
| One tell is not slop; the stack is | Inter for body text alone is fine; five defaults together are not |
| Distinctive look, conventional behavior | Never penalize a standard interaction pattern as "generic" |
| `DESIGN.md`, the brief or the job context wins | A deliberate choice is not a tell (shared law 4) |
| Never claim checks that weren't run | List them under "Checks not run" |

### Shared laws (every reviewer)

Read `.metaproject/rules/activity/review.mdc` before the diff. It holds what every reviewer applies and this file does not restate: scope (the change, not pre-existing debt), the four shared laws, `info`, one finding per defect across lenses, and where severity comes from.

Severity levels are defined once, in `review-orchestrator/SKILL.md` →
**Severity (canonical)**. This reviewer keeps no rubric of its own: its conditions are
rated by the **Review severities** table in `ui-anti-slop.mdc`.

## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible
with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a
concise markdown summary. Prefix finding ids `UX-`. Return `NEEDS_CONTEXT` instead of guessing
when the primary task or the renderable surface is unknown and needed.

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` carries `class_scope`: **every** screen or component with the
same defect, and **how you enumerated them** — the search you ran, or the shared component
whose call sites derive the set.

```yaml
class_scope:
  sites: ["src/app/orders/OrdersTable.tsx:42", "src/app/users/UsersTable.tsx:57"]
  enumeration_method: "grep for `<DataTable` without an `emptyState` prop; 5 tables, 2 lack it"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list is
a claim that the class has exactly one member — make it deliberately.

```markdown
### [UX-NNN] Title

- **Severity**: blocker | major | minor | info
- **Criterion**: WCAG 2.5.8 | Nielsen #1 | State: empty | Slop T1: gradient text | DESIGN.md: palette
- **File**: path/to/Component.tsx (quote the code; the line is derived at ingest) | screenshot @390px, header region
- **Evidence**: measured value vs threshold (e.g. 3.1:1 vs 4.5:1; 18×18px vs 24×24px)
- **Impact**: what the user experiences
- **Fix**: concrete change (token, component, copy, state)
```

## Scope Boundaries

In scope: usability, states, forms, hierarchy, the a11y floor, slop. Elsewhere: React/MobX
structure (`review-frontend`), class/token conventions (`review-frontend-conventions`), naming
(`review-style`), re-render cost and bundle size (`review-performance`), pixel geometry — sizing,
collapse, overflow, reflow at a width, RTL, locale length (`review-layout`), logic bugs behind the
UI (`review-logic`), creating a direction or rebuilding the UI (`ui-direction`, `ui-craft`).

## Job Context Awareness

When dispatched with `JOB_NAME` / `CONTEXT_PATH`, read the context document before scope
detection for the primary task, audience and agreed design decisions; an agreed decision is an
exemption like one in `DESIGN.md`.

## Red Flags

| Rationalization | Reality |
|---|---|
| "It looks fine to me" | State the measurement or cap at `info` |
| "Generic is safe for an admin panel" | App screens skip the marketing rows (**Applies to**); missing states and broken focus still count |
| "Accessibility is a separate review" | The WCAG 2.2 AA floor is in scope here |
| "No browser, so I'll assume the contrast passes" | Compute from tokens or list it under "Checks not run" |
| "Every card has the same style — that's consistency" | Consistency of tokens, yes; one radius + shadow on everything is the card kit |

## Verification

Report done only once all of these hold:

- Every finding names its criterion and carries evidence: a measured value against its
  threshold, a screenshot region at a named viewport, or an exact token pair. An unmeasured
  visual observation is filed as `info`, marked unverified, and says what would settle it.
- Every finding names the `file` of the component that renders it and `quote`s the code it is
  about; `line` is derived at ingest from that quote, never counted.
- Every `blocker` and `major` carries `class_scope` with `sites` and an
  `enumeration_method` naming the search that derived the set.
- No finding invents a severity: each comes from the `ui-anti-slop.mdc` table, under
  **Severity (canonical)** in `review-orchestrator/SKILL.md`; overflow went to `review-layout`.
- Slop score lists its tells by tier and the exemptions it honored, with where each was read.
- "Checks not run" names every skipped check and why.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, with
  finding ids prefixed `UX-`, or `NEEDS_CONTEXT` naming what was missing.
