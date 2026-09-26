# External switch: keep private work in-house

Status: in-progress
Source: user description

## Problem

keryx already talks to Jev/TypeSafe System One over OpenRouter, and to a range of OpenRouter
model vendors, for review and routing tasks. Some of that code (diffs, CI logs, rule text,
prompts) is private, and some OpenRouter-hosted vendors/tiers are not trustworthy with it
(free-tier logging, jurisdictions/terms that allow retention or training, or an operator-named
vendor such as "muse"). Today there is no single switch to stop keryx from sending this data to
those destinations, and the recommended Jev steps (ci_triage, select, edit_guard) require a
per-project opt-in even when a Jev credential is available, so the safer default is not applied
automatically.

## Expected Outcome

- A general `/external on|off` switch (user-level default "on", optional per-project override)
  that, when off, blocks every Jev call and excludes listed providers/models from routing and
  model selection — before any network I/O, failing open/clean for existing callers.
- The external-provider list lives in an editable, versioned JSON file with built-in defaults,
  is inspectable (`keryx external list`), and is enforced from one place per concern (Jev choke
  point in jev-client.ts; a single provider/model exclusion point in routing/selection).
- When external is "on" and a Jev credential resolves, `review.jev.ci_triage`, `.select`, and
  `.edit_guard` default to true through one shared resolver that every reader goes through;
  an explicit project value always wins. `jev-profile show` reports the effective value and its
  source.
- A one-time-per-project consent notice is shown (TUI transcript/sidebar + CLI stderr) the first
  time a step actually sends data because of the new default, and is recorded so it does not
  repeat.
- CLI (`keryx external on|off|status|list`) and TUI (`/external` slash command + modal + sidebar
  indicator) surfaces exist and are documented (README, docs site, CHANGELOG).
- Hermetic tests cover the block path, routing exclusion, project override, malformed-JSON
  fallback, Jev default-on resolution, and the one-time notice, with `OPENROUTER_API_KEY` unset.

## Out of Scope

- Reworking Jev's own transport/auth beyond adding the pre-flight external check.
- New UI framework work in the TUI beyond the slash command, modal, and sidebar indicator.
- Any change to which paid US providers (Anthropic/OpenAI/Google/Copilot/xAI/Groq) are offered —
  they stay off the default external list.
