# Context

Collected deterministically by `keryx flow init` at 2026-10-20T07:58:39.137Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.65] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
2. [1.642] Theme switch repaints already-rendered chrome via old-slot value matching (lesson/accepted) - lessons/theme-switch-repaint.md
   `/theme` in the OpenTUI shell applied and persisted correctly on 0.2.66, but `applyTheme` (src/tui/shell-chrome.ts) only recolored the chrome's OWN surfaces (renderer background, sidebar border, docks, composer, `/`-menu). Every renderable painted EARLIER with `getTheme()` — transcript frames (user echoes, code-segment boxes, block bodies, side-worker boxes), tone-colored block headers (`theme.error`/`theme.tool`), dock/queue-dock buttons, sidebar panels — kept the old palette's hex in its `borderColor`/`backgroundColor`/`fg` props, so a dark→dark switch (groknight↔tokyonight) looked like "the theme did not apply". Fix: on every `applyTheme`, walk the renderable trees (transcript, docks, sidebarTop, menu, composer, header, footer) and rewrite any prop whose color equals an OLD theme slot hex to the NEW slot hex.
   claimType: lesson | confidence: high | version: 0.2.0
   scope: module:src/tui, entity:shell-chrome.ts
   provenance: source=manual link=unknown author=unknown confirmedBy=unknown
3. [1.605] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
4. [1.572] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
5. [1.551] A shell allowlist matched against the raw command string is not a security boundary (lesson/accepted) - lessons/allowlist-not-a-boundary.md
   A remembered glob pattern that is matched against a command string which is then handed to `/bin/sh -c` grants far more than it appears to. The pattern matches text; the shell re-interprets that text. Verified, not theorised: a live allowlist contained `bash *`, `python3 *`, `curl *`, `cd *`, `# *`, `docker *`, `sudo *`, and the exact string `rm -rf /` — each an arbitrary-execution grant that auto-approved with no prompt.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:src/lib, src/commands, src/tui, entity:shell-permissions, command-risk, approval gate
   provenance: source=flow 115 (shell approval hardening), stress reports in `.metaproject/data/stress/` link=docs/decisions/keryx-harness/ADR-0009-destructive-command-escalation.md author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-10-06T09:19:55.947Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

Prior flows on these surfaces: 074 (sidebar), 266 (scrollable sidebar — code shipped, still `in-progress` only for a missing review round), 300 (sidebar + modals for governance/triggers), 305 (routing table + `/routing` modal), 309 (live model catalog for the routing picker).

### /routing (root cause, verified 2026-10-20)

**Primary cause.** The startup catalog refresh runs over an EMPTY provider list, saves that as a fresh cache, and `/routing` trusts the cache. Verified in code and on disk:

1. With a saved provider+model (the operator's case) or `--provider X --model Y`, `resolveTuiStartup` returns `detected: []` and skips detection (`src/commands/shell.ts:3356-3381`).
2. `tui-shell.ts:4179` runs `loadOrRefreshProviderCatalogFromDetected(opts.detected, …)` with that `[]`. `refreshProviderCatalogFromDetected` (`src/harness/provider-catalog.ts:209-221`) maps zero entries, and `:255-256` saves `{providers: {}}` as the fresh cache.
3. On disk: `~/.local/share/keryx/provider-catalog.json` is 65 bytes, written 11:48 at that session's start, `providers: {}`. Yet the user config holds an openai-codex OAuth grant, API keys for three more providers, and grok and github-copilot grants (names only; no values read).
4. `/routing` (`tui-shell.ts:7443-7453`) passes no providers, so `routing-inspector.ts:201` → `loadRoutingProviders` (`:463-468`) → `loadOrRefreshProviderCatalog`, which serves the cache while `isCatalogFresh` holds. That check is age-only (TTL 5 min, `provider-catalog-cache.ts:55`) and ignores emptiness. Every shell start re-poisons the cache, so this looks intermittent.
5. `/model` works in the same session because it calls `opts.redetect()` (`tui-shell.ts:9512, 10412-10438`; `shell.ts:4296`), a live detect that never reads the cache.

**How the symptoms follow.**
- Model tab: `flatModelOptions` (`src/harness/routing/table.ts:329-349`) always emits "session default" first, so with zero providers that row is all that remains. The `emptyLabel: "(no connected providers)"` (`routing-inspector.ts:384`) can never fire, and no failure is visible.
- Categories tab: `connectedPredicateFrom` (`table.ts:217-231`) means "present in the list I was handed", so with `[]` every provider is "not connected". The gpt-6.1-sol / gpt-6-luna / gpt-6-astra entries are the operator's own saved user-layer assignments, not a hard-coded tier table. `resolveCategoryDetailed` (`table.ts:173-199`) rejects them and falls back to `default`.

**Secondary defects on the same path.**
- (A) No visible empty or failed state anywhere in the modal. The startup notice (`tui-shell.ts:6746-6758`) covers only per-provider auth-failed/unreachable/timeout.
- (B) A zero-provider catalog is cached as fresh.
- (C) `reload()` (`routing-inspector.ts:260-283`) has no try/catch or timeout: a rejecting load leaves "Reading routing table…" forever.
- (D) An openai-codex entry is dropped silently when its grant is missing (`provider-catalog.ts:109-113`), and `auth-failed` entries are excluded with no explanation (`:268-284`).
- (E) Flows 305 and 309 were tested only with a non-empty injected `detected`. `provider-catalog-startup.test.ts:39` pattern-matches source text and covers no behaviour.

Not a defect: `writePick` (`routing-inspector.ts:285-291`) does persist a pick. "Session default" was simply the only option.

Tests to extend: `src/harness/provider-catalog.test.ts`, `src/tui/routing-inspector.test.ts`, `src/tui/provider-catalog-startup.test.ts`, `src/harness/routing/table.test.ts`.

### /setup (investigation 2026-10-20, read-only)

- Opening: `openSetup` (`src/tui/tui-shell.ts:6217-6228`) → `parseSetupArgs` (`src/commands/setup-guide.ts:161`) → `openSetupModal` (`src/tui/setup-modal.ts:58-77`), one tab per `SETUP_SCENARIOS` entry (init, refresh, repair).
- Why Init showed: nothing detects `.metaproject/`. Without an argument no `initialTab` is passed and `resolveInitialTab` (`modal-host.ts:281-290`) takes the first tab.
- Why it is hard to read: `setup-modal.ts:55` wraps the whole body in `dimChunk` (terminal DIM over the text colour on dark themes, `theme-text.ts:40-44`). Readable modals keep `dimChunk` for secondary bits only (`settings-modal.ts:135-161`, `governance-inspector.ts:259`).
- Why the prompt seems missing: the body is one `TextRenderable` windowed to `bodyRows = min(24, rendererHeight - 8)` (`setup-modal.ts:35, 49-56`). Steps 6–7 and the existing "Ask the agent" prompt (`setup-guide.ts:213-215`) sit below the fold, reachable only with ↑/↓. The modal also ignores `renderTab`'s `ctx.width` (uses `renderer.width - 8`), and the keys hint is printed twice (body + footer).
- Steps are incomplete: every listed command exists with correct flags, but whole steps are missing.
  - `init --yes` already installs hooks, registers the project, runs `test analyze` and builds the dashboard (`init.ts:248-882`).
  - `update` (`update.ts:222`) refuses without `.metaproject`, and fetches the runtime unless `--skip-runtime`. It exits 1 on a divergent lifecycle file unless `--accept-version`/`--keep-existing`, and prompts on stale worktrees unless `--yes`.
  - `update --preview`, `doctor`, `modules enable`, `sync install-hooks`, `integrate <editor>`, `security hooks install`, `skills install`, `rules sync` and `version check` appear in no scenario.
  - `wiki validate` exists but is hidden from `--help`.
- Full step lists per tab with required/optional marks: see the plan.
- Reusable UI:
  - Buttons: `smallActionButton` (`src/tui/action-button.ts:22`), as in `settings-modal.ts:164-177`, with keyboard parity at `:238-249`.
  - Copy: `r.copyToClipboardOSC52` + `chrome.showToast("Copied to clipboard")` (`tui-shell.ts:4936`); precedent in `session-info.ts:326-343`.
  - Confirm card: `confirmOperatorCard` (`tui-shell.ts:5421`).
  - Layout: there is no side-panel slot, so the button column is a row Box inside `renderTab`'s body. The host closes on bare `x` (`modal-host.ts:574`).
- Run mechanism:
  - `spawn_subagent` children have NO `shell_exec` in either native mode (`spawn-subagent-tool.ts:1076-1078, 1768-1774`), so they cannot run `keryx update`/`sync`.
  - Viable options:
    - external delegate (`external.delegate`, `/delegate` → `runDelegate`, `tui-shell.ts:4794-4823`): a real CLI agent with a shell, shown in the fleet, needs an external agent configured;
    - the main agent turn (`runLine(prompt)`, `tui-shell.ts:8508`): uses the normal approval gate and the sidebar plan via `plan_set`, but blocks the composer;
    - the deterministic job registry (`background-job-registry.ts:240`): no model, per-step cancel, already shown as Background Jobs.
- Tests coupled to today's text: `src/commands/setup-guide.test.ts` (step `cli` starts with `keryx `, prompts contain "commit", "Do not enrich wiki prose", "Do not delete .metaproject", rendered text contains "This guide only prints the steps.") and `src/tui/setup-modal.test.ts` (scroll test asserts `top[0] === SETUP_MODAL_KEYS` and the last line text).
- Safety: never exercise `init`/`update`/`sync --apply` against this repo's real `.metaproject/` — use a scratch project under `.claude/worktrees/` (memory: dev-checkout-vs-installed-keryx-diverged).

### Sidebar (investigation 2026-10-20, read-only)

- Layout: `src/tui/shell-chrome.ts:641-716` — `sidebar` box, fixed `SIDEBAR_WIDTH = 34` (`sidebar-metrics.ts:19`, fixed on purpose so the transcript edge does not move), text width 30 (`shell-chrome.ts:107-121`). `sb-top` is a ScrollBox; `sb-spacer` and the toast are pinned outside it.
- The title `sb-title` ("keryx" + dim version) is built by `mountTitlePanel` (`tui-shell.ts:1303-1310`) INSIDE the scrollbox, so it scrolls away. Header buttons need a new pinned row above `sb-top`. Keep the id `sb-title` (flow 266 tests).
- ~28 sections mount in fixed order from `tui-shell.ts:4293` to `4644`, each its own Box with its own painter and theme listener. No shared card abstraction. Worst cases: Reviews (`reviews-inspector.ts:309`, layer/parity/readiness paragraphs wrapped to 30 cols, 25+ rows), Status fleet (~14), Subagents/Jobs (unbounded), Plan (9).
- Detail targets exist for almost every section (`showWorkspace`, `showReviews`, `showRemoteControl`, `showChannels`, `showTools`, `openExecutionPlanInspector`, `/governance`, `/decisions`, …). Missing a click target: Route (`tui-shell.ts:5161`, though `showRouting` exists at `:7443`), Model (`/model` exists), Usage, Context, Directory/Branch/PR, Status.
- Clicks: `onMouseDown` on renderables (e.g. `tui-shell.ts:4304`, `modal-host.ts:317`/`472`); tests drive them with `h.mockMouse.click` (`shell-chrome.test.ts:1055-1093`). Bubbling from a child Text to a parent Box is unverified.
- Width is a number frozen at mount in ~17 call sites (`tui-shell.ts:4503…4693`, `shortenCwd` calls) plus default params in `subagent-session.ts:112`, `background-job-session.ts:86`, `subagent-inspector.ts:228`, `background-job-inspector.ts:305`. No resize handler outside `renderer-debug.ts:266`.
- Modals: `openModal` (`modal-host.ts:693`), 95% of the available `main` width, min 72 cols, clamped (`:705`); the backdrop mounts in `main` (`:520`), mount point fixed at first open. A 2× sidebar on a ~100-col terminal leaves `main` ≈ 32 cols — the modal is squeezed.
- Theme: `applyTheme` (`shell-chrome.ts:1487-1536`) recolors `sidebarTop` only via `recolorThemeTree`; a pinned header or rail needs its own recolor. Panels use `guardedThemeRepaint` (`theme-repaint.ts:18`).
- Persistence: `~/.keryx/tui.json` holds only `{theme}`; `persistThemeId` overwrites the whole file (`theme.ts:503`), so a new `sidebar` key would be wiped by `/theme` unless it becomes read-merge-write.
- Layout constraints: no `alignSelf` in `src/tui/**` (`capability/tui-layout.test.ts`, memory lesson), hug with `maxWidth`; the 80×24 pty smoke (`shell-pty-launch.smoke.test.ts`) guards that Model/Tools labels stay visible; no top-level `@opentui/core` import in new files (`capability/no-optional-imports.test.ts`).
- Glyphs in use: ◆ ◇ ▶ ○ ● ◐ ◼ ◌ ✓ ! − ↑ ↓. `displayWidth` (`lib/live-render.ts:53`) is not a full Unicode width table; new icons need a width assertion and an ASCII fallback.
- Tests today: `shell-chrome.test.ts`, `tui-shell.test.ts`, `modal-host.test.ts`, the per-panel `*-panel`/`*-surface`/`*-inspector` tests, `shell-pty-launch.smoke.test.ts`, `capability/tui-layout.test.ts`.
