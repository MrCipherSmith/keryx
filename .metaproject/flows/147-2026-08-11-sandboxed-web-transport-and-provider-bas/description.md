# Sandboxed web transport and provider-based web search

Status: planned
Source: user-provided multilingual PRD (2026-08-12)

## Problem

`web_fetch` currently performs its network request inside the agent process.
That duplicates security policy for future search adapters and cannot provide the
required process/OS isolation on both supported platforms. Agent-mode users also
cannot configure, test, select, or troubleshoot web-search providers.

## Expected Outcome

All agent web retrieval crosses one fail-closed `SandboxedWebTransport` boundary.
Public remote egress uses validated pinned HTTPS connections; external content is
bounded, redacted, provenance-labelled, and blocked when injection is detected.
Agent-mode gains descriptor-driven search-provider setup and selection, including
an explicit local SearXNG configuration flow.

## Out of Scope

- Browser automation, JavaScript execution, cookies/logins, POST/forms, uploads,
  downloads, arbitrary headers, and Windows support.
- General private/LAN egress. The only loopback exception is the capability-scoped
  SearXNG adapter.
