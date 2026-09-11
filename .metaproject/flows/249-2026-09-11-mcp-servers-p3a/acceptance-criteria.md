# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Every compat source the specification names is read: `<project>/.cursor/mcp.json`, `~/.cursor/mcp.json`, `<project>/.mcp.json`, `~/.claude.json` (both `mcpServers` and `projects.<cwd>.mcpServers`), and Grok `~/.grok/config.toml` and `<repo>/.grok/config.toml` (`[mcp_servers.*]`). Each contributes servers tagged with its own source, and a fixture per source proves it.
- AC2: READ-ONLY, enforced and not merely intended. No command writes to a compat file: a test asserts every compat fixture is byte-identical after `add`, `remove`, `enable`, `disable` and `trust` have run against a config containing compat servers.
- AC3: `keryx mcp remove <name>` for a name that exists ONLY in a compat source fails with a message naming the file to edit, and exits non-zero. It does not silently succeed and it does not write a native entry.
- AC4: Precedence is stated and tested: native project beats native user beats every compat source, because native config is what keryx owns and writes while compat is somebody else's file. Among compat sources the order is fixed and asserted by a test in which one name is defined in every source at once.
- AC5: `keryx mcp disable <name>` works for a compat server through the personal overlay, without touching the compat file — the same property the overlay exists for with committed project files. Asserted by a test that disables a compat server and re-reads both the overlay and the untouched source.
- AC6: A malformed compat file is a PROBLEM, not a crash and not a silent skip: it is reported through `config.problems` naming the file, and every other source still loads. Covered per source, including a Grok TOML that is not valid TOML.
- AC7: Grok's TOML is parsed without adding a TOML dependency to the runtime bundle, or — if a dependency is unavoidable — the reader is lazy so a user with no Grok config never loads it. Whichever holds is stated in a decision note.
- AC8: D-13 as decided on 2026-09-11: a tool whose qualified name fails the FQN pattern is SANITISED (`sac.read` → `self__sac_read` in `fqn`, `sac.read` preserved in `rawName`) rather than skipped. The regex itself is unchanged.
- AC9: D-13 collision rule: when two sanitised names collide, the FIRST in the server's own `tools/list` order wins and the loser is recorded as skipped WITH A REASON naming the winner. Asserted with `a.b` and `a_b` in both orders, so the rule is order-dependent by design and not by accident.
- AC10: `use_tool` with a sanitised FQN calls the server with the RAW name. Asserted end to end against the mock server, reading what the server actually received — not what keryx believes it sent.
- AC11: Measured on keryx's own server: `keryx mcp add self -- keryx serve-mcp --cwd <repo>` then `doctor self` reports 45 tools reachable and 0 skipped for an invalid FQN, against the 19/26 P0 recorded. The number is in the confirmation note.
- AC12: Compat reading and FQN sanitisation are each covered by a CLASS table using the shared `classTableProblems` rule, with a BOUNDARY in every class.
- AC13: Mutation coverage over the diff: every non-equivalent survivor is killed by a new test or recorded with the reason it is equivalent. Run in slices, since this environment reaps detached processes.
- AC14: `bun test`, `bunx tsc --noEmit`, `bun run lint` and `bun src/cli.ts skills verify --bundled` all pass.
- AC15: The release is smoke-tested on the INSTALLED binary before the merge, as P2 established — a compat fixture is read by the real CLI and shown by `keryx mcp list` with its tag. The operator's own config is restored afterwards.
