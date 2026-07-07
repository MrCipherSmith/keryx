# Metaproject Standard: PRD

Version: 0.1.0

## 1. Problem

AI-agent tooling, CI reports, project documentation, code graphs, task state and
project memory are usually stored in unrelated places. Agents often waste
context reading broad files, raw logs or oversized root instructions because
there is no shared project-local contract for discovery.

`gd-metapro` already creates a useful `.metaproject/` structure, but that
structure is currently described mostly as implementation documentation. To
make it useful beyond one CLI, it needs a clear draft standard.

## 2. Goal

Define a small, stable Metaproject draft standard that lets any compatible
agent, CI job, IDE plugin or tool discover:

- which metaproject capabilities exist in a repository;
- where human and agent entrypoints live;
- which modules are enabled;
- where module artifacts are stored;
- what can be committed versus regenerated;
- how to route to skills, rules, graph, context, health, testing, memory, wiki
  and task artifacts.

## 3. Users

- Developers who want a predictable project brain under `.metaproject/`.
- AI coding agents that need token-efficient project discovery.
- CI pipelines that publish normalized reports for humans and agents.
- IDE/plugin authors that want one local contract instead of per-tool
  conventions.
- Maintainers of `gd-metapro` as the reference implementation.

## 4. Requirements

### R1. Discovery

A compatible tool must be able to detect a Metaproject by checking
`.metaproject/metaproject.json` and reading the standard version, enabled
modules and paths.

### R2. Human and Agent Entrypoints

A compatible Metaproject must expose:

- `.metaproject/index.md` as the LLM-friendly routing portal;
- `.metaproject/README.md` as the human technical guide.

Root entrypoints such as `AGENTS.md` and `CLAUDE.md` should remain small and
point to `.metaproject/index.md`.

### R3. Modular Capability Model

Modules must be discoverable through `metaproject.json`. Each module must
declare its enabled state, manifest path, artifact path and public commands or
capabilities.

### R4. Profiles

The standard must define compatibility profiles so projects can be valid without
enabling every module:

- minimal;
- agent;
- CI;
- full.

### R5. Artifact Lifecycle

The standard must define which files are canonical, generated, transient,
versioned, local-only or CI-published.

### R6. Validation

The reference implementation provides:

```bash
gd-metapro standard validate
gd-metapro standard doctor
gd-metapro standard capabilities
```

These commands are implemented in the reference CLI (`src/standard/` and
`src/commands/standard.ts`): `validate` checks a workspace against the bundled
`metaproject.schema.json`/`module.schema.json` plus profile rules and exits
non-zero on failure, `doctor` reports the same findings as actionable fixes, and
`capabilities` prints the standard version, active profiles, and enabled modules
from `metaproject.json`.

## 5. Success Criteria

- A developer can understand the `.metaproject/` contract without reading
  source code.
- An agent can discover capabilities from `metaproject.json` and `index.md`.
- CI can publish normalized artifacts without knowing `gd-metapro` internals.
- The README can truthfully describe `gd-metapro` as the reference
  implementation of Metaproject Standard draft v0.1.
- Future validators can be implemented from the schemas in this package.

## 6. Risks

- The draft becomes too broad and blocks implementation progress.
- Module-specific details leak into the core standard.
- v1.0 compatibility is promised before schemas are tested across real
  repositories.
- Generated artifacts become noisy in git if lifecycle rules are vague.

## 7. Recommendation

Keep v0.1 intentionally small. Standardize discovery, entrypoints, module
registration, artifact lifecycle and validation. Keep graph, health, testing,
memory, wiki and task formats as referenced module specs until their contracts
are stable enough to become standard annexes.

