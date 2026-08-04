# Limitations

keryx is pre-1.0. The deterministic core — graph, wiki, memory, testing, health,
review, tasks and security — runs offline with no model provider, and that is the
part the product is built around. This page lists what is *not* there yet, what
each gap actually costs you, and what to use instead.

## Summary

| Limitation | Impact | Alternative |
|------------|--------|-------------|
| No remote approval transport | A remote turn whose policy decision is `ask` ends in a recorded denial | Run approval-requiring turns locally |
| Domain allowlist is macOS-only | Domain-level egress policy, credential masking and TLS termination refuse to run on Linux | Filesystem containment and network on/off work on both |
| No bundled embedding runtime | No semantic ranking in memory search | Lexical memory search remains fully available |
| No bundled ML security classifiers | Detection is rules plus entropy, not a model | Deterministic detectors run on the full corpus and are evaluated in CI |
| ripgrep is external | `keryx ctx rg` exits non-zero without `rg` on `PATH` | Install ripgrep, or let the agent read files directly |
| Model commands need a credential | Five commands exit non-zero without one | Every other command is deterministic and offline |
| Windows is unverified | The core CLI is not exercised on Windows in CI | Use macOS or Linux, or WSL |

## Optional AI features are not bundled

Two model-backed features have no runtime shipped: semantic memory search and the
ML security detectors. The ONNX stack was removed to keep the package small, so
their runtime identifiers are empty strings:

- `src/memory/config.ts` — `runtime: ""` for the memory embedding seam
- `src/security/detect/index.ts` — `SECURITY_MODEL_RUNTIME = ""`

Re-enabling them means setting those constants and installing a
transformers.js-API package — it is a code change, not a downloadable asset.

Both features run on their deterministic floor in the meantime, and that floor is
the shipped, tested behaviour:

- **memory** — lexical retrieval with indexing, dedup, bitemporal validity and
  module/entity/class filters.
- **security** — deterministic rules plus entropy analysis, measured against a
  committed evaluation corpus (`keryx security eval --corpus all`).

## Commands that require a model credential

These five commands add model-generated output on top of deterministic data and
exit non-zero without a configured provider credential:

- `keryx test suggest <file>`
- `keryx flow plan <id>`
- `keryx memory reflect --narrate`
- `keryx health explain <target> --narrate`
- `keryx wiki enrich` — the exception that degrades rather than failing: it exits
  `0` and marks the affected pages skipped.

Nothing else in the CLI needs a provider.

## Code search needs ripgrep

`keryx ctx rg` and the agent harness's `search_code` tool shell out to
[ripgrep](https://github.com/BurntSushi/ripgrep). Without `rg` on `PATH` the
command exits non-zero rather than falling back to a slower scan, so the failure
is visible instead of silently different.

```bash
brew install ripgrep      # macOS
apt install ripgrep       # Debian/Ubuntu
```

## Tree-sitter grammars are optional

The symbol and call graph uses tree-sitter grammars that are **not bundled**.
When a grammar is absent, `gdgraph` falls back to its deterministic import
resolver — the dependency graph, affected sets, cycles, orphans and repo map all
still work. Grammar-backed symbol extraction is the part that is unavailable.

## Platform support

| Platform | Status |
|----------|--------|
| macOS | Full support, including the complete policy sandbox (Seatbelt), domain allowlist, credential masking and TLS termination |
| Linux | Full core support. OS sandbox via `bubblewrap` (`bwrap` on `PATH`): filesystem containment and network on/off. The domain allowlist, credential masking and TLS termination **refuse to run** rather than degrading to full host network |
| Windows | The core CLI is not exercised in CI on Windows; the OS sandbox is macOS/Linux only |

The macOS-only tier is a fail-closed decision: a domain allowlist that quietly
became "all network" on Linux would be worse than one that says it cannot run.
See the [operator guide](https://github.com/MrCipherSmith/keryx/blob/main/docs/requirements/keryx-os-sandbox/operator-guide.md)
for the containment matrix and the
[Linux verification runbook](https://github.com/MrCipherSmith/keryx/blob/main/docs/verification/linux-sandbox-verification.md)
for what has been verified on a real host.

## Remote approvals are not implemented

`keryx serve` accepts turns over a loopback-bound authenticated HTTP listener,
but there is no approval transport yet. A turn whose policy decision is `ask`
terminates in a *recorded denial* — it is never auto-approved. Run
approval-requiring work through `keryx shell` locally until the transport lands.

Two boundaries that do hold today:

- The remote policy profile is compared against the local one on every turn, and
  a weaker remote profile is refused rather than accepted.
- Authentication happens *before* routing, so an unauthenticated caller cannot
  distinguish a known path from an unknown one.

## Format stability

The `.metaproject/` layout, artifact formats and CLI surface are still moving
before 1.0. `keryx update` refreshes managed service files without touching data
artifacts, and the [changelog](https://github.com/MrCipherSmith/keryx/blob/main/CHANGELOG.md)
records what changed in each release, including a standing known-gaps list.
