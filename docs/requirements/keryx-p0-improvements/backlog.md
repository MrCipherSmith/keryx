# Backlog — improvements not in the P0 package

Version: 0.1.0

The rest of what the 2026-09-27 competitive review found worth doing. Each
entry names what was measured or observed, and why it is not P0. Companion to
`docs/requirements/backlog.md`, which holds measured defects; these are
product directions.

## P1 — platform parity and honest numbers

### 1. Linux sandbox parity

Observed: `keryx sandbox status` and `docs/docs/limitations.md` — domain
allowlist, credential masking and TLS termination are macOS-only; on Linux
the hardened `trust` dispatch refuses without bubblewrap and these three fail
closed. Linux is where CI and unattended agents run. Flow 099
(Landlock+seccomp) is blocked on a Linux host.
Why not P0: needs a Linux host with the kernel features and a week of
containment testing; P0 items are demonstrable on a laptop.

### 2. Graph freshness

Observed: `keryx gdgraph affected src/cli.ts` reported HEAD 1 632 files past
the last build within one working day.
Direction: incremental rebuild on changed files; `affected` parses changed
files on the fly; a watch mode inside `keryx shell`.
Why not P0: the post-commit hook already rebuilds; the gap is intra-session,
which the honesty note partly covers.

### 3. Measure the context economy

Observed: the earlier measurement run (`results/vantage-context-measurement`,
unmerged) was negative on both passes; README still implies savings. Augment
claims −32 %; OpenCode is criticised for ×4.7 overhead.
Direction: a repeatable benchmark on three repositories, published numbers,
or the claim removed.
Why not P0: it is a measurement, not a feature; it decides marketing copy.

### 4. Memory auto-extraction

Observed: Codex Memories and Cursor Projects extract durable facts from
sessions automatically; keryx's `learn` loop requires a TTY confirmation at
every promotion step.
Direction: candidate extraction without a gate, batch confirmation, the
current strictness kept for promotion.
Why not P0: the loop exists; this is a UX change to consent, which the
project treats as a security boundary — needs its own design pass.

### 5. Wiki dogfood

Observed: keryx's own wiki has zero domain-model, user-scenario, service and
integration pages.
Direction: generate them for keryx; they are the showcase of the main feature.
Why not P0: content work, no code; should follow W5 so `wiki ask` examples in
docs match the output shape.

### 6. ACP against real IDEs; VS Code extension on the marketplace

Observed: ACP verified against the schema and a hand-driven Zed; Kiro reaches
JetBrains/Eclipse/Zed via ACP; the `vscode-extension/` directory exists and
has a CI job but is not published.
Why not P0: distribution work; W1's live-run harness is the template for
"verified against a real client".

### 7. Windows, without a sandbox first

Observed: flow 100 blocked; no Windows support at all, while Claude Code,
Codex, Gemini and Kiro run there.
Direction: run without OS sandbox and say so loudly; sandbox later.
Why not P0: needs a Windows host and touches process spawning, paths and the
TUI.

## P2 — growth

### 8. Public catalog of bundles and skills

Observed: Gemini Extensions, Claude plugins and the Cline MCP marketplace give
users a place to browse; keryx has `bundle` export/import and skill export
with no index.
Why not P0: needs content before it needs a catalog.

### 9. Stability policy before 1.0

Observed: 0.3.0 → 0.3.15 in two days; `.metaproject/` layout and CLI surface
explicitly unstable.
Direction: a written list of what is stable, a deprecation path
(`deprecation-path` skill exists), release notes that name breaking changes.
Why not P0: policy, not code; W5's doctor and did-you-mean reduce the pain
meanwhile.

### 10. Comparison pages

Observed: no page explains "checksum-frozen AC vs prompt-frozen" or "review
with a verifier vs one reviewer" — the two arguments competitors cannot make.
Why not P0: docs; write after W3 ships the action so the page has a link.

### 11. Voice in `keryx shell`

Observed: Codex CLI voice on by default (moderate confidence); helyx already
speaks replies.
Why not P0: low demand from the operator; helyx covers the use.

### 12. Architecture debt

Cycles, `retryableFor` duplication, the `tui-shell.ts` split — tracked in
[keryx-audit-remediation](../keryx-audit-remediation/README.md) R4.
