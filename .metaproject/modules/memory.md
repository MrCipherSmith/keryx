# memory

Version: 0.1.0

## Purpose

Long-term, typed project memory with deterministic ranked search and a
gdskills learning signal.

## Commands

- `keryx memory new <type> --title "<title>"`
- `keryx memory index`
- `keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--json]`
- `keryx memory ingest --from-<source> <path>`
- `keryx memory check`
- `keryx memory reflect [--narrate] [--provider <p>]` — cluster related entries; `--narrate` adds a model summary of themes (fail-closed without a credential)

## Config

- `memory.config.json`

## Data

- `memory/index.md`
- `data/memory/artifacts/latest.md`

## Skills

- `skills/memory/`
