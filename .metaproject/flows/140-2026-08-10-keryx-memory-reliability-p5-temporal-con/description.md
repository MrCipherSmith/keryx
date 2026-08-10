# Keryx Memory Reliability P5 — Temporal, Config, Catalog, and Validation Consistency

Status: ready to freeze
Source: user description

## Problem

Keryx's memory paths still carry semantic inconsistencies after the prior
purity, authority, lifecycle, and guarded-write phases: temporal checks are
duplicated, date validation is shape-only, configuration accepts weak or
deprecated values, and catalog/embedding artifacts are treated inconsistently
with the Markdown source of truth.

## Expected Outcome

One shared, calendar-aware temporal helper governs general search, relevant
recall, and procedural injection with an exclusive Valid-To boundary. CLI and
config inputs return structured actionable validation errors, additive config
sections remain backward-compatible, automatic acceptance stays impossible,
all known memory types remain usable, and `memory index` is an optional,
reproducible catalog that search neither consumes nor requires. Deleting
catalogs or embeddings leaves lexical results byte-identical and deterministic.

## Out of Scope

- P6 release documentation/rollout, roadmap/status package work, and full
  repository completion.
- Changes to canonical Markdown ownership, the lexical ranking floor, or the
  P3 accepted/current authority guarantees.
- Deleting or staging unrelated prior-flow files, commits, pushes, PRs, or
  changing flow state by hand.
