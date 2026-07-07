# Metaproject Standard

Version: 0.1.1

Status: draft documentation package. This standard is not yet a stable public
v1.0 contract.

## 1. Purpose

Metaproject Standard defines a project-local `.metaproject/` format that can be
understood by humans, AI agents, CI systems and IDE integrations.

`gd-metapro` is the reference implementation of this draft standard. The CLI
creates, updates, validates and reads the `.metaproject/` workspace.

## 2. Documents

- [prd.md](prd.md) - product requirements and success criteria.
- [specification.md](specification.md) - draft technical standard.
- [profiles.md](profiles.md) - minimal, agent, CI and full compatibility
  profiles.
- [agent-protocol.md](agent-protocol.md) - discovery and routing protocol for
  coding agents.
- [ci-protocol.md](ci-protocol.md) - CI/CD integration protocol.
- [artifact-lifecycle.md](artifact-lifecycle.md) - versioning, generated data
  and transient artifact rules.
- [schemas/](schemas/) - initial JSON Schema contracts.

## 3. Draft Scope

The v0.1 draft standardizes only the small core:

- `.metaproject/metaproject.json` discovery manifest;
- `.metaproject/index.md` LLM-friendly portal;
- `.metaproject/README.md` human technical guide;
- module registry and module manifests;
- rules and skills routing;
- artifact lifecycle policy;
- profile-based capability discovery;
- validation requirements.

Module-specific contracts such as `gdgraph`, `health`, `testing`, `memory`,
`gdwiki`, `gdctx`, `gdskills`, `tasks` and `security` remain separate specs
referenced by this standard.

## 4. Non-Goals

- Freeze a public v1.0 ecosystem contract before schemas and validators mature.
- Require every project to enable every module.
- Treat `gd-metapro` implementation details as mandatory for other tools.
- Replace existing agent or CI configuration systems.
