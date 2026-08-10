# Project Memory

Version: 0.2.0

## Purpose

Long-term project memory: lessons learned, decisions, constraints, known
mistakes, historical context, and reusable patterns. Markdown is the durable
source of truth. `keryx memory index` optionally builds a disposable catalog;
runtime search scans canonical Markdown directly and does not consume that
catalog or an inverted index.

## Entry Types

- `lesson` (`lessons/`)
- `decision` (`decisions/`)
- `constraint` (`constraints/`)
- `known-mistake` (`known-mistakes/`)
- `historical-context` (`historical-context/`)
- `pattern` (`patterns/`)
- `task-note` (`task-notes/`)
- `review-note` (`review-notes/`)
- `incident` (`incidents/`)
- `migration-note` (`migration-notes/`)
- `integration-note` (`integration-notes/`)

## Usage

```bash
keryx memory new lesson --title "<title>"
keryx memory index [--embeddings]
keryx memory search "<query>" --status accepted [--save-report]
keryx memory transition <path> --to accepted --reason "<reason>"
```

Default search is pure and never writes a report. `--save-report` explicitly
publishes a bounded per-run report under ignored runtime storage. Only
`accepted`, current, scoped, bounded projections influence skills; `draft`
entries are advisory. Init/update migration advice for legacy `latest.*` files
is non-destructive.
