# Module src/docs

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/docs` holds four `bun:test` suites that pin the user-facing Markdown docs to the code they describe. Each suite reads a guide, the CLI reference or the README and fails when a named command, default, label or string drifts from the code.

## Overview

`src/docs` owns the checks that keep the documentation under `docs/` and `README.md` honest against the code. It ships no runtime code: every file is a test that reads a doc from disk and asserts that the features it describes still exist with the names, defaults and strings the code defines. It covers the own-answer path in the recommendation journal, the work-intake guide, the Telegram remote-commands guide, and the frozen part 1 research materials.

## How it works

The module has no layers of its own. Each suite follows the same pattern. It resolves the repository root from `import.meta.dir`, reads a doc with `readFileSync`, and carves out one section by heading (an `indexOf` slice, or the `section` helper in the own-answer suite). It then asserts with `toContain` and `toMatch` on the slice.

Where a value already exists as code, the suite imports it instead of copying it. `OWN_ANSWER_BUTTON_LABEL` comes from `src/remote/protocol`, `COMMAND_DESCRIPTORS` from `src/standard/command-registry`, `findCliEntry` and `findSlashEntry` from `src/standard/help-groups`, `DEFAULT_INTAKE_CONFIG` from `src/intake/config`, `REMOTE_COMMANDS` and `REMOTE_REFUSED` from `src/remote/command-gateway`, and `EXPORT_FIELDS` from `src/decisions/export`. Where a value exists only as source text, the suite reads the source file and matches it. The intake suite regex-parses the `SUBCOMMANDS` array in `src/commands/intake.ts`, and the own-answer suite checks that the reply strings in `src/remote/http-surface.ts` match the ones the guide quotes. The part 1 suite is the exception: it pins `protocol-part2.md` by SHA-256 digest, so any edit to that file fails on purpose.

Each suite is tied to a numbered flow and acceptance criterion in its header comment (flow 401 AC12, flow 403 AC22, flow 387 AC15, flows 402 and 404). These tests are the mechanism that stops a docs edit or a code rename from going unnoticed.

## Key concepts

- **Doc contract**: an assertion that a doc states a fact the code defines, such as a default value, a button label, a command name or a route. A failing contract means the doc or the code has to change.
- **Own answer**: the path where a person types their own reply to an agent question instead of choosing an offered option. In the Telegram flow it is a button, and the dock row is labelled "Свой ответ…" (opened with **Tab** for a reason). Stored text is capped at 2000 characters with a `[truncated: N more characters]` marker, is redacted, and goes to `journal.md` and the report. A typed own answer never approves anything; approvals are button-only.
- **Work intake**: `keryx intake`, which polls GitHub read-only and posts cards for issues, review requests, CI failures, comments and board items, each with buttons such as Take in work, Dismiss, Later and Ignore. It stays off until opted in through `.metaproject/data/intake/config.json`. The defaults are checked against the guide's settings table, including `enabled`, `repos`, `cardsPerHour`, `buttonTtlHours`, `laterHours`, `budgetUsd`, quiet hours and `allowTakeInWork`.
- **Remote commands**: the slash commands the Telegram gateway allows (`REMOTE_COMMANDS`) and refuses (`REMOTE_REFUSED`). A few commands stay deliberately local, namely `/mcp`, `/guard`, `/route` and `/editguard`. Commands that change mode, plan, delegation or external work need a Yes/No confirmation.
- **Part 1 materials**: the frozen directory `docs/research/role-blurring-part1`. It holds exactly eight pinned files, and the decisions export carries only allow-listed keys with no free-text field. Three files that `keryx research sync` writes are excluded from the check.

## Main flows

1. **Own-answer docs** (`own-answer-docs.test.ts`). The suite takes the "Your own answer and a typed reason" section of `docs/docs/guides/recommendation-journal.md` and requires the dock row text, **Tab**, and `OWN_ANSWER_BUTTON_LABEL`. It also requires the 2000-character rule, `journal.md`, and `--json`. The Telegram paragraph in `drive-keryx-remotely.md` must quote the exact strings that `src/remote/http-surface.ts` sends, namely `Own answer (user <id>, <time>).` and "That question is no longer open, so your reply was not used." The `/help` text is checked through `findCliEntry("decisions")`.
2. **Intake docs** (`intake-docs.test.ts`). The suite reads `docs/docs/guides/work-intake.md` and, for each scalar key of `DEFAULT_INTAKE_CONFIG`, builds a regex and matches it against a row of the settings table. It parses the `SUBCOMMANDS` array in `src/commands/intake.ts` and requires each `keryx intake <sub>` to appear in the `## intake` section of the CLI reference. The read-only guarantee check looks for the four GitHub event tool names the guide lists.
3. **Remote-command docs** (`remote-commands-docs.test.ts`). Every name in `REMOTE_COMMANDS` and every key of `REMOTE_REFUSED` must appear in the "Commands from the topic" section of the Telegram guide. The `/remote-control` entry in the CLI reference and the README's remote section must link the `#commands-from-the-topic` anchor.
4. **Part 1 materials** (`part1-materials.test.ts`). The suite lists `docs/research/role-blurring-part1`, drops the three sync-written files, and requires the remaining names to equal the eight pinned files. It checks the SHA-256 of `protocol-part2.md` against the version 2 digest. It then requires the keys of each export row to equal `EXPORT_FIELDS`, which the suite pins to a fixed list, and it rejects forbidden keys such as `question`, `answer` and `reason`. Finally it searches every file in the directory for a fixed list of excluded terms.

---

<!-- keryx:reference:begin v=1 hash=c0c91e4049a10c5fde6b831266bd7f7f64373457e6337bad0cfc1b23e0ffd2e5 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `src/docs/own-answer-docs.test.ts` - imported by 0, imports 3
- `src/docs/intake-docs.test.ts` - imported by 0, imports 1
- `src/docs/part1-materials.test.ts` - imported by 0, imports 1
- `src/docs/remote-commands-docs.test.ts` - imported by 0, imports 1

### Dependency basis

- Production imports only: 6 import(s) from test file(s) (e.g. `src/docs/intake-docs.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 4
- Cross-module imports: 0
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)


## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
