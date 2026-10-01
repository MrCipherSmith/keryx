# Project status

Keryx is pre-1.0 software with one primary maintainer and frequent releases.
This page says what is stable, what is experimental, which platforms are
covered, and how the project checks its own work. Figures were measured on
1 October 2026 on the main branch.

## Version and cadence

| | |
|---|---|
| Current series | 0.3.x; `keryx --version` and the [latest release](https://github.com/MrCipherSmith/keryx/releases/latest) show the newest version |
| Release tags | over 190 since the first release, 0.1.0, on 10 July 2026 |
| 0.3.x releases | started with 0.3.0 on 25 September 2026; usually several a day |
| Distribution | npm package `@mrciphersmith/keryx`, published from CI with a provenance attestation; standalone binaries attached to each GitHub release |
| Changes | Recorded per version in [CHANGELOG.md](https://github.com/MrCipherSmith/keryx/blob/main/CHANGELOG.md); highlights on [Changelog](changelog.md) |

Releases are small and frequent: most are a single fix or feature. Until 1.0, a
minor version can change a command, a flag or a file format. Such changes are
recorded in the changelog, and a renamed command keeps working under its old
spelling for a while.

## Platforms

| Platform | Status |
|---|---|
| macOS (arm64, x64) | Full support, including the complete OS sandbox: domain allowlist, credential masking and TLS termination |
| Linux (x64, arm64) | Full core support. The OS sandbox uses `bubblewrap` for filesystem containment and network on or off; the domain allowlist, credential masking and TLS termination refuse to run rather than fall back to full network |
| Windows | Unverified. The core CLI is not run in CI on Windows, no standalone binary is published, and the OS sandbox is macOS and Linux only. WSL is the suggested route |

Standalone binaries are built for `darwin-arm64`, `darwin-x64`, `linux-x64`
and `linux-arm64`. No binary is published for Alpine or other musl-based Linux.
The npm package needs Bun 1.3.14 or newer. Details are on
[Limitations](../limitations.md#platform-support).

## Stable, experimental and opt-in

| Status | What it covers |
|---|---|
| Stable | The nine default modules (code graph, compact command output, wiki, skills, health, testing, memory, task flows, security), `keryx shell`, model providers, flows, review packages |
| Experimental | Shared Agent Context; the review-service checks for scenarios, docs and comments, which the recommended review profile marks as not measured; per-runtime context hooks whose contract comes from community documentation; agent integration adapters marked `experimental` in the integration registry (see below) |
| Opt-in | The MCP server, Shared Agent Context, external agent CLIs, the remote HTTP entry (`keryx serve`). Each is off until you enable it |

Stable means the behaviour is tested and documented and changes are announced,
not that the interface is frozen. 1.0 will mean the interface is frozen; there
is no target date.

The integration registry records a confidence for each agent integration.
`keryx integrations matrix` prints it:

```bash
keryx integrations matrix
```

```text
  id                    state    confidence    supported flags
  claude                native   verified      block,prompt-gate,inject-context,observe,agents,rules
  codex                 native   verified      block,inject-context,agents,rules
  cursor                native   verified      block,prompt-gate,inject-context,rules
  windsurf              native   verified      block,prompt-gate,rules
  antigravity           adapter  experimental  block
  opencode              adapter  experimental  block,agents
  zed                   adapter  experimental  block,instructions
  generic-mcp           adapter  experimental  block,prompt-gate
  gemini-cli            adapter  experimental  block,instructions,rules
  kiro                  adapter  experimental  block,agents,instructions,rules
  github-copilot-agent  adapter  experimental  block,instructions,rules
  keryx-shell           adapter  verified      block,prompt-gate,inject-context,pre-tool-context,observe,post-tool,session-start,stop
```

`verified` means the contract was confirmed against the runtime's own
documentation; `experimental` means it should be checked on a live install.

## Numbers

As of 1 October 2026, measured on `main` at commit `1aec6f7d` (`package.json`
version 0.3.51, 1,722 commits). Every figure below was produced by the commands
after the table, run on that commit's tree. Run them yourself; the figures grow
with every merge.

| Figure | Value |
|---|---|
| Commits | 1,722 |
| First commit | 2026-07-10 |
| Merged pull requests | 275 |
| Release tags | 195 |
| Flows (of which done) | 343 (307) |
| Tasks across flows | 2,894 |
| Flows with review rounds | 124 |
| Review rounds | 284 |
| TypeScript source files, not tests | 1,117 files, 373,386 lines |
| Test files | 1,367 |
| Test lines under `src/` | 382,616 |
| Wiki pages | 97 |
| Bundled skills | 78 workflow skills; 92 stack skills in 23 stack packs |
| Project rules | 41 |
| Memory entries | 20 |

The commands, in the same order, from the root of a checkout of `main`:

```bash
git rev-list --count main
git log main --reverse --format=%ad --date=short | head -1
git log main --merges --grep '^Merge pull request' --oneline | wc -l
git tag -l 'v*' --merged main | wc -l
keryx flow list | grep -cE '^ *[0-9]+ \['
keryx flow list | grep -cE '^ *[0-9]+ \[done\]'
keryx flow list | grep -oE 'tasks [0-9]+/[0-9]+' | awk -F/ '{s+=$2} END{print s}'
find .metaproject/flows -mindepth 2 -maxdepth 2 -type d -name reviews | wc -l
find .metaproject/flows -mindepth 3 -maxdepth 3 -type d -path '*/reviews/*' | wc -l
git ls-files 'src/*.ts' | grep -v '\.test\.ts$' | wc -l
git ls-files 'src/*.ts' | grep -v '\.test\.ts$' | tr '\n' '\0' | xargs -0 cat | wc -l
git ls-files '*.test.ts' | wc -l
git ls-files -z 'src/*.test.ts' | xargs -0 cat | wc -l
keryx wiki status | grep 'total pages'
find src/gdskills/bundled/skills -name SKILL.md | wc -l
find src/gdskills/bundled/stacks -name SKILL.md | wc -l
find src/gdskills/bundled/stacks -mindepth 1 -maxdepth 1 -type d | wc -l
find .metaproject/rules -type f | wc -l
find .metaproject/memory -name '*.md' ! -name index.md ! -path '*/templates/*' | wc -l
```

Test lines exceed source lines. That shows test volume, not coverage; coverage
is not measured as a percentage.

## Quality gates

Work is checked at four points: before it starts, before a flow completes, on
every pull request, and at release.

**Before work starts**, acceptance criteria are frozen by checksum. They change
only through a recorded update that voids earlier confirmations.

**Before a flow completes**, every criterion needs a confirmation with evidence,
and the completion gate checks the review record: a review must exist, every
finding at or above `minor` must reach a terminal state, a fix needs a verifier
verdict, and the last review must match the pull request head.

**On every pull request**, `.github/workflows/ci.yml` runs ten jobs:

| Job | What it checks |
|---|---|
| `typecheck-and-tests` | Lint, typecheck, the core test suite, documentation links, the security scanner's red-team false-negative gate, drift in the integration matrix |
| `client matrix` | Shell client tests in four legs: terminal, streaming, cancel and resume, runtime |
| `standard-baseline`, `standard-pr` | The Metaproject Standard on `main`, then the pull request classified against that baseline |
| `dependency-audit` | Dependency audit through the health module |
| `metrics-contract` | Observability contract tests |
| macOS real-host legs | The macOS OS sandbox and a real shell launched on a pseudo-terminal, failing on any skipped test |
| `linux sandbox` | Live sandbox smoke tests under `bubblewrap` |
| `opentui native` | Terminal UI tests on linux-x64, linux-arm64, darwin-arm64 and darwin-x64, failing on any skipped test |
| `vscode-extension` | Typecheck and unit tests of the editor extension's logic layer, outside an editor host |

Two more workflows run on pull requests: `docs.yml` builds this site with
`mkdocs build --strict`, and `wiki-freshness.yml` validates the wiki when
`src/` or the wiki changes.

**At release**, `.github/workflows/release.yml` runs on a `v*` tag. The tag
must match `package.json`; typecheck, tests, documentation links, the security
gate and the Metaproject Standard run again. Before anything is published, the
packed npm artifact is smoke-tested, the `linux-x64` binary is run, and the
other three binaries, which cannot run on that runner, are checked for the
expected platform and architecture.

## Known gaps

- **Pre-1.0.** Commands and file formats can still change between minor
  versions.
- **One primary maintainer.** Most work is done by one person with agents. The
  [record of that work](built-with-keryx.md) is public, but it is not a team
  review.
- **Windows is unverified**, and the Linux sandbox lacks the domain allowlist
  and credential masking that macOS has.
- **No coverage percentage.** Test volume is reported, coverage is not.
- **Experimental parts** are listed above; the full list of limits is on
  [Limitations](../limitations.md).

## Roadmap

The [roadmap](https://github.com/MrCipherSmith/keryx/blob/main/ROADMAP.md) has
no dates. In summary:

- **Now:** a leaner agent-first core, routing by measured task cost, model
  guidance in agent instructions, keeping private work in-house, more providers
  and sign-in options, reviews that fail closed, shell polish, and this
  documentation.
- **Next:** strict flags everywhere, diffs against the merge base, reporting
  "could not tell" instead of passing, forgetting that propagates across graph,
  wiki and memory, and evidence-based evaluation of skills.
- **Later:** Windows support, a stronger Linux sandbox, optional semantic
  search, remote approvals for tool-using turns, merging session branches,
  and 1.0.
