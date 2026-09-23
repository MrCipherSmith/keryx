# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A scheduled `agent-task` grant accepts `network: "allowlist"` with a required non-empty `domains` list (exact names or `*.domain` wildcards, the grammar `matchesAllowlist` already implements); an empty, malformed, IP-literal or bare-`*` entry is refused on load with the reason, the "delivered by flow 301" refusal is gone, and flow-next dispatch keeps its boolean network unchanged.
- AC2: `planUnattendedSandbox` with `allowlist` always runs `--unshare-net`, binds no resolv.conf, binds in only the run's proxy unix socket (created under the run's own 0700 scratch parent), and refuses the run - never falls back to `off` or `full` - when the socket or proxy cannot be created.
- AC3: The proxy runs outside the sandbox in the dispatcher and listens on that unix socket; it allows plain HTTP by `Host` and HTTPS `CONNECT` by authority only for listed domains, refuses IP-literal targets, and after resolving an allowed name refuses loopback, private, link-local, CGNAT, unique-local and metadata addresses (169.254.169.254 and its encoded forms), reusing or mirroring the coverage in `src/harness/mutation/guard.ts`.
- AC4: The proxy connects to the exact address it checked, so a name that resolves to a public address at check time and to a private or metadata address on a second lookup is refused, proven by a test with an injected resolver.
- AC5: Inside the sandbox a keryx-shipped TCP-to-unix forwarder, started in the same bwrap invocation as each `shell_exec` command, listens on 127.0.0.1, and HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy and ALL_PROXY point at it; bytes a client sends before the unix side connects are not lost.
- AC6: A real bwrap integration test on Linux shows `curl` through the proxy reaching an allowed name served by a local test upstream and failing with a proxy refusal for a name not on the list, and a listener on the host's real 127.0.0.1 stays unreachable from inside the sandbox under `allowlist`.
- AC7: Every proxy allow and deny decision (host, port, decision, reason, time) is written into the run's report and its runs.jsonl record next to the existing denials and granted calls.
- AC8: The domain list is part of the signed schedule content, so changing it after confirmation refuses the run with `grants-changed`, proven by a test.
- AC9: The `/schedule` and `schedule_create` confirmation card shows `network: allowlist - <domain>, <domain>` through `cardSafe` and states that only the agent's shell commands are governed, never showing an allowlist as `off` or `full`.
- AC10: The TUI Schedules Grants tab and the schedule row show the allowlist mode and every domain, and the Runs tab shows each run's proxy denials, with TUI tests.
- AC11: `allowlist` is refused with a reason naming the platform wherever the hardened unattended sandbox is unavailable (macOS, no bwrap), never silently weakened.
- AC12: Flow-next dispatch worktrees move under a per-uid 0700 scratch parent that must be ours and not a symlink, as agent-task runs already do, and `planSandbox` there hides that parent from the sandbox, proven by a test that shows one run cannot see another's worktree.
- AC13: `keryx sandbox status` keeps the general harness "Domain allowlist" Linux row as not-implemented with a note that the unattended allowlist is a separate capability, so the two surfaces do not disagree silently.
- AC14: `docs/docs/cli-reference.md`, `docs/docs/limitations.md`, the README and the scheduled-tasks skill document the mode, that it is Linux-only, that it governs only the agent's `shell_exec` traffic (not the model call and not granted tools, which run outside the sandbox), and the limits: clients that ignore proxy variables get no network, and a blind CONNECT relay cannot see SNI or the in-tunnel host.
- AC15: CI is green on the pull request and `keryx health run` passes before merge.
