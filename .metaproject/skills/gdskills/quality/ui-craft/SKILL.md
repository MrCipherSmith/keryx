---
name: ui-craft
description: |
  Use when you implement the design, restyle, or сверстай a page, screen or component set and the result must look
  designed rather than AI-generated: tokens first, real content, every state, purposeful
  motion, WCAG 2.2 AA, verified in a real browser. Builds from DESIGN.md (run ui-direction
  first when none exists) and adapts to the project's styling system.
  NOT for: choosing the visual concept (ui-direction), reviewing a diff (review-ui-ux),
  React/MobX architecture (review-frontend), or measured layout regressions (review-layout).
triggers:
  - "build ui"
  - "build this page"
  - "сверстай"
  - "restyle"
  - "implement the design"
  - "/ui-craft"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  origin: "authored"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# UI Craft — build it designed, then look at it

Implementation skill. The concept lives in `DESIGN.md`; the guard rails live in
`rules/core/ui-anti-slop.mdc`. This skill turns both into code and refuses to call it done
until it has looked at real renders.

---

## Workflow

```
ui-craft Progress:
- [ ] Step 0: Gate — DESIGN.md exists (else run ui-direction or derive a minimal one)
- [ ] Step 1: Read the stack and existing tokens/components
- [ ] Step 2: Tokens first
- [ ] Step 3: First screen at desktop + phone
- [ ] Step 4: Remaining sections/screens with varied structure
- [ ] Step 5: States, forms, interaction
- [ ] Step 6: Motion and accessibility pass
- [ ] Step 7: Browser verification loop (≤3 rounds)
- [ ] Step 8: Pre-delivery checklist and honest report
```

---

## Step 0 — Gate

- `DESIGN.md` present → read it fully; it overrides personal taste and this skill's defaults.
- Absent and the task is a new surface or a redesign → stop and offer `ui-direction`.
- Absent and the task is a small addition to an existing UI → derive a 10-line direction from
  the existing tokens and screens, write it to `DESIGN.md`, and state that you did.

## Step 1 — Read the stack

Find the styling system (Tailwind config, CSS variables, CSS modules, styled-components,
AntD/MUI/shadcn theme), the component library, and two or three existing screens. Adapt the
rules below to that stack — never introduce a second styling system. If the project has
convention docs (`CLAUDE.md`, `STYLING.md`, `THEMING.md`), they win over this skill.

## Step 2 — Tokens first

Before any component, define or extend semantic tokens:

- **Color** — the DESIGN.md palette as semantic roles (`--color-ground`, `--color-ink`,
  `--color-accent`, `--color-muted`, `--color-danger` …), light and dark tuned separately.
  No raw hex in components.
- **Type** — families, the modular scale (≤5 sizes), weights at the extremes, body
  16–20px / 1.45–1.6, display tracking −0.02 to −0.05em.
- **Space** — one scale (4/8/12/16/24/32/48/64/96/128). No one-off pixel values.
- **Radius** — a scale by role; nested radius concentric (child ≤ parent).
- **Elevation** — shadow tokens for floating layers only (menus, popovers, dialogs).
- **Motion** — durations (fast ~100ms, base ~200ms, slow ~300ms) and easings
  (ease-out enter, ease-in exit).

With a component library: override its theme tokens instead of fighting each component.
Library defaults left untouched are a tell.

## Step 3 — First screen first

Build the first screen at desktop and 390px before anything else. It must answer the visitor's
first question in large type, carry the signature element from DESIGN.md, and offer one primary
action with an outcome label. Check it in the browser (Step 7 method) before continuing —
direction mistakes are cheapest here.

## Step 4 — The rest

- Each section is a claim with its proof; delete sections without a claim.
- Neighbor sections use different structures. Structure follows content: tables for tabular
  data, lists for lists, one large proof instead of three small cards.
- `app` surfaces: quiet panels, aligned figures, `tabular-nums`, color reserved for data and
  status, navigation that folds away on phones.
- Real copy from the brief. Missing content → clearly-marked sample content, listed in the
  report. Never invent stats, logos, testimonials, or customers.

## Step 5 — States, forms, interaction

Every interactive element: default, hover (only where clickable), `:focus-visible`, active,
disabled, loading. Every data view: loading, empty, error, sparse, dense.

- Loading: indicator after ~150–300ms; spinner for 2–10s; percent-done + cancel for ≥10s;
  skeletons with final dimensions.
- Empty: specific reason + direct action. Never "No results" while still loading.
- Errors: next to the source, plain language, what happened + how to fix, input preserved.
- Forms: visible label on every field (placeholder is never the label), correct `type` /
  `inputmode` / `autocomplete`, paste allowed, submit enabled until submission starts, focus
  the first error, inputs ≥16px on mobile.
- Destructive actions: confirm or an Undo window. Optimistic updates roll back on failure.
- Behavior stays conventional: `<a>` navigates, `<button>` acts, Enter submits, Esc closes.

## Step 6 — Motion and accessibility

- Motion: animate `transform`/`opacity` only, never `transition: all`; 100–400ms; one
  orchestrated moment at most; every animation has a `prefers-reduced-motion` variant that keeps
  content and drops travel; nothing loops for >5s without a pause control.
- WCAG 2.2 AA floor: text ≥4.5:1, large text and UI boundaries ≥3:1, color never the only
  signal, focus ring visible and not obscured by sticky bars (`scroll-padding`), targets
  ≥24px (≥44px on touch), drag has a click alternative, reflow at 320px, zoom never disabled,
  icon-only buttons have accessible names, `aria-live="polite"` for toasts/inline validation,
  heading order and a skip link.

## Step 7 — Browser verification loop

Open the result in a real browser (built-in browser / Playwright / preview server):

1. Screenshot at **1440**, **768**, **390** px, light and dark if supported.
2. Look at the screenshots, not at the code. Squint test: the intended focal element still
   dominates when blurred. Five-second test: what is this and what do I do?
3. Score against the tell catalog in `ui-anti-slop.mdc`; measure contrast and target sizes on
   the render, not from class names.
4. Fix the top 3 problems. Repeat — at most 3 rounds; then report what remains.

No browser available → say so explicitly and list the checks that were not run.

## Step 8 — Pre-delivery checklist and report

- [ ] Tokens only; no raw hex or one-off spacing in components
- [ ] DESIGN.md signature element present; exactly one
- [ ] No T1 tells; slop score ≤3 (or exemptions recorded in DESIGN.md)
- [ ] All states implemented for every interactive element and data view
- [ ] WCAG 2.2 AA floor met on the render
- [ ] Reduced-motion variant for every animation
- [ ] Verified at 1440 / 768 / 390 (or stated as not run)
- [ ] Before finishing: removed one element

Report: what was built, screenshots or their paths, slop score with remaining tells, sample
content to replace, checks not run. Offer `review-ui-ux` for an independent pass.

---

## Iron Laws

| Rule | Why |
|---|---|
| DESIGN.md wins over taste | The concept was chosen deliberately; drifting back is re-convergence |
| Never "done" without looking at renders | Slop is invisible in code and obvious on screen |
| Never invent proof | Fake numbers and logos destroy trust and are a T1 tell |
| One styling system | Mixed systems drift into inconsistent tokens |
| Don't claim unrun checks | An honest gap is fixable; a false pass ships |

## Red Flags

| Thought | Reality |
|---|---|
| "I'll add states later" | Later never comes; missing states are behavioral slop |
| "`rounded-2xl shadow-lg` looks nice everywhere" | One radius + one shadow everywhere is the SaaS card kit |
| "A gradient will make the hero pop" | It makes it look like every other generated hero |
| "The library default button is fine" | Untouched library defaults are a tell |
| "Looks right in the code" | Open the browser |
