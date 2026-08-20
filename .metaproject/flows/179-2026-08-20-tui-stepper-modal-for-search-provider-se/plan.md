# Implementation Plan

Status: formalized

## Approach

Considered:
- **A (chosen): mirror the existing LLM-provider wizard pattern.** New
  self-contained wizard function (e.g. `searchProviderWizardInTui`) built from
  the same OpenTUI primitives already used by `pickProviderStep` /
  `promptBaseUrlStep` / `promptApiKeyStep` (`overlayBox`, `SelectRenderable`,
  `InputRenderable`, `onKeypress`-driven Esc-to-go-back). Wired only into the
  bare-arg branch of `/search-provider` in `tui-shell.ts:3623-3657`; the
  args-given branch and `/search-connect` are untouched. Lowest blast radius,
  reuses proven UX conventions already in the file.
- **B (rejected): single flat form (all fields + credential in one screen).**
  Faster to build but doesn't match what the user asked for (an explicit
  3-step stepper) and doesn't scale to providers with more fields later.
- **C (rejected): generic reusable form-modal shared with the LLM wizard.**
  Correct long-term direction but a much larger refactor/blast-radius than
  this flow needs; tracked as a future follow-up, not done here.

## Steps

1. **Step 1 — provider select.** Reuse the `pickProviderStep` shape: a
   `SelectRenderable` listing `controller.configurable()` (id + displayName +
   kind badge local/remote). Esc → cancel the whole wizard, no state mutated.
2. **Step 2 — fields, credential, active toggle.**
   - Loop `descriptor.fields` (`SearchFieldDescriptor[]`) as sequential
     `InputRenderable` prompts seeded with `defaultValue`, generalizing
     `promptBaseUrlStep`'s single-input/Esc-back shape to N fields (Esc on
     field i → back to field i-1; Esc on field 0 → back to step 1). A
     provider with 0 fields (the 3 remote providers) skips straight past this
     sub-step.
   - If the provider has a credential schema, follow with a
     `promptApiKeyStep`-style prompt (key / skip / back).
   - Add a 2-option `SelectRenderable` ("Set as active after a successful
     test?" Yes/No) — reuses the existing select widget, no new checkbox
     component needed.
3. **Step 3 — test connection.** Call `controller.configure(id, fields,
   credential)` then `controller.test(id)`, showing a "Testing…" state while
   awaiting. On success: render pass, and if step 2's toggle was Yes, also
   call `controller.select(id)` (the exact call `/search-connect` already
   makes) and confirm both. On failure: show the failure reason and let Esc
   go back to step 2 to retry — do not dead-end/close the modal on failure.

## Risks

- Field count varies per provider (searxng = 2, remote providers = 0) — the
  loop must correctly handle N=0 without regressing the 3 remote providers.
- `controller.test()` can hang on an unreachable network (observed live this
  session against a MITM-intercepted network) — the underlying sandboxed
  worker already enforces a 10s timeout, but the modal's "Testing…" state
  must not appear permanently stuck; keep Esc/cancel affordance visible.
- No existing unit-test precedent for these overlay wizards — `pickProviderStep`
  / `promptBaseUrlStep` aren't unit tested directly today. T3 needs to find or
  establish a testable seam (e.g. isolate step-sequencing/validation logic
  from OpenTUI rendering) rather than skip test coverage for the new code.
