# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: In a project where `keryx shell` offers its read-only project tools (graph, wiki, memory, flow status, skills, repomap, test_related, health status and `search_code`), an ACP session offers the same set, decided by the same `offersIndexTools` gate and built from the same tool definitions — not a hand-maintained copy. In a project where the shell would not offer them, neither does ACP; `search_code` follows the shell's exception. A test compares the two rosters for both project states.
- AC2: Every tool an ACP session offers renders with a meaningful ACP tool `kind` — search tools as `search`, read tools as `read`, and so on — and a test fails if a tool in the ACP roster falls back to `other` without being listed as a deliberate exception.
- AC3: The ACP roster adds no tool whose results carry `untrusted: true`, no delegation tool and no bus tool; a test enumerates the roster and asserts this, so widening it later is a visible decision rather than a side effect.
- AC4: After `session/new` and `session/load`, keryx sends one `available_commands_update` whose entries have the published shape (`name`, `description`, optional `input.hint`) and list only commands keryx handles over ACP; TUI-only commands are not listed. A command arriving as prompt text beginning with `/` is handled by keryx and does not reach the model; an unlisted one is answered with the list of available commands.
- AC5: The `session/new` and `session/load` responses carry `configOptions` with one `select` option of category `model` whose values are the models keryx can actually run in this project, resolved from the same source `keryx shell` uses, and whose `currentValue` is the model the session is running.
- AC6: `session/set_config_option` for the model option switches the model from the next turn on and answers with the complete, updated `configOptions`; `/model <value>` does the same and sends `config_option_update`. A switch never changes a turn already running, an unknown value is refused with the reason, and the choice does not rewrite `keryx shell`'s saved default.
- AC7: `src/acp/protocol.ts` types `AvailableCommand`, the config option and its values per the published schema, `config_option_update` carries `configOptions`, and `session/set_config_option` leaves the refused-method list; the version-pin test still passes and the method-partition test still covers every v1 agent method.
- AC8: Process tests over a real stdio pipe with the fixture provider cover: the project tools offered and one of them called in a turn, the commands update arriving after `session/new`, a `/` command handled without reaching the model, and a model switch through both `session/set_config_option` and `/model` taking effect on the following turn. Every wait is on a wire event, not a timer.
- AC9: The CLI reference and README list which keryx tools an ACP session offers and why the others are excluded, which commands are advertised, and how to switch model from the editor; nothing in the docs still says an ACP session offers only five tools or that the model is fixed at launch.
- AC10: CI is green on the PR and `keryx health run` gate is pass.
