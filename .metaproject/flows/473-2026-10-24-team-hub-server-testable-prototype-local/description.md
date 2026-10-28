# Team Hub prototype for server testing

Intent: deliver a runnable self-hosted prototype for the user's server test on 2026-10-26, based on the Keryx2 research and current Page. The user explicitly authorized autonomous documentation and delegated implementation.

Local development and application environments remain local. Hub stores shared project context, spec-linked Flow records, code revisions, exact-content wiki proposals and authenticated decisions; Git adapter publishes prepared selected code.

Specification: docs/requirements/team-hub-prototype/specification.md. Work happens only in <repo>, branch codex/team-hub-prototype, base main. Completion: verified handoff without PR/merge/deployment; this managed Flow remains in-progress under current CLI completion rules.

Prototype deviations: Bun/SQLite single-process storage and separate bootstrap human/agent tokens instead of PostgreSQL/OAuth. Imported local evidence is visibly self-reported, not independent trust. No arbitrary server shell, no forced rebase of dirty checkouts, no automatic legacy local Flow mirroring.
