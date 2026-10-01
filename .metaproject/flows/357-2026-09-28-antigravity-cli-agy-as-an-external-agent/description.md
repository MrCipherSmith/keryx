# Antigravity CLI (agy) as an external agent, read-only, under the operator's Google subscription

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

Describe the problem precisely: what is broken/missing, for whom, and why now.

## Expected Outcome

What must be true when this flow is done.

## Out of Scope

Explicitly excluded work.

## Problem
docs/requirements/keryx-antigravity-agent (BRD, PRD, specification): the operator's Google AI Pro/Ultra subscription is reachable only through Google's Antigravity CLI (`agy`). keryx drives `agy` in its documented headless stream-json mode as a fourth external agent; keryx never touches Google credentials. `agy` 1.2.12 is installed and logged in on the build machine; a live probe (fixture committed) captured the real event shapes.

## Non-goals
Subscription OAuth inside keryx (rejected: Google's terms name it a breach); an ACP adapter; worktree-write (line-stream write mode does not exist yet).
