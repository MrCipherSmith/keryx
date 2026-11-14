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
  version: "1.1.0"
  origin: "authored"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review — UI/UX & Anti-Slop

Reviewer for what the user sees and does. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs.

Read-only, three passes, cheapest and most objective first: deterministic checks → usability heuristics → aesthetic judgment. The tell catalog,
tiers, thresholds, and slop score come from `rules/core/ui-anti-slop.mdc` — read it first.
Never edits code; fixes are proposed, not applied.

---

## Workflow

```
review-ui-ux Progress:
- [ ] Step 1: Read Job Context and DESIGN.md (if present)
- [ ] Step 2: Determine mode (code | live | both) and scope
- [ ] Step 3: Restate context: product, audience, primary task, surface type
- [ ] Step 4: Pass 1 — deterministic checks (code + render)
- [ ] Step 5: Pass 2 — usability heuristics, states, forms
- [ ] Step 6: Pass 3 — hierarchy, distinctiveness, slop score
- [ ] Step 7: Rate severity, attach evidence, write fixes
- [ ] Step 8: Emit report; list checks not run
```

---

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
- **No render supplied** — review the markup and styles statically (code mode), list the live checks
  under "Checks not run", and return `NEEDS_CONTEXT` naming what they need (a URL or screenshots of which screens).

If neither a diff with UI files nor a supplied render exists, return `NEEDS_CONTEXT`.

---

## Pass 1 — Deterministic checks

Objective, measurable, run first. Each finding cites the measured value and the threshold.

| Check | Code mode signal | Live mode measurement |
|---|---|---|
| Focus | `outline: none` / `outline-0` without `:focus-visible` | Tab through: ring visible, ≥3:1, not hidden by sticky bars (WCAG 2.4.7, 2.4.11) |
| Contrast | Token pairs computed from theme | Computed colors: text ≥4.5:1, large/UI ≥3:1 (1.4.3, 1.4.11) |
| Color-only meaning | Status by class color only | Errors/status readable in grayscale (1.4.1) |
| Targets | Icon buttons with tiny padding | ≥24×24px; ≥44px on touch (2.5.8) |
| Reduced motion | Animations with no `prefers-reduced-motion` branch; `transition: all` | Emulate reduced motion: content stays, travel stops |
| Reflow & zoom | `user-scalable=no`, fixed-height text boxes | 320px width: no 2-D scroll (1.4.10) |
| Names & semantics | Icon-only buttons without accessible name; `div` with `onClick`; heading skips | Accessibility tree check |
| Forms | Placeholder-as-label, missing `type`/`autocomplete`, pre-disabled submit, paste blocked | Submit empty: first error focused, message next to field |
| Fonts | Only Inter/Roboto/Arial/system in theme | Computed font-family on headings and body |
| Palette tells | `from-purple-* to-blue-*`, `bg-clip-text`, untouched `indigo-500`/`emerald-500` | Visible on render |
| Uniform surfaces | Same radius + shadow class on most containers; cards in cards | Visual scan |
| Copy tells | Filler verbs, emoji in headings, Jane Doe / Acme, lorem, invented round stats | Visible text |

## Pass 2 — Usability

Against the stated primary task:

- **Nielsen's 10 heuristics** — status visibility, real-world language, control & undo,
  consistency & standards, error prevention, recognition over recall, accelerators, minimalism,
  error recovery, help. Cite the heuristic number.
- **States** — every interactive element: hover, focus-visible, active, disabled, loading.
  Every data view: loading (indicator after ~150–300ms; percent-done + cancel ≥10s), empty
  (specific reason + action, never "No results" while loading), error (near source, cause +
  remedy, input kept), sparse, dense.
- **Forms** — labels, inline errors, no redundant entry (3.3.7), password managers allowed (3.3.8).
- **Laws of UX** — Fitts (primary actions large and near; destructive not adjacent to primary),
  Hick (choices reduced, recommended option marked), Jakob (behavior conventional even when the
  look is not), proximity/common region (grouping matches meaning).
- **Destructive & async** — confirm or Undo; optimistic updates roll back; double-submit guarded.

## Pass 3 — Hierarchy and distinctiveness

- **Squint test** — blur the render; the intended focal element still dominates. ≤3 contrast
  treatments and ≤2 large elements per view.
- **Five-second test** — first screen says what this is and what to do.
- **DESIGN.md conformance** — palette roles, type scale, signature element present and single,
  "not doing" list respected. Drift from DESIGN.md is a finding.
- **Swap / competitor test** — could a competitor's logo go on this unnoticed?
- **Slop score** — count tells by tier per `ui-anti-slop.mdc` (`T1×3 + T2×2 + T3×1`), list them,
  honor recorded exemptions. Score ≥9 → recommend `ui-direction`, not patching.
- **Restraint** — name the one element that should be removed.

---

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

---

## Iron Laws

### This reviewer's own

| Rule | Why |
|---|---|
| Read-only | Critique and fixing are separate jobs; mixing them hides findings |
| Measure on the render when possible | Class names are intent; pixels are truth. A contrast, size or visual claim without a measurement (computed value, screenshot region, exact token pair) is `info` |
| One tell is not slop; the stack is | Inter for body text alone is fine; five defaults together are not |
| Distinctive look, conventional behavior | Never penalize a standard interaction pattern as "generic" |
| DESIGN.md and recorded exemptions win | A deliberate choice is not a tell (shared law 4) |
| Never claim checks that weren't run | List them under "Checks not run" |

### Shared laws (every reviewer)


1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot name the input, call, or condition that reaches the code, you have an observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code under review. Do not report a safe API because it could be misused, or a pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears at several sites, report it once and list every site. Ten findings that are one finding hide the other nine problems.
4. **A deliberate choice is not a defect until its reason is read and shown wrong.** An explicit override, suppression or exemption, a comment or commit giving a reason, or a sibling doing the same is a decision: read its reason (the comment, `git log -L` or `git blame`, the sibling) before you report it, and report it only when you can show that reason wrong. A project rule is checked against accepted platform practice and its known exceptions before a deviation from it is reported.

Severity levels are defined once, in `review-orchestrator/SKILL.md` →
**Severity (canonical)**. This reviewer keeps no rubric of its own; below is only
where its recurring conditions land under that one.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| Invented proof shipped as fact: fake stats, logos, testimonials, customers | `major` | Named trigger (the rendered page), named outcome (users read false claims) |
| Primary task unreachable by keyboard, or focus invisible on the primary flow | `major` | Named trigger (Tab through the flow), named outcome (the task cannot be finished) |
| Text contrast below 4.5:1 (3:1 large) on primary content, measured | `major` | Named trigger and outcome (the text is unreadable for low-vision users) |
| Missing loading / empty / error state on a primary view; destructive action without confirm or Undo | `major` | Named trigger (that state), named outcome (blank, stuck or irreversible screen) |
| T1 slop tell, or slop score ≥9 | `minor` | The UI works; the cost is identity and trust, not behavior |
| T2 tells, hierarchy competition, inconsistent tokens, generic CTA labels | `minor` | Behaves correctly; aesthetic or clarity cost |
| T3 tells, polish, or any visual claim you could not measure | `info` | Shared law 1 |

---

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

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---|---|---|
| Usability, states, forms, hierarchy, a11y floor, slop | YES | — |
| React/MobX structure, component boundaries | NO | `review-frontend` |
| Repository class/token conventions | NO | `review-frontend-conventions` |
| Naming, readability | NO | `review-style` |
| Re-render cost, bundle size | NO | `review-performance` |
| Pixel geometry: sizing, collapse, overflow, RTL, locale length | NO | `review-layout` |
| Logic bugs behind the UI | NO | `review-logic` |
| Creating a direction or rebuilding the UI | NO | `ui-direction`, `ui-craft` |

## Job Context Awareness

When dispatched with `JOB_NAME` / `CONTEXT_PATH`, read the context document before scope
detection. Use it for the primary task, audience, and any agreed design decisions; treat agreed
decisions like DESIGN.md exemptions.

## Red Flags

| Rationalization | Reality |
|---|---|
| "It looks fine to me" | State the measurement or cap at `info` |
| "Generic is safe for an admin panel" | Quiet is fine; untouched defaults and missing states are not |
| "Accessibility is a separate review" | The WCAG 2.2 AA floor is in scope here |
| "No browser, so I'll assume the contrast passes" | Compute from tokens or list it under "Checks not run" |
| "Every card has the same style — that's consistency" | Consistency of tokens, yes; one radius + shadow on everything is the card kit |

---

## Verification

Report done only once all of these hold:

- Every finding names its criterion and carries evidence: a measured value against its
  threshold, a screenshot region at a named viewport, or an exact token pair. An unmeasured
  visual observation is filed as `info`, marked unverified, and says what would settle it.
- Every finding names the `file` of the component that renders it and `quote`s the code it is
  about; `line` is derived at ingest from that quote, never counted.
- Every `blocker` and `major` carries `class_scope` with `sites` and an
  `enumeration_method` naming the search that derived the set.
- No finding invents a severity: each lands under **Severity (canonical)** in
  `review-orchestrator/SKILL.md`.
- Slop score lists its tells by tier and the DESIGN.md exemptions it honored.
- "Checks not run" names every skipped check and why.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, with
  finding ids prefixed `UX-`, or `NEEDS_CONTEXT` naming what was missing.
