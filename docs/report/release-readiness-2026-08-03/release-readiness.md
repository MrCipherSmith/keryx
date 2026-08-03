# Release Readiness Report — 2026-08-03

Supersedes [release-readiness-2026-07-10](../release-readiness-2026-07-10/release-readiness.md),
whose four blocking gaps are all closed.

## Decision

**Ready to tag and publish `0.2.0`. Not ready to call it `1.0`. Not ready to
announce until the documentation plan's Phases 3, 4 and 6 are done.**

Every quality gate that failed in July now passes, the documentation falsehoods
found today are fixed, and the three release blockers identified in this report's
first draft are closed: the version is set, a release workflow exists, and the
npm decision is made.

What still gates an *announcement* is not code quality — it is that
`architecture.md` predates most of the architecture, there are no diagrams, and
there is no published site. Sending people to that inverts the project's actual
quality.

## Verification matrix

All gates run on `feat/r4c-turn-submission` at 2026-08-03, with `main` at
`0b54411b`.

| Gate | Result | Evidence |
|---|---|---|
| Full tests | **PASS** | `bun run test` → 2967 pass, 14 skip, 0 fail, 37,216 `expect()` calls across 291 files (47.75s) |
| TypeScript | **PASS** | `bun run typecheck` clean — *was FAIL in July* |
| Metaproject Standard | **PASS** | `standard validate` compliant, 2 warnings (`tasks` and `gdwiki` declare data paths that do not exist) — *was FAIL in July* |
| Strict Code Health | **PASS** | `health gate --strict-warn` → `gate: pass`, no conditions triggered — *was FAIL in July* |
| Security policy | **PASS** | config schema valid, `configChecksum` ok |
| Guard suite | **PASS** | `bun run test:guards` → 161 pass |
| Wiki links | **PASS** | 42 pages, 233 internal links, 0 broken |
| Documentation links | **PASS** | 70 local links across 17 files, 0 broken (ad-hoc check — see gaps) |
| Package build and install | **PASS** | 292 files, 1.02 MB packed / 3.68 MB unpacked; tarball installed into a clean prefix and exercised (see below). `prepack` removed, so the build now runs once — *the July "build runs twice" concern is fixed* |
| Canonical documentation language | **PASS** | English throughout the published surface |
| Version coherence | **PASS** | `package.json` = `0.2.0`; the release workflow refuses a tag that disagrees with it — *was FAIL in this report's first draft* |

## Current project map

- Graph nodes: **645** (302 in July)
- Graph edges: **1,397** (676 in July)
- Wiki pages: **42** (36 in July)
- Test files: **291** (110 in July)

The tree-sitter symbol layer reports unavailable and falls back to the
deterministic path, which is the designed behaviour, not a defect.

## What changed since July

The July report's four blockers are closed: TypeScript typechecks, Standard
validation passes, strict Code Health passes, and the repository is
English-only. Since then the project also gained the OS sandbox, the expanded
agent harness and multi-agent engine, the OpenTUI shell, and the remote entry
(`keryx serve`) through R4c.

## Documentation corrected in this pass

Each of these was **false** when the pass began, not merely thin:

- `docs/requirements/roadmap.md` — the `keryx-remote-entry` row declared R4c
  `not started`; PR #220 had merged as `0b54411b`.
- `docs/requirements/keryx-remote-entry/README.md` — same, plus the deferred-item
  list still owed two things R4c delivered (the AC-04 profile comparison and
  auth-failure throttling).
- `README.md` — no mention of `keryx serve` at all, three flows after it shipped.
- `docs/docs/cli-reference.md` — six top-level commands absent: `shell`,
  `sessions`, `harness`, `projects`, `serve`, `metrics`. All eleven occurrences
  of "serve" in the file were `mcp serve`.
- `CHANGELOG.md` — `[0.1.0]` dated `2026-07-08`; the tag is `2026-07-10`. The
  `[Unreleased]` section knew nothing of the sandbox, the harness, the TUI shell
  or the remote entry.

## Blockers for a release — all closed

| # | Blocker | Resolution |
|---|---|---|
| B1 | The version number was meaningless | Set to **`0.2.0`**. `1.0.0` would overclaim while R4d–R4f are open and containment is macOS-only. |
| B2 | No release workflow | `.github/workflows/release.yml`, triggered by a `v*` tag only. It refuses a tag that disagrees with `package.json`, runs the same gates as CI, installs and runs the packed tarball before publishing, and fails if the changelog has no section for the version. |
| B3 | npm publication undecided | Publishing as **`@mrciphersmith/keryx`**, scoped, `publishConfig.access: public`, with npm provenance. |

### The name collision found while closing B3

`keryx` on npm is **taken** — by [actionhero/keryx](https://github.com/actionhero/keryx),
an actively maintained fullstack TypeScript framework *for MCP and APIs*, at
`0.42.1`, published the same day this was checked. `npm install -g keryx`
therefore installs a different program in an adjacent problem space.

The scope resolves packaging. It does **not** resolve discoverability, which is
an open decision recorded as Phase 7 of the
[community documentation plan](../../plans/community-documentation-plan.md).

### Verified, not assumed

The packed artifact was installed into a clean prefix and exercised:

```
npm pack                     → mrciphersmith-keryx-0.2.0.tgz, 292 files, 1.02 MB / 3.68 MB
npm install -g --prefix …    → OK
keryx --help                 → keryx 0.2.0
keryx init --yes             → workspace, hooks, and registry entry created
keryx gdgraph build          → OK      keryx skills status     → OK
keryx serve config show      → OK      keryx standard validate → PASS
```

Contents: `dist/cli.js`, `dist/proxy-worker.js`, 32 files of `src/gdgraph`,
255 of `src/gdskills`, `LICENSE`, `README.md`, `package.json`.

Not shipped, by design: **ripgrep** (external; without it `ctx rg` is
unavailable and the harness reads files directly) and the optional tree-sitter
grammars and models (absent → deterministic fallback, nothing breaks).

### Remaining prerequisite

An `NPM_TOKEN` repository secret with publish rights. The workflow uses
`--provenance`, which also needs `id-token: write` — already set.

## Non-blocking gaps, stated so they are not discovered

- **Approvals over the remote entry are unimplemented.** A turn whose decision is
  `ask` terminates in a recorded denial. Deliberate, and R4d's scope.
- **`GET /health` and cross-process liveness are absent.** No PID file; `serve
  status` reports configuration state only.
- **The domain allowlist, credential masking and TLS termination are macOS-only**
  and refuse on Linux rather than degrading.
- **`pii: { action: "allow" }` still redacts** — an open policy-resolver question.
- **The source-pattern guards in `src/lib/config-dir.ast.ts` are heuristics**, with
  a written gap list held as executable tests. Only `production-graph.test.ts`
  has a real oracle: it asks the bundler what ships.
- **Documentation link checking is not a CI gate.** `wiki check-links` covers the
  wiki; `docs/` was checked here with an ad-hoc script that lives in a scratchpad,
  not in the repository. Phase 6 of the
  [community documentation plan](../../plans/community-documentation-plan.md)
  makes it a gate.
- **`keryx metrics` top-level help omits `compare` and `rebuild`**, which the
  command implements. A source fix.
- **`scripts/install.sh` ignores `KERYX_REPO_URL` when updating.** The variable is
  documented in the script's own `--help` as "Git repository URL", but
  `clone_or_update` only honours it on a *fresh* clone: when `~/.keryx/keryx/.git`
  already exists it runs `git fetch origin "$REF"` against whatever `origin` the
  old clone carries. So `KERYX_REPO_URL=... KERYX_REF=...` on an existing install
  fails with `couldn't find remote ref` while appearing to be a bad ref rather
  than an ignored URL. Found by installing this branch from a local path. The fix
  is to set the remote before fetching; the workaround is to remove the target
  directory so the clone path runs.

## Recommendation

1. **Publish `0.2.0`** — add the `NPM_TOKEN` secret, then tag `v0.2.0`. The
   workflow does the rest and refuses to publish something that does not run.
2. **Then** execute Phases 3, 4 and 6 of the
   [community documentation plan](../../plans/community-documentation-plan.md)
   before any announcement. The project is in better shape than its
   documentation makes it look, and announcing now would invert that.
3. **Decide the name question early** (Phase 7). It is nearly free today and
   gets more expensive with every user.

## Method note

This report was written under the standing rule that produced this branch's
central lesson: **a claim without a runnable command is not evidence.** Every
row in the verification matrix names the command that produced it, and the
figures were re-derived on 2026-08-03 rather than carried forward. The one
figure quoted from July — the four closed blockers — is cited to the report that
recorded them.

Related: `.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md`
