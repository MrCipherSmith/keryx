# Acceptance Criteria — 346 External switch

- AC1: With user-level `external: "off"`, `callJevSystemOne` throws a typed `ExternalBlockedError`
before any `fetch`/network call, verified by a hermetic unit test with no network and no
`OPENROUTER_API_KEY`.

- AC2: Every existing Jev caller (edit guard, review-jev-*, conform, ci-triage, jev-select, the
routing classifier, the turn guard) treats `ExternalBlockedError` as a clean "skipped: blocked by
/external" outcome — no unhandled rejection, no raw stack trace surfaced to the user.

- AC3: The single provider/model routing-selection choke point excludes providers/models on the
external list when external is off; a test proves a listed model id is absent from the resolved
candidates while a non-listed one remains.

- AC4: A `.metaproject/tasks.config.json` project-level `external` value overrides the user-level
setting; a test proves the project value wins in both directions (user on/project off and user
off/project on).

- AC5: `<keryx config dir>/external-providers.json` is created with documented defaults when
missing; a malformed file falls back to defaults with a logged warning, not a crash; `keryx
external list` prints the effective list and shows whether it is default or user-edited.

- AC6: With external "on" and a resolvable Jev credential (via `resolveJevApiKey` without a
project dir), `review.jev.ci_triage` / `.select` / `.edit_guard` resolve to `true` by default
through one shared resolver; risk/contract/rules/scenarios/docs/comments remain off; an explicit
project `tasks.config.json` value always wins over the default. `keryx review jev-profile show`
displays the effective value and its source (explicit / default-because-jev-available /
off-by-external).

- AC7: The one-time consent notice ("Jev is on here: redacted code/CI snippets go to OpenRouter/TypeSafe. Turn off: /external off") is shown once per project, on CLI stderr, the first time ci_triage/select/edit_guard actually runs because of the default (not an explicit opt-in) — wired into the CLI gates (`keryx review ci-triage`, `keryx review jev-select`, the edit-guard PostToolUse hook). A recorded per-project flag (`<config dir>/external-notice.json`, keyed like `routing-config-trust.json`) suppresses a repeat; a test proves the second run stays silent. (Scope note: the TUI's own /ci modal reuses the same core reader and therefore the same default-on decision, but does not yet print this specific line to the transcript — it already shows the sidebar "external: on/off" indicator; wiring the transcript line there is a reasonable follow-up.)
send (TUI transcript/sidebar line + CLI stderr line), and a recorded per-project flag suppresses
it afterwards; a test proves the second run stays silent.

- AC8: `keryx external on|off [--project]`, `keryx external status [--json]`, and `keryx external list` exist and are covered; the TUI has a `/external` slash command (bare prints state/source/effective-list summary + what is blocked right now; `on`/`off` toggles and persists) wired into `AGENT_SLASH_COMMANDS`/`HELP_GROUPS`, `commands-by-task` is regenerated, and a sidebar indicator shows external state. (Scope note: a bare status print, not a new OpenTUI modal component, given the size of the rest of this flow — a modal is a reasonable follow-up.)
list` exist and are covered; the TUI has a `/external` slash command (on/off/no-arg modal) wired
into `AGENT_SLASH_COMMANDS`/`HELP_GROUPS`, `commands-by-task` is regenerated, and a sidebar
indicator shows external state.

- AC9: `bun test` for the new/changed suites is green with `OPENROUTER_API_KEY` unset (proving
hermeticity), `keryx test related` passes for touched files, and `src/core-package.test.ts` +
`src/lib/import-policy.live.test.ts` stay green.

- AC10: Typecheck and lint are clean on the touched files/package.

- AC11: README, docs site, `docs/jev-in-review.md`, and `CHANGELOG.md` under `## [Unreleased]`
document the switch, the default list with reasons, and the Jev default-on behavior.

- AC12: PR opened from `feat/external-switch` against `main`, CI green (flaky "Set up Bun" runner
failures may be rerun once), not merged.
