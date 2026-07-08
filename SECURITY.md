# Security Policy

`keryx` ships a deterministic, local security module (`keryx security`) for
scanning agent inputs, outputs, and `.metaproject/` artifacts. That module
protects users of the tool; this document covers how to report a vulnerability
**in `keryx` itself**.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

Security fixes land on the latest `0.1.x` release. Please upgrade to the latest
version before reporting.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report privately through one of these channels:

1. **GitHub Security Advisories** (preferred) — use
   ["Report a vulnerability"](https://github.com/MrCipherSmith/keryx/security/advisories/new)
   on the repository's Security tab. This keeps the report private until a fix
   is available.
2. **Email** — contact `<security contact>`.

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
repository — for example command injection, path traversal, unsafe file writes,
or bypasses of the built-in `security` module's guarantees.

Out of scope: vulnerabilities in optional dependencies that are not enabled by
default (`web-tree-sitter`, `@modelcontextprotocol/sdk`, `@xenova/transformers`)
should be reported upstream, though we welcome a heads-up if they affect `keryx`
users.
