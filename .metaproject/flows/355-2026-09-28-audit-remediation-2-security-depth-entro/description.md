# Audit remediation 2: security depth — entropy redaction, injection evasions, outbound URL secrets, token paths, win32 open, credential-shape module (R3)

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

Describe the problem precisely: what is broken/missing, for whom, and why now.

## Expected Outcome

What must be true when this flow is done.

## Out of Scope

Explicitly excluded work.

## Problem
Flow 2 of docs/requirements/keryx-audit-remediation (prd.md R3; specification.md §4.3, §8 AC6–AC8): redaction sees only known secret shapes; the injection detector is defeated by a newline or a homoglyph; read-class web tools can carry a secret out in a URL; token-shaped URL path segments print in `mcp list`; the win32 browser open re-tokenises the URL; the credential-shape classifier lives in an MCP-specific module and has two small precision gaps.

## Non-goals
R4 architecture and R5 gates (flow 3); S-11 (parseGrokToml raw values) unless it falls out of AC2 for free.
