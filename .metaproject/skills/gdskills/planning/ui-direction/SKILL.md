---
name: ui-direction
description: |
  Use when a new product, landing page or redesign needs a distinctive visual concept before
  any UI code is written, or when existing UI looks generic or AI-made and you need to make the UI
  unique (визуальный концепт, не нейрослоп). Writes DESIGN.md:
  subject facts, three directions, an idea sentence, palette with computed contrast, type,
  ASCII wireframes, motion stance, one signature element, and a not-doing list.
  NOT for: implementing the components (ui-craft) or reviewing existing UI (review-ui-ux).
triggers:
  - "design direction"
  - "visual concept"
  - "make the ui unique"
  - "не нейрослоп"
  - "визуальный концепт"
  - "/ui-direction"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  origin: "authored"
  category: "planning"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# UI Direction — concept before code

Without direction a model draws the average website. This skill replaces "modern and clean"
with a concept derived from the subject, written down so every later page and every later run
reuses it. Read `rules/core/ui-anti-slop.mdc` first — it is the shared tell catalog and the
thresholds this skill must respect.

---

## Workflow

```
ui-direction Progress:
- [ ] Step 1: Establish the brief (subject, audience, primary job, surface type)
- [ ] Step 2: Read what already exists (brand, DESIGN.md, tokens, real content)
- [ ] Step 3: Mine 8–12 subject facts
- [ ] Step 4: Deal three directions
- [ ] Step 5: Pick one; write the idea sentence; competitor + swap test
- [ ] Step 6: Plan palette, type, layout (ASCII), motion, signature, imagery
- [ ] Step 7: Generic-default self-check; revise and log what changed
- [ ] Step 8: Write DESIGN.md and report
```

---

## Step 1 — Brief

Establish, from the request and the repo:

| Field | Example |
|---|---|
| Subject | an independent bike-repair shop in Lisbon |
| Audience | commuters with a broken bike today |
| Primary job / one required action | book a repair slot |
| Surface type | `marketing` (page that persuades) or `app` (screen that is used: dashboard, admin, editor, inbox, settings) |
| Constraints | existing brand, framework, component library, dark mode, locales |

Ask only when a missing field blocks the concept; otherwise state one concrete assumption and
continue. If the brief names a specific look, follow it exactly and skip Step 4.

## Step 2 — Read what exists

- Existing `DESIGN.md`, theme/tokens files, Tailwind config, logo, brand guide, screenshots.
- Real content: product names, prices, copy, data shapes. Real content beats placeholders in
  every later step.
- An established design system is a constraint, not a reason to be bland: the direction then
  lives in composition, content, imagery, and the signature element.

## Step 3 — Mine the subject (8–12 facts)

Raw material for the concept: the name and what it means, the place, the trade's tools and
materials, its numbers, rituals, printed artefacts (receipts, tickets, labels, manuals, maps),
its vocabulary, what the audience is anxious about. Write them as a list in `DESIGN.md`.

## Step 4 — Three directions

Sketch three different directions in 3–4 lines each, each grounded in different facts from
Step 3. Concrete references only ("workshop repair tag + chalkboard price list",
"1970s transit signage") — never adjectives like "modern", "clean", "bold", "premium".
At least one direction must be uncomfortable for you; the comfortable one is the average.

## Step 5 — Choose and test

Pick one; give the reason in terms of the subject and audience. Then write the idea sentence:

> On this page, **[the subject's thing]** becomes **[the direction's device]**.

- **Competitor test** — would the nearest real competitor fit the same sentence equally well?
  If yes, the idea is too generic; go back to Step 4.
- **Swap test** — could a competitor put its logo on the result unnoticed? Same verdict.

## Step 6 — Plan

| Dimension | What to decide | Hard limits (from ui-anti-slop) |
|---|---|---|
| Palette | 4–6 named colors with roles: ground, ink, accent, + support/status. Hex + role + where used | Accent on primary action + ≤1 other. Body pairs ≥4.5:1, UI pairs ≥3:1 — compute and list the ratios |
| Type | 1–2 families with roles, scale ratio, body size/leading/measure | No default-only Inter/Roboto/system; marketing display ≥3× body; app ≤3 visible sizes |
| Layout | Grid, alignment axis, section/screen list with one sentence each, ASCII wireframes at desktop and phone | Neighbor sections differ in structure; no stock page order |
| Shape | Radius scale by role, separation method (tone vs border vs shadow) | Shadows only on floating layers |
| Motion | The one orchestrated moment (or none) + interaction feedback | 100–400ms, reduced-motion variant |
| Signature | Exactly ONE memorable element, tied to the idea sentence | One. Not two. |
| Imagery | Order: project's own → generated → open-licensed real → drawn in code → type & color only | No stock blobs, floating people, fake dashboards |
| Copy voice | 3 rules for the voice + outcome-labeled primary CTA | No filler verbs, no invented proof |

For `app` surfaces: color is for data and status, panels stay quiet, density matches the
task, and every screen lists its empty / loading / error / sparse / dense states.

## Step 7 — Generic-default self-check

Re-read the plan as a stranger. For each dimension ask: *is this what a model would produce for
any similar page?* Score the plan against the tell catalog in `ui-anti-slop.mdc`. Any T1 tell,
or slop score ≥4, means revise. Log every revision as `changed X → Y because Z`.
Then remove one element from the plan.

## Step 8 — Output

Write `DESIGN.md` at the project root (or the path the user names; update in place if it exists):

```markdown
# Design Direction — <product>

## Brief
## Subject facts
## Directions considered   (3, with why the other two lost)
## Idea sentence
## Palette                 (name | hex | role | contrast pairs)
## Typography              (family | role | scale | body size/leading/measure)
## Layout                  (grid, alignment, ASCII wireframes desktop + phone)
## Shape & elevation
## Motion
## Signature element
## Imagery
## Voice & copy rules
## Not doing               (explicit tells banned for this project)
## Exemptions              (tells deliberately chosen, with reason)
## Revision log
```

Report to the user: idea sentence, the three directions in one line each, why this one, the
signature element, and the path to `DESIGN.md`. Offer `ui-craft` as the next step.

---

## Exit criteria

Done only when `DESIGN.md` exists with every section filled, the idea sentence passed the
competitor and swap tests, the plan has no T1 tell and a slop score ≤3 (or recorded
exemptions), every listed contrast pair meets its threshold, and the revision log names what
the self-check changed.

---

## Iron Laws

| Rule | Why |
|---|---|
| No code in this skill | Code before direction is how the average gets built |
| Every choice cites a subject fact or the brief | Unanchored choices are the model's prior |
| Exactly one signature element | Two signatures compete; none is memorable |
| Contrast ratios are computed, not assumed | Distinctive and unreadable is still a failure |
| Interaction stays conventional | Distinctive look, familiar behavior (Jakob's Law) |
| Do not repeat the previous project's direction | Re-convergence on your own favorites is slop too |

## Red Flags

| Thought | Reality |
|---|---|
| "Clean and modern will be fine" | That sentence is the average website |
| "Let's use a dark theme with one neon accent to stand out" | Second-wave slop; justify it from the subject or drop it |
| "I'll add a gradient for depth" | Depth comes from tone steps and layering, not washes |
| "The user didn't give content, so lorem ipsum" | Write plausible, clearly-marked sample content from subject facts |
| "Three directions is overkill" | The first idea is the most probable one |
