# Security Policy

`keryx` ships a deterministic, local security module (`keryx security`) for
scanning agent inputs, outputs, and `.metaproject/` artifacts. That module
protects users of the tool; this document covers how to report a vulnerability
**in `keryx` itself**.

## Supported Versions

| Version             | Supported          |
| ------------------- | ------------------ |
| latest `0.3.x`      | :white_check_mark: |
| any earlier release | :x:                |

The project is pre-1.0 and releases frequently (`0.3.46` as of this writing);
there is no long-term-support branch. Security fixes land on the latest
release. Please upgrade to the latest version before reporting.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately through
[GitHub private vulnerability reporting](https://github.com/MrCipherSmith/keryx/security/advisories/new)
("Report a vulnerability" on the repository's Security tab). This keeps the
report private until a fix is available.

Please include:

- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- affected version(s) and environment (OS, Bun version);
- any suggested remediation.

## What to Expect

- We will acknowledge your report as soon as we can.
- We will investigate, confirm the issue, and work on a fix.
- We will coordinate a disclosure timeline with you and credit you if you wish.

Please give us a reasonable opportunity to address the issue before any public
disclosure.

## Scope

In scope: vulnerabilities in the `keryx` CLI, its runtime, and the code in this
repository. Because `keryx` is a tool that runs agents, the areas that matter
most are:

- **Command execution** — bypasses of the permission modes, the policy engine,
  the structural command guard, or the OS sandbox; command injection.
- **Secrets handling** — leaks of credentials or personal data through logs,
  artifacts, session records, or output; unsafe permissions on files holding
  credentials; bypasses of redaction.
- **Network egress** — a model call or other network request made without the
  opt-in the documentation describes, or an allowlist that does not hold.
- **MCP and remote entry** — authentication or authorization bypass in
  `keryx serve`, `keryx serve-mcp`, or the ACP server; exposure beyond loopback
  without acknowledgement.
- Path traversal, unsafe file writes, and bypasses of the `security` module's
  guarantees.

The [security model](https://mrciphersmith.github.io/keryx/concepts/security-model/)
describes what each layer is meant to guarantee and what it does not.

Out of scope: vulnerabilities in optional dependencies that are not enabled by
default (`web-tree-sitter`, `@modelcontextprotocol/sdk`, or an explicitly
configured third-party model adapter) should be reported upstream, though we
welcome a heads-up if they affect `keryx` users.
