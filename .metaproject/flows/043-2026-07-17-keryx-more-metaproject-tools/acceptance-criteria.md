# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `MetaprojectPort` (src/harness/tool/metaproject-port.ts) gains OPTIONAL methods for the new operations (e.g. `graphPath?`, `testRelated?`, `healthStatus?`) plus their content result types; being optional, every existing full `MetaprojectPort` fake in the test suite still compiles WITHOUT modification. `createMetaprojectAdapter` implements each new method over the real module facade (gdgraph / testing / health), or a bounded argv-safe CLI where no in-process facade exists, deterministically and WITHOUT throwing (a backing error → a structured error/empty result). At least TWO new operations are delivered; any whose backing is not cleanly available is dropped and the drop is documented in the journal.
- AC2: The new operations are added to `METAPROJECT_OPERATIONS` (src/harness/tool/metaproject-operations.ts), each risk `read`, with valid input/output JSON Schemas, and each descriptor validates against docs/requirements/keryx-metaproject-native/schemas/metaproject-operation.schema.json (asserted by the existing operations schema test). Each new descriptor's `invoke` calls the corresponding OPTIONAL port method and returns "unavailable" (structured, isError) when the method is absent.
- AC3: The new operations auto-surface in all THREE consumers through the existing projections — `toInteractiveTools` (agent), `toToolDefinitions` (harness ToolRegistry), and `toMcpTools` (MCP) — with NO per-consumer wiring changes beyond the single source; a unit test asserts each projection now includes the new operation names. The M-10 read-only posture is preserved (all new tools mutating:false / risk read).
- AC4: No regression / offline / deterministic — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1431 pass / 3 skip / 0 fail with new tests green and 0 fail; OFFLINE/deterministic (injected fakes; no real graph build / subprocess / network in tests); `dependencies` REMAINS `{}`; the existing 5 operations, the projections, the chat core, and the frozen policy engine are unchanged.
