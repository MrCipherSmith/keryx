# Контекст этапа 7
Version: 0.1.0

Project: /Users/Goodea/goodea/keryx. Integration branch: codex/agent-first-core; recorded base main@0bc6418fa1a038f8ec909cf949fecba077acf9a4.

Specs: docs/requirements/keryx-agent-first-core/README.md, specification.md, implementation-plan.md, decision-traceability.md and associated contract documents.

Зависимости: этапы 1, 2, 3, 5. Root проверяет delivery evidence каждого prerequisite до dependent implementation: CLI зависит только от задач одного flow, межflow DAG обеспечивается оркестратором явно. Независимый контекст/тест-дизайн можно собрать заранее.

Перед стартом: перечитать index, relevant graph/wiki/memory, current source и testing/health. Historical PASS и старый .worktrees inventory не доказательство текущего состояния. Stats disabled. Workers никогда не меняют flow.json/frozen AC/git; код по непересекающимся ownership.

---

## Implementation inventory — AC-19 / AC-20 (2026-09-07)

Read-only inventory. No `src/`, `scripts/`, `docs/` or other `.metaproject/` file was
modified. Every number below is **measured** on the working tree at the time of
writing (dirty by design, many lanes landed recently); where a statement is an
inference rather than a measurement it says so.

Normative source read: `docs/requirements/keryx-agent-first-core/prd.md` (AFC-19,
AFC-20, lines 42–43), `decision-traceability.md` (rows 19–20), `specification.md`
§1–§2, `implementation-plan.md` (wave 7, "Выделение Shell").

Method: import edges were extracted from every non-test `src/**/*.ts` by scanning
static `import`/`export … from`, side-effect `import`, dynamic `import()` and
`require()`; the shipped module graph was taken from the **bundler**, by running the
real release build command with `--sourcemap=external` and reading the sourcemap
`sources` — the same technique `src/lib/production-graph.test.ts` already uses and
documents as authoritative. Probes were written to the session scratchpad only.

---

### 1. What exists today

#### 1.1 There is no package boundary, and no library surface at all

`package.json` measured: no `exports`, no `main`, no `module`, no `types`. The only
entry declared is `bin.keryx → ./dist/cli.js`. Consequences, in order of importance:

- **Nothing is importable as a library by the documented entry.** With no `main` and
  no `exports`, Node falls back to `<pkg>/index.js`, which the package does not ship.
  `import "@mrciphersmith/keryx"` fails. So AC-19's "the client does not import
  private core" is currently vacuous *at the package level* — there is no published
  core to import — while being false *inside the repository*, which is where §1.3
  measures it.
- **Absence of `exports` means no encapsulation, so `files` becomes the public
  surface by accident.** `files` lists `dist`, `docs/requirements/shared-agent-context/schemas`,
  `src/gdgraph`, `src/gdskills/bundled`, `src/gdskills/contracts`, `LICENSE`,
  `README.md`, `package.json`. There is no `.npmignore` (verified: absent). Therefore
  every path under those directories is deep-importable by any consumer —
  including the 16 `*.test.ts` files inside `src/gdgraph/` (listed and counted), which
  ship in the tarball. That is an unintended, unbounded public surface pointing at
  *private core internals*, which is precisely what AC-20 asks to bound.
- The repository is a single package. There is no workspace, no second package, no
  per-package build. `dist/cli.js` is one bundle produced from one entry.

#### 1.2 Import-policy checks: three exist, all found the same way, all with the same hole

Found by (a) filename sweep for `*arch*|*boundar*|*import*|*layer*` under `src/` and
`scripts/`, (b) a content search for `importSpecifiers|staticImportPatterns|ALLOWED_EXTERNAL|
may import|must not import|import-boundary`, (c) a sweep for tests that walk the source
tree (`readdirSync`/`tsFiles`). That enumeration is complete for the repository:

| # | File | What it enforces | Direction it checks |
|---|---|---|---|
| 1 | `src/mcp/boundary.test.ts` | `src/mcp/` may import only `src/lib/*`, node builtins, its own subtree, and 16 named specifiers in `ALLOWED_EXTERNAL`; plus no static `@modelcontextprotocol/sdk` import anywhere in `src/`; plus `server.ts` loads the SDK only via `await import()` | adapter → owners (one zone only) |
| 2 | `src/capability/no-optional-imports.test.ts` | no static import of any `optionalDependencies` entry anywhere in `src/`; `@xenova/transformers` never statically imported and absent from every dependency block; `dependencies` stays `{}`; no install hooks | dependency-direction, repo-wide |
| 3 | `src/gdgraph/treesitter/no-treesitter-import.test.ts` | additive, gdgraph-specific restatement of #2 for `web-tree-sitter` | dependency-direction, one package |

`ALLOWED_EXTERNAL` in #1 is the "architectural allowlist that rejects an import
someone wanted to add" the sibling lane hit. It is a real, working directional check —
and it is the **only** one. There is nothing checking owner → CLI/MCP/Shell, nothing
checking client → private core, and nothing checking any zone other than `src/mcp/`.

All three run in the default `bun test` gate; #1's file is not in `test:guards` but #2's
neighbours are. Targeted run performed: `bun test src/mcp/boundary.test.ts
src/capability/no-optional-imports.test.ts src/gdgraph/treesitter/no-treesitter-import.test.ts`
→ 9 pass, 0 fail, 30 expect() calls.

There is a fourth, adjacent and stronger mechanism worth naming because phase 7 should
reuse it rather than reinvent it: **`src/lib/production-graph.test.ts`** answers "does
this module *ship*" by running the real release build as a subprocess with
`--sourcemap=external` and reading the emitted module graph. Its header records three
prior regex/AST guards that were each defeated by a respelling. Any packaging assertion
this phase adds should be built on that technique, not on a text scan.

Facade parity already has a mechanism too: **`src/harness/tool/metaproject-boundary-parity.test.ts`**
(516 lines) drives every case through the real dispatch (`METAPROJECT_OPERATIONS[…].invoke`
and the MCP `ToolEntry.invoke` from `toMcpTools`) rather than through a formatter, and
its header states that three lanes independently found the "capability lands in the
facade and the boundary never gains it" defect. AC-20's "facade parity survives a move"
has a working harness; it needs to be *pointed at the move*, not written from scratch.

#### 1.3 The dependency situation, and what a core-only install actually contains

- `dependencies: {}` — measured, and *asserted by a test* (#2 above, "zero-dep floor").
- `optionalDependencies`: `@modelcontextprotocol/sdk`, `@opentui/core`, `web-tree-sitter`.
- All external module specifiers in `src/` were enumerated: the only non-`node:`/`bun:`
  bare specifiers are exactly those three optional deps (`@opentui/core` 41 sites,
  `@modelcontextprotocol/sdk` 13, `web-tree-sitter` 6) plus `typescript` (1 site, the
  devDependency AST scaffolding that `production-graph.test.ts` keeps out of `dist`).
  **There is no undeclared runtime dependency.**
- The model runner is hand-written over `fetch`: `anthropic-provider.ts`,
  `openai-provider.ts`, `gemini-provider.ts`, `openai-compat-provider.ts` all call
  `fetch(` directly. No vendor SDK is a dependency, declared or otherwise. So
  AFC-19's "установка core не тянет model runtime" is **already true at the
  dependency level** — the model runner is source, not a package.
- But `npm install` installs `optionalDependencies` by default, and `@opentui/core`
  is a terminal-UI renderer — client-only by the spec's own division. A default install
  of this package therefore pulls a client runtime. `--omit=optional` is never
  exercised anywhere (searched CI and release workflows: no `--omit`, no
  `--no-optional`, no "core-only").

**Can a smoke test with no client and no keys pass today?** Measured, two ways:

1. Built the release command into the scratchpad and ran the artifact from a directory
   with **no `node_modules`** and with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` unset:
   `cli.js --help` → exit 0; `cli.js status` → exit 0 (`Metaproject: not initialized`).
   So the runtime already tolerates absent optional deps and absent credentials.
2. `release.yml` already contains a real install smoke: `npm pack` →
   `npm install -g --prefix ./.release/prefix "$TARBALL"` → `./.release/prefix/bin/keryx --help`.
   It runs on tag only (not on PR), it installs **with** optional deps, and it asserts
   nothing about what the artifact contains.

So the honest answer is: a *no-keys* smoke passes today and is partly automated; a
*no-client* smoke has never been run, because there is no core-only artifact to run it
against.

#### 1.4 The separate matrix AC-19 asks for

Terminal interface, line editing, streaming, cancellation and resumption **are** tested,
offline, and without credentials:

- TUI/readline: 38 `src/tui/*.test.ts` files; 30 files across `src/tui/` and
  `src/commands/shell*.test.ts` touch `readline|keypress|stdin|pty`.
- Streaming: `src/harness/provider/anthropic/sse.test.ts` plus the per-provider tests.
- Cancellation: 13 files matching `AbortController|abortSignal|cancelRun|interrupt`
  across `src/harness/`, `src/tui/`, `src/commands/`.
- Resumption: `src/harness/resume/recovery.hardening.test.ts`,
  `src/harness/session/session.test.ts`, `src/commands/sessions.fork.test.ts`,
  `src/commands/shell.test.ts`, and 20 more matching `resume|continueSession|--continue`.
- No test is gated on an API key. Searched `src/harness/**` and `src/tui/**` for
  `*_API_KEY` / `KERYX_LIVE` gating: the only skips are `describe.skipIf` on
  real-subprocess and PTY flags (`REAL_SUBPROCESS_FLAG`, `PTY_AVAILABLE`) and a
  platform check — opt-in live process smokes, not credentials.

What does **not** exist is the *matrix* itself. `package.json` has one `test` script
(`bun test`) and one `check` (`lint && typecheck && typecheck:scripts && bun test`).
CI (`ci.yml`) runs `bun run check` as a single job. There is no way to run the core gate
without the client gate, or to report them separately. AC-19 asks for the separation,
not for the tests.

---

### 2. What "core" and "client" mean here, derived from the code

The spec's division (`implementation-plan.md`, "Выделение Shell"): model/provider auth
and registry, turn loop, session streaming/compaction, vendor-agent orchestration and
TUI/readline are **client**; deterministic operations, policies, source owners and
output-size budgets are **core**; independent primitives may sit below both.

Mapped onto the tree, that is:

- **Client zones**: `src/harness/` (257 files on disk, 86 in the shipped bundle),
  `src/tui/` (100 / 51), `src/session/` (16 / 9), `src/mcp-client/` (10 / 2),
  `src/agents/` (2 / 1).
- **Adapters**: `src/cli.ts`, `src/commands/` (127 / 44), `src/mcp/` (26 / 12).
- **Core owners**: `gdgraph`, `wiki`, `memory`, `health`, `testing`, `ctx`, `security`,
  `sac`, `flow`, `standard`, plus `gdskills`, `metrics`, `review`, `capability`, `job`.
- **Shared primitives**: `src/lib/` (89 / 39), `src/contracts/`, `src/assets/`, `src/rules/`.

Ten declared public facades exist: `src/{flow,gdgraph,health,job,memory,sac,security,standard,testing,wiki}/service.ts`.
`src/ctx/` has no `service.ts`.

Composition of the shipped `dist/cli.js` bundle, measured from the sourcemap: 484
modules, 6,510,585 bytes of source. Client zones account for **149 modules / 27.3% of
source bytes** (harness 86 / 14.7%, tui 51 / 10.6%, session 9 / 1.7%, mcp-client 2 /
0.3%, agents 1 / 0.1%).

### 3. The measured crossings

915 cross-zone import edges among 551 non-test source files. Two directions matter.

#### 3.1 Owner → CLI / MCP / client (the AC-20 direction). **55 edges, 17 files, all static.**

| Owner file | Edges | Reaches |
|---|---|---|
| `src/wiki/deep-enrich.ts` | 13 | `commands/agent`, `harness/child/{ledger,orchestrate}`, `harness/policy/profiles`, `harness/provider/{make-provider,single-turn,types}`, `harness/session/types`, `harness/tool/metaproject-{adapter,operations,port}`, `harness/tool/builtin/interactive-tools` |
| `src/lib/serve-turn.ts` | 7 | `harness/{config,types}`, `harness/policy/types`, `harness/provider/types`, `harness/run/run`, `harness/tool/{registry,types}` |
| `src/sac/catch-up.ts` | 5 | `session/{paths,slate,slate-terminal-state,store,external-slate}` |
| `src/sac/machine-wrap-up.ts` | 4 | `session/{slate,slate-course}`, `harness/provider/single-turn` |
| `src/wiki/enrich.ts` | 4 | `harness/provider/single-turn` |
| `src/lib/serve-runner.ts` | 3 | `harness/process/sandbox/detect`, `harness/provider/make-provider`, `harness/policy/types` |
| `src/sac/service.ts` | 3 | `session/{store,external-slate,slate}` |
| `src/lib/{narrate,project-sandbox-policy,serve-server}.ts`, `src/sac/{session-wrap-up,workspace-resolve,wrap-up-evidence}.ts` | 2 each | `commands/providers`, `harness/provider/single-turn`, `session/paths`, `harness/process/sandbox/network-run`, `harness/policy/{profiles,types}`, `session/{store,slate,slate-course}`, `harness/tool/builtin/workspace-lifecycle-tool` |
| `src/lib/permission-mode-config.ts`, `src/sac/decision-dedup.ts`, `src/sac/policy-experiment.ts`, `src/security/harness-scan.ts` | 1 each | `commands/permission-mode`, `harness/provider/single-turn`, `harness/process/sandbox/profile`, `harness/evidence/redaction` |

By zone: `lib` 17 edges / 6 files, `sac` 20 / 8, `wiki` 17 / 2, `security` 1 / 1.

Two of these are misfiling rather than coupling, and the spec says so explicitly:
`src/lib/narrate.ts` (narration "относится к клиенту") and `src/lib/serve-*.ts` (server
routing "к своему adapter") are client/adapter code living in the shared-primitives
directory. Moving them costs nothing structural.

#### 3.2 Client → core (the AC-19 direction). **52 edges into owner modules, of which 6 land on a `service.ts` facade and 46 reach internals** — from 21 client files into 29 distinct private modules. (Edges into `lib`/`contracts`/`assets`/`rules` are excluded: the spec permits independent primitives below both consumers.)

By owner reached: security 9, gdgraph 9, sac 7, flow 7, wiki 3, gdskills 3, capability 2,
health 2, memory 2, testing 1, ctx 1.

Concentration matters more than the total. **`src/harness/tool/metaproject-adapter.ts`
alone accounts for 18 of the 46**, reaching `gdgraph/{path,symbol,query,config,staleness,repomap}`,
`memory/{relevant,types}`, `wiki/{ask,types}`, `flow/{tracker/github,types}`,
`health/{types,metrics/wiki-freshness}`, `testing/types`, `gdskills/skill-frontmatter`,
`security/guard`. That file is not really client code — `src/mcp/boundary.test.ts`'s own
allowlist admits the `harness/tool/metaproject-*` trio into `src/mcp/` on the grounds
that they are pure. It is a **core-shaped seam misfiled under the client zone**, and
relocating it below both consumers removes 18 of 46 crossings without touching behaviour.
Seven more of the 46 are type-only imports (`flow/types` ×3, `memory/types`,
`testing/types`, `health/types`, `wiki/types`), which the spec explicitly tolerates.

#### 3.3 The one crossing that actually breaks core-only packaging

Edge counts do not decide packaging; **reachability from the public facade** does. Each
facade was built in isolation with the real release flags and its module graph read from
the sourcemap:

| Facade seeded | Modules in graph | Client/adapter modules |
|---|---|---|
| `gdgraph/query` | 3 | **0** |
| `wiki/service` | 51 | **0** |
| `memory/service` | 47 | **0** |
| `health/service` | 38 | **0** |
| `flow/service` | 28 | **0** |
| `testing/service` | 36 | **0** |
| `security/service` | 28 | **0** |
| `standard/service` | 6 | **0** |
| `ctx/assembly` | 1 | **0** |
| **`sac/service`** | **84** | **20** |

Nine of ten core facades are already client-free. `sac/service.ts` is not, and what it
drags in is the worst possible set — the whole provider registry:

```
src/commands/providers.ts
src/harness/provider/{make-provider, single-turn, provider-port, tool-call-linking}.ts
src/harness/provider/anthropic/{anthropic-provider, sse}.ts
src/harness/provider/{openai/openai-provider, gemini/gemini-provider,
                      ollama/ollama-provider, compat/openai-compat-provider,
                      fake-provider}.ts
src/harness/{mutation/guard, policy/engine}.ts
src/harness/tool/builtin/workspace-lifecycle-tool.ts
src/session/{store, slate, slate-course, external-slate, paths}.ts
```

A build seeded from all ten facades: 162 modules, 2,043,985 source bytes, of which 14
harness modules (186,136 bytes), 5 session modules (79,646) and 1 commands module
(26,665) are client/adapter. **Every one of them traces to `sac/service.ts`.**

Two chains, both terminating at the same choke point:

```
sac/service.ts -> sac/workspace-resolve.ts -> harness/provider/single-turn.ts -> make-provider.ts -> 6 providers
sac/service.ts -> session/external-slate.ts -> sac/machine-wrap-up.ts -> harness/provider/single-turn.ts -> …
                                            (+ sac/workspace-resolve.ts -> harness/tool/builtin/workspace-lifecycle-tool.ts)
```

`src/session/slate.ts` alone does **not** reach `make-provider` (verified). The choke
point is `harness/provider/single-turn.ts`, statically imported by exactly three SAC
modules: `workspace-resolve.ts`, `machine-wrap-up.ts`, `decision-dedup.ts`.

This is the single load-bearing measurement of the inventory. AFC-19 says "В core нет
provider registry, выбора модели, credentials, LLM-вызовов". Measured: core contains all
four, through one facade, via one function, in three call sites.

`src/cli.ts` separately imports all 33 command modules **statically**, including
`shellCommand`, `harnessCommand`, `sessionsCommand`, `agentsCommand`, `providersCommand`.
So `keryx --help` evaluates the entire client graph. `implementation-plan.md` line 51
states the opposite requirement: "CLI help core не импортирует client даже лениво до
parser validation." That is a second, independent measured gap — but it is a gap in the
*binary*, not in the *package*, and AC-19 asks about packaging.

### 4. Exposure to the two recurring defect classes

**Class 1 — a capability living in a helper nothing calls.** Present, right now, in this
exact surface. `src/lib/production-graph.test.ts:316` exports `resolveSources` with the
comment "Extracted so a test can state that"; searched `src/**/*.ts`, `scripts/` and
`.github/` — the only caller is `graphsOf` in the same file. The stated purpose (a test
that distinguishes outdir-relative from map-relative sourcemap paths) has no test. The
file's own header is a three-round history of exactly this class. Any new packaging
assertion added by this phase is exposed the same way: a `core` entry module that nothing
builds, or an import-policy function nothing runs, would look identical to a working one.

**Class 2 — a failure rendered indistinguishable from a legitimate result.** Present in
all three existing import guards. Each ends in `expect(violations).toEqual([])`. None
asserts how many files it scanned; none has a fixture proving the detector fires.
`no-optional-imports.test.ts` has one partial sentinel (`expect(optionalDeps.length).toBeGreaterThan(0)`);
`mcp/boundary.test.ts` and `no-treesitter-import.test.ts` have none. A broken glob, a
renamed directory, or a regex that stopped matching yields a green empty list —
identical to compliance. AC-20's wording ("catches a forbidden fixture **and** passes an
allowed one") is a direct instruction to close exactly this hole, and it should be
applied to the three guards that already exist, not only to the new one.

---

### 5. Smallest honest change vs. maximal reading

AC-20's last clause — "весь repo на пакеты не дробится без пользы" — is a constraint on
the answer, not a caveat on it. Both readings below satisfy the words; only one satisfies
the clause.

| | **Smallest honest change (recommended)** | **Maximal reading** |
|---|---|---|
| Package layout | Stays one package. Add an `exports` map and one `src/core.ts` entry re-exporting the ten facades; close the accidental deep-import surface (`src/gdgraph/**`, incl. 16 test files, currently public). | Split into `keryx-core` + `keryx-shell` (+ a shared-primitives package), workspaces, per-package tsconfig/build/publish/versioning, a compat shim for `keryx shell`, two release pipelines. |
| Code moved | 3 SAC call sites stop statically importing `harness/provider/single-turn` (inject it as a port, or lazy-import it — the pattern already used and guarded for optional deps). Optionally relocate `harness/tool/metaproject-adapter.ts` below both consumers (−18 of 46 client→core crossings) and `lib/narrate.ts` + `lib/serve-*.ts` out of `lib` (−17 of 55 owner→client edges). | ~149 client modules relocated; ~915 cross-zone import specifiers rewritten; every test path updated. |
| Packaging proof | One test that builds `src/core.ts` with the real release flags and asserts **zero** modules from the client zones in the emitted sourcemap graph — reusing `production-graph.test.ts`'s technique verbatim. Offline, key-free, deterministic. | The same test, plus per-package install matrices and cross-package compatibility checks. |
| Install smoke | Add an `--omit=optional` variant to the release smoke that already exists, asserting `keryx --help` and one core command. | Separate `npm install keryx-core` job on a clean runner, per platform. |
| Import policy | One check with a **forbidden fixture and an allowed fixture** (AC-20's literal wording), covering owner→CLI/MCP/client and client→private-core; plus scanned-file sentinels retro-fitted to the three existing guards. | A full layering matrix over all 28 zones with per-zone allowlists. |
| Client matrix | A named `test:client` script over `src/tui/`, `src/harness/`, `src/session/`, `src/commands/shell*` and a separate CI job, so the core gate and the client gate report independently. The tests already exist and already run offline. | New TUI/streaming/cancel/resume suites, real-provider runs behind explicit permission. |
| Effort | ~4 behavioural files, ~2 new test files + fixtures, `package.json`, one CI file. | Months; touches everything; conflicts with every other lane. |

**Recommendation: the smallest change, and I think the criteria are close to satisfied
already.** The evidence for that is §3.3: nine of ten core facades already build entirely
free of the client, the model runner is already not a dependency, the built artifact
already runs with no `node_modules` and no keys, an install smoke already exists in the
release pipeline, a facade-parity harness already exists, and every TUI/streaming/cancel/
resume behaviour AC-19 names is already tested offline. What is genuinely missing is
small and specific: **one leaking facade, one missing package boundary declaration, one
missing fixture pair, and one missing gate separation.** A restructuring would be
answering a question nobody asked, and AC-20 says so in its own text.

Two honest caveats on that recommendation. First, `src/cli.ts` statically importing all
33 commands violates `implementation-plan.md` line 51 ("CLI help core не импортирует
client даже лениво до parser validation") — that is real, it is measured, and the
smallest change above does not fix it. It should be recorded as a known deviation with a
named owner, or scoped in deliberately; it should not be quietly folded into "packaging
is done". Second, `npm install --omit=optional` could not be exercised here (no network),
so the claim that a core-only install works is an inference from the offline artifact
run, not a measurement of npm's behaviour.

---

### 6. Proposed lanes

Packaging work touches shared files, so the parallelism here is real but narrow. Three
lanes; **A and C are genuinely parallel and file-disjoint; B must follow A.**

**Lane A — unhook the SAC facade from the provider registry.** *No dependencies. Parallel with C.*
Owns: `src/sac/service.ts`, `src/sac/workspace-resolve.ts`, `src/sac/machine-wrap-up.ts`,
`src/sac/decision-dedup.ts`, `src/session/external-slate.ts`, and their co-located tests.
Introduce a single-turn port injected by the caller (or a lazy `await import()`, matching
the sanctioned optional-dep seam). Exit: a build seeded from all ten `service.ts` facades
emits zero modules from `harness/`, `session/`, `tui/`, `commands/`, `mcp-client/`,
`agents/`. Optional, same lane if cheap: relocate `harness/tool/metaproject-adapter.ts`
below both consumers.

**Lane C — import policy with fixtures, and sentinels on the guards that exist.** *No dependencies. Parallel with A.*
Owns: a new import-policy module + test + a `fixtures/import-policy/` pair (one forbidden,
one allowed); edits to `src/mcp/boundary.test.ts`, `src/capability/no-optional-imports.test.ts`,
`src/gdgraph/treesitter/no-treesitter-import.test.ts` to assert scanned-file counts; and
the dead `resolveSources` export in `src/lib/production-graph.test.ts` (either give it the
test its comment claims, or delete it). Touches no file Lane A touches. The one shared
artefact is the zone table (which directories are core/client/adapter) — agree it as a
data constant **before** either lane starts, then neither lane edits the other's files.

**Lane B — the package boundary, the core-only proof, and the gate split.** *Depends on Lane A. Cannot start GREEN before A lands; its RED tests can be written in parallel.*
Owns: `package.json` (`exports` map, a `src/core.ts` entry, `files` narrowed so
`src/gdgraph/*.test.ts` stops shipping, a `test:client` script), `src/core.ts` (new), a new
packaging test asserting the core entry's bundler graph is client-free, `.github/workflows/ci.yml`
(separate core and client jobs), `.github/workflows/release.yml` (an `--omit=optional`
install smoke). **The client-matrix work is inside this lane, not a fourth lane**: a
separate matrix lane would own `package.json` and `ci.yml` too, and would collide on
every write. It is not worth splitting for the sake of a lane count.

Sequence: **A ∥ C → B**. Do not attempt a fourth parallel lane; there is no fourth
disjoint file set here.

---

### 7. What was written during this inventory

- This section of `context.md`. Nothing else in `src/`, `scripts/`, `docs/` or
  `.metaproject/` was modified.
- Incidental, by the mandated routing layer: `keryx ctx run` / `keryx ctx rg` wrote raw
  logs and summaries under `.metaproject/data/gdctx/raw/` and
  `.metaproject/data/gdctx/artifacts/`. That is the routing layer's normal behaviour, not
  an edit to project content, but it is recorded here because those paths are tracked.
- Scratchpad only (outside the repository): probe entry points, an import-edge scanner, a
  sourcemap analyser, and two bundler outputs. No repository build directory was touched;
  every probe build wrote to the scratchpad, never to `./dist`.

Routing audit: `graph_used: no` (the gdgraph snapshot predates this session's heavily
dirty tree, and every structural question here needed the working tree and the bundler,
which were queried directly); `wiki_used: no` (not-relevant — the questions are about
packaging and import direction, which the normative spec under `docs/requirements/` and
the source answer directly); `ctx_used: yes` (all reads, searches and command output);
`raw_rg_used: no`.
