# Flow 059 — OpenTUI Phase 0 Spike Report

Executes Phase 0 of `docs/requirements/keryx-opentui-shell`. Platform: darwin-arm64,
bun 1.3.14. Package: `@opentui/core@0.4.5`.

## Verdict: **GO** — with one conscious decision to ratify (dependency surface).

OpenTUI is technically an excellent fit; every `(SPIKE)` unknown in the spec
resolved favourably. The single real gate is not technical — it is keryx's pinned
lean-dependency invariant (AC15). Phase 1 must ratify expanding that set.

## R1 — Native install (GATE): PASS
- `bun add @opentui/core` installed in ~6s; prebuilt native binary
  `@opentui/core-darwin-arm64/libopentui.dylib` pulled as an optionalDependency.
  **No Zig toolchain required.**
- `import("@opentui/core")` resolves the native binding (257 exports) — runtime
  load confirmed.
- Caveat to verify in Phase 1: prebuilt-binary coverage for linux-x64/arm64 and
  that `scripts/install.sh --global` pulls the platform binary on those targets.

## R2 — Inline vs full-screen + scrollback: RESOLVED (configurable)
- `CliRendererConfig.screenMode: "alternate-screen" | "main-screen" | "split-footer"`.
- **`split-footer`** = a fixed footer composer over a scrolling main region — exactly
  the conventional terminal-agent layout, and the mode we should adopt (preserves the main-screen
  transcript rather than a full alt-screen takeover). `footerHeight`, `exitOnCtrlC`,
  `exitSignals`, `clearOnShutdown`, `onDestroy` are all configurable.

## R3 — Component/keyboard API: MAPPED (all primitives exist)
| Spec `(SPIKE)` need | Real `@opentui/core` export |
|---|---|
| text input | `InputRenderable` (events `input`/`change`/`enter`, `.value`, `.focus()`) |
| select/list dropdown | `SelectRenderable` — options are `{name, description, value?}` (matches our command registry 1:1) |
| scrollable region | `ScrollBoxRenderable` / `ScrollBarRenderable` |
| box/text/layout | `BoxRenderable`, `TextRenderable`, Yoga flexbox (`flexGrow`/`flexDirection`/`padding`/`gap`) |
| markdown (bonus) | `MarkdownRenderable`, `Code`/`TreeSitterClient` syntax highlighting |
| keyboard/focus | `KeyHandler` (`renderer.keyInput`), `parseKeypress`, `Renderable.focus()/blur()` |
| renderer | `createCliRenderer(config)` → `CliRenderer`; `renderer.root.add(node)` |

## R4 — License: PASS — **MIT**.

## R5 — Cold start: acceptable (headless proof runs in ~150ms incl. native init).
Real interactive cold-start on a TTY to be timed in Phase 1.

## Headless testability (N2): PROVEN
`@opentui/core/testing` ships `createTestRenderer({width,height})` →
`{ renderer, mockInput, renderOnce, flush, captureCharFrame, waitForFrame, resize }`.
Two headless tests (`src/tui/spike.test.ts`) pass:
- `SelectRenderable` renders the slash-command options (frame contains `/help`,`/expand`).
- `InputRenderable` accepts `mockInput.pressKeys(["/","h","e","l","p"])` → `.value === "/help"`.
This is the migration's unit-test pattern — the TUI is testable without a real TTY.

## Proof-of-shape: `keryx shell --tui` skeleton
`src/tui/tui-shell.ts` `launchTuiShell()` builds a `split-footer` transcript +
composer + a `/`-triggered command dropdown; wired in `shellCommand` behind `--tui`.
Fallback is proven: on no-TTY (piped) it returns `false` and the readline shell
runs normally (verified). Interactive look on a real terminal is the user's to run.

## THE decision — keryx's pinned dependency surface (AC15)
- keryx enforces: `dependencies == {}` (zero runtime deps) and
  `optionalDependencies` pinned EXACTLY to `@modelcontextprotocol/sdk` +
  `web-tree-sitter` (`src/testing/block-d-no-network.test.ts` AC15;
  `src/capability/no-optional-imports.test.ts`).
- The clean integration path (PROVEN on the spike branch) is: `@opentui/core` in
  **optionalDependencies** + **dynamic `import()`** only + graceful fallback — this
  passes the zero-dep floor and the no-top-level-import guard.
- The ONE remaining gate is AC15's exact-list assertion. Adding `@opentui/core`
  means consciously expanding the pinned optional set. OpenTUI would be keryx's
  first UI-facing native optional dependency (a `libopentui.dylib` per platform).

## Recommendation
1. **GO** on OpenTUI via `optionalDependencies` + dynamic import + fallback.
2. Phase 1 opens with an **ADR + AC15 update** ratifying the dependency-surface
   expansion (and its platform-binary/portability implications), BEFORE wiring the
   real shell. Record the decision in memory.
3. Adopt `screenMode: "split-footer"`; reuse the pure render helpers; keep the
   readline shell as the guaranteed fallback until parity sign-off.
4. NOT merged to main this flow: the dependency + `--tui` code stay on branch
   `spike/059-opentui-shell` as evidence; only this report + the flow package land
   on main (main keeps its zero-dep floor intact).
