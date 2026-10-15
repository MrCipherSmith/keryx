# Overlay reviewer import: filter non-reviewers, skills remove, rule collisions, path gate, dispatch by package, help and manifest path

Status: formalized
Source: user description (defect report from a session that imported an external overlay skill tree into a Keryx project on 0.3.39, re-verified against this repository's source on 2026-09-30)

## Problem

Importing an external tree of reviewer skills into a project and wiring them into
`review-orchestrator` goes wrong in nine places. A team following the bundled
`reviewer-skill-creator` doc registers non-reviewers as reviewers, cannot undo it,
gets reviewers that read a different rule than the one they cite, and cannot see any
of this from the CLI.

1. `keryx skills import --from <tree> --module review` imports every package that does
   not collide with a bundled name. `keryx review import` filters by a hardcoded
   `review-acme-` prefix. The doc calls the second an alias of the first. A package
   with `deprecated: true` is imported like any other.
2. There is no command that removes a project skill (directory, registry entry, catalog
   row, verification report).
3. A cited rule that already exists under `.metaproject/rules/` is reported `present`
   without comparing content, so an overlay reviewer silently reads Keryx's generic rule
   of the same filename. References that are not `` `dir/name.mdc` `` (absolute or `~`
   rule paths, `skills/...` `.md` / `.json` files) are never reported as unresolved.
4. `metadata.paths` exists, but `metadata.flags` does not; a literal file path in a
   description is not a path trigger; import does not warn when a reviewer ends up with
   `pathsSource: none` (dispatched on every round).
5. The orchestrator text says a flag-selected project reviewer is never path-gated, so a
   flag shared by a family of reviewers dispatches all of them on any diff.
6. "Agent Runtime Compatibility" dispatches a same-named agent type without reading the
   registered project package, which may differ from it.
7. Bundled `review-frontend` forbids `store.onMount()` in `useEffect` in two places and
   calls the same bridge correct in a third; `rules/core/mobx-store-template.mdc` agrees
   with the first two.
8. From the published package `bundledManifestPath()` resolves outside the package, so
   `keryx skills install --profile full --dry-run` fails with ENOENT although the
   manifest ships. `--help` on `review` / `skills` subcommands is intercepted in
   `cli-registry.ts` and prints a generic slice, so the real per-subcommand help is dead
   code. `review-orchestrator` names skills that the `recommended` profile does not
   install (`review-pr-feedback`, the legacy profile reviewers) without saying so.
9. The doc has no worked import example and describes `review-learning.config.json`
   only in prose.

## Expected Outcome

A tree import into module `review` registers only what the operator selected, says what
it will do before doing it, and warns about reviewers with no path gate. A project skill
can be removed with one command. A rule-name collision is reported as `differs` and the
project's version has a home `keryx update` does not overwrite. Family flags stay
path-gated. A project reviewer is always dispatched with its registered package path.
The bundled frontend reviewer and the store rule say one thing about the lifecycle
bridge. The manifest installer and subcommand help work from the published layout. The
doc carries an end-to-end example that matches the fixed behaviour.

## Outcome criteria

- Re-running the original scenario (overlay tree with reviewers, a deprecated alias, a
  non-reviewer and a bundled-name collision) registers only the selected reviewers and
  `keryx review reviewers` shows no reviewer with `paths: none` that was not warned
  about at import time.

## Out of Scope

- Changing which skills the `minimal` / `recommended` / `full` profiles contain.
- Any change to the consumer overlay itself or to its `keryx-reviewer-setup` script.
- Fetching rules for remote (URL) imports.
- Behaviour changes beyond the nine items and the scope extension below; a claim that
  does not reproduce on this branch is reported with evidence, not "fixed".

## Scope extension (user decision, 2026-09-30)

Four things found while verifying the nine items were pulled into this flow by the user
instead of a follow-up flow:

- the overlay-specific routing trigger in `reviewer-skill-creator` becomes neutral (AC15);
- the import reports when the security gate rewrote content and does not write content
  the gate's prompt-injection detection flags (AC16);
- `skills install --with/--without` with an id that changes nothing is an error, and the
  dry-run hint reproduces the plan-shaping flags (AC17);
- `skills update` has its own output and carries the import's warnings; `review --help`
  and `review comments --help` agree on `comments reply` (AC18).
