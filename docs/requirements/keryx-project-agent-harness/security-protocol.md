# Keryx Project Agent Harness Security Protocol
Version: 0.2.0

## Security Objective

The harness executes model-directed actions in a repository. Its security
objective is to ensure that untrusted content can influence reasoning but
cannot silently expand authority.

## Trust Classes

| Class | Examples | Default treatment |
|---|---|---|
| `trusted-policy` | project policy, user approval, Keryx manifest | may govern execution |
| `project-source` | source files, tests, committed docs | data; scan for injection |
| `project-artifact` | generated graph, health, memory, reports | data; verify provenance |
| `external-untrusted` | issue text, web pages, PR comments, dependencies | data; redact/scan before prompt |
| `model-output` | text, tool calls, summaries | untrusted; schema/policy check |
| `third-party-extension` | skills, packages, plugins | privileged code; explicit trust |

## Policy Controls

The first implementation must control:

- file read roots;
- file write roots;
- external directory access;
- shell command allow/ask/deny patterns;
- environment variable inheritance;
- network host/operation access;
- child-agent creation;
- git mutation and publication;
- credential-mediated tools;
- maximum output size and execution duration.

Hard denies cannot be overridden by a model message or a project file loaded as
untrusted content.

## Security Profiles and Containment

| Profile | Permitted scope | Required containment | Release |
|---|---|---|---|
| `read-only-review` | registered read-only tools only | no mutation, shell, network, credential, child-agent, or extension capability | Release 0 only |
| `monitored-trusted-local` | explicitly approved local mutation | user-visible approval plus path/argv/environment/process controls; not a sandbox claim | Release 1 |
| `unattended-untrusted` | no mutation by default | real OS/container/remote isolation with explicit mount, UID, process-group, network, and credential boundaries | later, fail closed if unavailable |

Permission prompts express consent; they never substitute for isolation. A run
that requires unavailable containment returns a typed blocking result rather
than falling back to an unsandboxed mutation.

## Approval and Provenance Binding

An approval is single-use and binds the canonical action fingerprint: tool id and
definition/schema hash, normalized input hash, policy/profile fingerprint,
worktree/branch/context provenance fingerprints, actor, expiry, and scope. A
change to any bound value makes a pending approval `stale`; it remains in history
but cannot be consumed. Approval lifecycle is requested, approved, denied,
consumed, expired, revoked, or stale. Provenance IDs and trust class flow from
context source through a tool justification; untrusted evidence is never policy
authority.

## Safe Defaults

- read project files: allow within worktree;
- write/edit: ask for interactive runs, deny for review/research roles;
- shell: ask by default, allow only safe read commands by explicit profile;
- network: deny unless the run explicitly enables it;
- external directory: deny;
- git commit/push/reset/clean: ask or deny by profile;
- child agent: ask unless parent is an approved orchestrator role;
- secret access: deny except through named mediated tools;
- non-interactive `ask`: fail closed with a typed approval-required result.

## Prompt-Injection Handling

1. Scan untrusted text through existing security detectors.
2. Preserve the source and detection result as metadata, not hidden instructions.
3. Mark untrusted content in the rendered context.
4. Never copy instructions from untrusted content into trusted policy.
5. Require approval for a tool action whose justification originates only from
   untrusted content.
6. Persist a redacted detection event.

## Filesystem and Process Safety

- Resolve and canonicalize paths before policy checks.
- Reject traversal outside approved roots.
- Use atomic writes and preserve user content outside managed regions.
- Apply timeouts and cancellation to child processes.
- Avoid shell interpolation; pass argv arrays where possible.
- Limit stdout/stderr size and store large output as bounded artifacts.
- Terminate process groups on cancellation.
- Record command, cwd, environment policy, exit code, and output artifact
  references.

The canonical path policy resolves symlinks before authorization, rejects escape
from approved roots, uses argv rather than shell interpolation, applies an
environment allowlist, controls child process groups, and makes external
directory, git, and publication permissions explicit. A non-interactive `ask`
always fails closed.

## Network Broker

Network tools are deferred from Release 0. When enabled later, every request
must pass a broker that validates URL scheme and port, resolves DNS, re-checks
each redirect and resolved address, denies private/link-local/metadata ranges,
controls proxies and Unix sockets, enforces request/response size and time
limits, and persists a redacted decision record. Existing text egress detection
is defense in depth only; it is not network enforcement.

## Persistence Safety

Never persist:

- API keys, cookies, passwords, private keys, or full environment snapshots;
- raw hidden chain-of-thought or internal reasoning traces;
- unrestricted raw prompts when redaction has not run;
- unrelated filesystem paths or user data;
- unredacted external content in shared reports.

Persist hashes, redacted previews, provenance, and typed summaries instead.

## Security Tests

Required fixture families:

- path traversal and symlink escape;
- shell injection and command quoting;
- command policy glob precedence;
- prompt injection in code comments, issue bodies, and wiki pages;
- secret and PII redaction in model/tool/error events;
- approval bypass attempts;
- network and external-directory denial;
- child-agent privilege escalation;
- cancellation during a mutating tool;
- malformed tool schemas and oversized payloads.
- stale/single-use approval, scan failure, and provenance-taint propagation;
- redirect/private-address denial and proxy/Unix-socket controls;
- fail-closed containment checks for unattended/untrusted mutation.
