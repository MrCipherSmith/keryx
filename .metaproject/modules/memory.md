# memory

Version: 0.2.0

## Purpose

Long-term, typed project memory with deterministic ranked search, explicit
reports, accepted/current bounded automatic recall, and a guarded lifecycle.

## Commands

- `keryx memory new <type> --title "<title>"`
- `keryx memory index [--embeddings]` (optional disposable catalog/cache)
- `keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <class>] [--semantic] [--save-report] [--json]`
- `keryx memory transition <path> --to <draft|accepted|conflict|deprecated> [--reason <text>]`
- `keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]`
- `keryx memory ingest --from-<source> <path>`
- `keryx memory check`
- `keryx memory reflect [--narrate] [--provider <p>]` — cluster related entries; `--narrate` adds a model summary of themes (fail-closed without a credential)

## Config

- `memory.config.json`

## Data

- `memory/index.md`
- `data/memory/index/` (optional generated catalog; not consumed by search)
- `data/memory/embeddings/` (optional generated cache)
- `runtime/memory/search/<run-id>/` (explicit bounded reports only)

## Semantics

- Markdown under `memory/` is canonical and durable.
- Default search is a filesystem-pure read and scans canonical Markdown
  directly; it does not consume an inverted index or write `latest.*`.
- Reports are written only with `--save-report`, to unique ignored runtime
  directories. Catalogs and embeddings are disposable and may be deleted.
- Automatic integrations use accepted, current, scoped, bounded projections.
- Lifecycle transitions and supersession are explicit, validated, security-
  gated, and atomic. Init/update only advise on legacy `latest.*` migration;
  they never delete files or mutate the Git index.

## Skills

- `skills/memory/`
