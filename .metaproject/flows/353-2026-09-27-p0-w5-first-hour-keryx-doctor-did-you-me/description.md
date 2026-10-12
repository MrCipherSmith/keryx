# P0 W5 first hour: keryx doctor, did-you-mean, mcp list exit codes, memory search hint, health tests detection, bare providers

Status: draft (flow-init skill formalizes this)
Source: user description

## Problem

Describe the problem precisely: what is broken/missing, for whom, and why now.

## Expected Outcome

What must be true when this flow is done.

## Out of Scope

Explicitly excluded work.

## Problem
W5 of docs/requirements/keryx-p0-improvements (prd.md, specification.md §4 W5, §8 AC9–AC10): the first five commands a new user types misbehave — `keryx doctor` is "Unknown command" plus the full usage while three `* doctor` subcommands exist; `mcp list` exits 1 over a foreign malformed config; `memory search release` finds nothing and does not mention `--semantic`; `health run` on keryx itself reports the test source missing; bare `providers` prints usage.

## Non-goals
W1–W4; the audit-remediation package; changing the pinned help fixtures.
