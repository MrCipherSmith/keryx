# OpenSpec in Keryx Metaproject
Version: 0.1.1

## Purpose

Make OpenSpec a first-class knowledge source in the Keryx project. Explore intended behavior alongside the project Wiki and code Graph. Follow a requirement through proposed and archived changes to the documents and components it affects.

## Status

Read-only delivery is in progress under [Flow 514](../../../.metaproject/flows/514-2026-11-22-metaproject-openspec/plan.md), with frozen criteria for P0–P2. The Flow journal records implementation and verification evidence. Draft Flow intake remains planned as P3.

The baseline is Keryx main at `b3dd71b88`. Desktop already projects Graph and Wiki. Team Hub already imports OpenSpec Markdown from explicitly connected projects as documents. The local explorer and Hub import are separate entry points.

## Documents

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package overview, status and scope |
| [PRD](prd.md) | Users, workflows, requirements, release gates and outcomes |
| [Specification](specification.md) | Local sources, typed identities, graph links, query contract and acceptance criteria |
| [Implementation plan](implementation-plan.md) | Dependencies, work packages and GitHub CI / live verification |
| [Link file schema](schemas/links-v1.schema.json) | Versioned contract for explicit cross-source links |

## Scope

- Desktop Metaproject gains **OpenSpec**, with **Specs**, **Changes** and **Archive**, plus cross-source search and graph navigation.
- Keryx provides one local read service and CLI access for Desktop, Shell and external harnesses. The base release uses ordinary checkout files and works offline.
- A later increment creates a draft local Flow from an active change and records the exact source snapshot.

## Non-goals

- An OpenSpec editor, lifecycle runner, package installer, validator or replacement for the upstream workflow.
- Automatic spec extraction from code or Wiki, automatic “implements” assertions, or status inferred from a branch or PR.
- Synchronizing OpenSpec task checkboxes with Flow, rewriting Git history, Hub uploads from Desktop, or implementing multi-repo OpenSpec worksets in this package.

## Related modules

- [Existing Desktop explorer](../../docs/guides/desktop-metaproject.md)
- [Wiki and Graph ownership](../../../.metaproject/wiki/architecture/wiki-graph-sac.md)
- [Living Wiki and Graph](../keryx-living-wiki-graph/README.md)
- [Team Hub prototype](../team-hub-prototype/specification.md)
- [Keryx acceptance layer](../keryx-acceptance-layer/README.md)
- [OpenSpec concepts, pinned upstream reference](https://github.com/Fission-AI/OpenSpec/blob/v2.1.1/docs/concepts.md)
