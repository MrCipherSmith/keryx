# Audit fixes: credential leaks to external agents and web redirects, sub-agent cancel, shell lease

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

Describe the problem precisely: what is broken/missing, for whom, and why now.

## Expected Outcome

What must be true when this flow is done.

## Out of Scope

Explicitly excluded work.

## Problem
A full audit (2026-09-27) confirmed: external agent children inherit the operator's SSH agent, cloud and GitHub credentials; the web transport re-sends the search API key across cross-origin redirects; timed-out sub-agent output bypasses injection quarantine; the MCP child env filter misses concatenated credential names; the MCP trust fingerprint ignores the oauth block; parent-turn abort does not reach sub-agents (single, concurrent batch, wrap-up round); keryx shell leaks the session lease on a thrown turn and orphans background jobs on SIGINT.

## Non-goals
Architecture refactors (cycles, tui-shell split, retryableFor dedupe), redaction entropy, injection-detector homoglyphs, web_fetch outbound screening — separate flow.
