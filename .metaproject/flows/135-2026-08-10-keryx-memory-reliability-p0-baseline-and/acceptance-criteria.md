# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: P0-1 baseline commands and exact counts for memory, harness/native adapter, MCP, approval context, flow context, init/update, and embeddings are recorded in the flow context or journal.
- AC2: A reusable snapshot helper records root-relative file paths, SHA-256 hashes, file content, and relevant Git status while excluding `.git`, dependency trees, and ignored runtime-noise paths.
- AC3: Service default search, CLI text search, and CLI `--json` search have executable no-write contract assertions with an opt-in enforcement mode and an explicit legacy report-path characterization.
- AC4: Native adapter and unified `memory_search` coverage proves structured recall behavior and preserves read-only risk metadata; its opt-in purity assertion captures the current service write.
- AC5: MCP `memory.search` coverage proves `mutating: false`, structured invocation, and the same opt-in purity contract; approval-context advisory lookup has equivalent filesystem/Git coverage and remains best-effort.
- AC6: Committed authority fixtures contain matching accepted, draft, conflict, deprecated, expired, and superseded entries, plus current/as-of coverage where `Valid-To` equal to query day is excluded.
- AC7: The legacy `data/memory/artifacts/latest.{md,json}` report-path contract is documented and tested as a P1 migration target without changing the P0 service contract.
- AC8: Existing focused suites retain their pre-change green result, and the P0 tests do not introduce a permanently failing default test.
- AC9: `docs/requirements/keryx-memory-reliability/implementation-plan.md` marks only P0-1 through P0-10 complete after verification, with no P1+ production changes.
