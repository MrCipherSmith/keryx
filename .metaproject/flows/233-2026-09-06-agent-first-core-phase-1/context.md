# Контекст этапа 1
Version: 0.1.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, implementation-plan.md, decision-traceability.md and associated contract documents.

Зависимости: этапы 0. Root проверяет delivery evidence каждого prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст/тест-дизайн можно собрать заранее.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый .worktrees inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

## Parent source inventory

- MCP resources.ts ends in lexical isPathInside → stat/readFile without realpath; dispatchReadResource bypasses redactToolOutput. Tool exceptions also return raw error message. Existing resource and MCP tests are first regression targets.
- MCP http-sse.ts creates transport/listener without validating host and has no listen error rejection. Keep SAC transport-deny unchanged, validate addresses before importing transport/connecting/listening; safe synthetic tests can assert no bind without external network.
- Harness metaproject-adapter read_wiki and skill discovery/load share owner-root reading risk; inspect and reuse contained-path/secure-resource-read as appropriate; prove internal links, external links, missing targets and identity/race behavior with temp fixtures.
- Health sources/dependency-audit.ts and gate.ts own Bun/npm parse and required check completeness. Existing static audit must be reproduced in fixtures, not cited as current PASS.
- Security directory scan and structural redaction share service and payload types: one owner should coordinate scan/result completeness and JSON safe representation before edits.
- Shell parser help regression is independent, owns shell.ts parser/launch and related tests; avoid agent.ts currently owned by phase0 M10 worker.
- All synthetic boundary tests stay in temporary roots with synthetic values. No external target probing or real model calls.
