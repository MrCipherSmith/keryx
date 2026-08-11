# Agent-mode безопасный web_fetch

Status: ready to freeze
Source: user description

## Problem

Agent mode can inspect only the repository and Metaproject artifacts. It has
no first-class, content-returning HTTP tool, so external documentation requires
an approved shell command or is answered from stale model knowledge.

## Expected Outcome

Agent mode exposes a read-only `web_fetch` tool. It retrieves a public HTTP(S)
page with bounded, untrusted text output, without shell approval or credentials.

## Out of Scope

- Web search and any search-provider configuration.
- Local/private endpoints, including future local SearXNG integration.
- Authentication, cookies, custom headers, POST, downloads, JavaScript
  rendering, or changes to existing shell approval policy.
