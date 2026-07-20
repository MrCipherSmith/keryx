# gdwiki

Version: 0.1.0

## Purpose

Project knowledge base from business logic to implementation.

## Commands

- `keryx wiki status`
- `keryx wiki new <type> <slug> --title "<title>"`
- `keryx wiki collect [--force] [--limit <n>]`
- `keryx wiki index`
- `keryx wiki check-links`
- `keryx wiki validate`
- `keryx wiki enrich [<page>|--all] [--prompt "<i>"] [--provider <p>] [--model <m>] [--dry-run] [--json]` — model-backed: rewrite draft page prose via a provider (anthropic/ollama/openrouter/grok). Fail-closed without a credential. Prompt override: `.metaproject/wiki/enrich.prompt.md`.

## Page Types

- `architecture` (`wiki/architecture/`) - system or module architecture
- `domain-model` (`wiki/domain-models/`) - entities, invariants, relationships
- `business-rule` (`wiki/business-rules/`) - business constraints and decisions
- `user-scenario` (`wiki/user-scenarios/`) - user workflows and expected outcomes
- `component` (`wiki/components/`) - UI/component behavior and ownership
- `service` (`wiki/services/`) - backend/service responsibility and APIs
- `integration` (`wiki/integrations/`) - external systems and contracts
- `decision` (`wiki/decisions/`) - known decisions and ADR-like records

## Data

- `wiki/index.md`
- `data/gdwiki/link-check/latest.md`

## Entry

- `wiki/index.md`

## Skills

- `skills/gdwiki/`
