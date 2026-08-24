// The mode-agnostic OpenTUI shell chrome (flow 112, plan S1).
//
// Everything `launchTuiAgentShell` builds that does not know what a tool is:
// the rootRow / main / sidebar / header / transcript / dock / `/`-menu /
// composer / footer layout, the toast, the busy spinner, the overlay guard and
// the `/`-menu key router. The agent shell (S2) and the chat driver (S3) both
// mount THIS and add only their own concerns on top, so the two surfaces cannot
// drift apart by construction.
//
// Why an object and not a base class: D-A1 — the closure's coupling is data, not
// behaviour, so explicit fields are testable without an inheritance hierarchy
// over renderables.
//
// **Construction order is the point of this module.** The pre-extraction closure
// forward-declared four mutable bindings and rewired them 100-400 lines later,
// so anything firing in between was silently dropped:
//
//   - `showToast` was a no-op until the sidebar toast existed, yet the
//     copy-on-select handler could already fire → here the toast slot is built
//     BEFORE the selection handler subscribes, so `showToast` is real from its
//     first call.
//   - `clearBusyTimer` was assigned only once the spinner existed → here it is
//     part of {@link ShellChrome.destroy}, defined after the spinner, and the
//     renderer teardown calls `destroy()` instead of an optional binding.
//   - `setBusyPhase` was a no-op until the footer existed, so an early
//     `onReasoning` painted nothing → here the footer is built before the chrome
//     object is returned, and the IO hooks that call it are wired by the CALLER,
//     necessarily after this factory has returned.
//   - `createBlockNavController` closed over `menu` / `menuNav` /
//     `overlayActive` / `input` / `textarea`, all declared later → those are now
//     chrome fields (`menu`, `menuActive()`, `overlayActive()`, `input`,
//     `textarea`), so the controller is built after them and closes over nothing
//     that does not yet exist.
//
// Two cycles are real and are explicit registration points rather than rebound
// `let`s — see {@link ShellChrome.addOverlaySource} and
// {@link ShellChrome.setFooterOverride}.
//
// `@opentui/core` is an OPTIONAL dependency (ADR-0005): it is referenced here
// ONLY structurally, through `typeof import(...)`, and the renderer plus the
// module object arrive as parameters. There is no top-level import of it (the
// static guard in `src/capability/no-optional-imports` is a regex over file
// text, so the forbidden form must not appear in a comment either).
import type { SlashCommandOption } from "../commands/agent-commands";
import { formatVersionUpdateAdvisory, type VersionCheckResult } from "../lib/version-check";
import { getTheme, onThemeChange, type Theme } from "./theme";
import { destroyModalHost } from "./modal-host";

/** The `@opentui/core` module shape, referenced structurally (type-only). */
type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type ScrollBox = InstanceType<OpenTui["ScrollBoxRenderable"]>;
type Select = InstanceType<OpenTui["SelectRenderable"]>;
type Textarea = InstanceType<OpenTui["TextareaRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;
/** Plain text or an OpenTUI styled template. */
type StyledContent = string | ReturnType<OpenTui["t"]>;

/** OpenTUI keypress event fields the `/`-menu router reads. */
type KeypressEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  sequence: string;
  preventDefault: () => void;
  stopPropagation: () => void;
};

/**
 * Subscribe to OpenTUI's internal keypress stream; returns an unsubscribe fn.
 * Declared locally (as `composer-choice.ts` already does) rather than imported
 * from `tui-shell.ts`: that module will import THIS one after S2, and the repo
 * has already been bitten by `@opentui/core` module cycles.
 */
function onKeypress(r: Renderer, handler: (key: KeypressEvent) => void): () => void {
  r._internalKeyInput.onInternal("keypress", handler);
  return () => r._internalKeyInput.offInternal("keypress", handler);
}

/**
 * Composer grows 1…max rows with wrap; beyond max the textarea scrolls.
 * Exported because {@link composerHeightForLines} is: the clamp that ships is
 * the one the tests must pin (a second copy in `tui-shell.ts` used to be the
 * tested one while THIS one — the only live caller — went unguarded).
 */
export const COMPOSER_MIN_ROWS = 1;
/** Fallback cap when the viewport height is unknown (tests / no renderer). */
export const COMPOSER_MAX_ROWS = 6;
/** Rounded border adds one row above and below the textarea. */
const COMPOSER_BORDER_ROWS = 2;
/** Rows the `/` dropdown occupies when open (a described option costs two). */
const MENU_HEIGHT = 10;
/** Sidebar is a fixed column so the transcript width does not jump. */
const SIDEBAR_WIDTH = 30;
const SIDEBAR_BORDER_LEFT = 1;
const SIDEBAR_PADDING_LEFT = 2;
const SIDEBAR_PADDING_RIGHT = 1;
/**
 * Columns a sidebar panel's TEXT actually gets: the fixed width less the left
 * border and the horizontal padding (30 - 1 - 2 - 1 = 26). Derived from the very
 * constants the sidebar box below is built from, so a caller that fits a label to
 * this budget cannot drift from the layout — and exported because a caller has
 * to shorten to it: the working directory (`shortenCwd`, `tui-shell.ts`) does not
 * fit in 26 columns and must be told how much room it has, not guess.
 */
export const SIDEBAR_TEXT_WIDTH =
  SIDEBAR_WIDTH - SIDEBAR_BORDER_LEFT - SIDEBAR_PADDING_LEFT - SIDEBAR_PADDING_RIGHT;

/** Keep the fixed install command complete while fitting it on two sidebar rows. */
export function formatSidebarVersionUpdateAdvisory(
  result: VersionCheckResult,
): string | undefined {
  const advisory = formatVersionUpdateAdvisory(result);
  if (advisory === undefined || result.status !== "update-available") return undefined;
  const split = Math.ceil(result.installCommand.length / 2);
  return advisory.replace(
    result.installCommand,
    `${result.installCommand.slice(0, split)}\n${result.installCommand.slice(split)}`,
  );
}
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_MS = 120;
const TOAST_MS = 5000;

/**
 * Pure: clamp visual line count into the composer height band. Exported so the
 * clamp {@link ShellChrome.syncComposerHeight} actually calls is the one under
 * test. `maxRows` defaults to {@link COMPOSER_MAX_ROWS}; the live chrome passes
 * one third of the viewport.
 */
export function composerHeightForLines(visualLines: number, maxRows: number = COMPOSER_MAX_ROWS): number {
  const cap =
    Number.isFinite(maxRows) && maxRows >= COMPOSER_MIN_ROWS ? Math.floor(maxRows) : COMPOSER_MAX_ROWS;
  const n = Number.isFinite(visualLines) ? Math.floor(visualLines) : COMPOSER_MIN_ROWS;
  return Math.min(cap, Math.max(COMPOSER_MIN_ROWS, n < 1 ? COMPOSER_MIN_ROWS : n));
}

/** Live composer cap: at least one row, at most one third of the terminal. */
export function composerMaxRowsForViewport(viewportRows: number): number {
  if (!Number.isFinite(viewportRows) || viewportRows < 1) {
    return COMPOSER_MAX_ROWS;
  }
  return Math.max(COMPOSER_MIN_ROWS, Math.floor(viewportRows / 3));
}

/**
 * Normalize a renderable's color prop to a lowercase `#rrggbb` hex so a theme
 * slot lookup can compare it. OpenTUI stores colors as parsed RGBA objects
 * (its setters parse the hex strings the shell writes), so a read of
 * `borderColor` / `backgroundColor` / `fg` is an object with `toInts()`, not
 * the original string. Non-opaque colors (`transparent`, the default) are
 * deliberately skipped — they are not theme slot hexes.
 */
export function themeColorToHex(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { toInts?: unknown }).toInts === "function"
  ) {
    const [r, g, b, a] = (value as { toInts(): [number, number, number, number] }).toInts();
    if (a !== 255) {
      return undefined;
    }
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  }
  return undefined;
}

/**
 * Old→new hex map over every color slot of a theme switch. `name` is a
 * label, not a color. The map feeds {@link recolorThemeTree} so a `/theme`
 * switch repaints every renderable the shell painted with the OLD palette —
 * not just the chrome's own surfaces listed in `applyTheme` below.
 *
 * Why value matching is safe: the shell writes theme slot hexes into
 * renderable `borderColor` / `backgroundColor` / `fg` props and nothing else
 * (OpenTUI's dim/bold/cyan/green/red styling lives inside styled CHUNKS of
 * `content`, which the walk deliberately leaves alone), so a prop whose hex
 * equals an old slot value is by construction a theme-painted element.
 */
function themeColorRemap(from: Theme, to: Theme): Map<string, string> {
  const remap = new Map<string, string>();
  for (const slot of Object.keys(from) as ReadonlyArray<keyof Theme>) {
    if (slot === "name") {
      continue;
    }
    const oldColor = from[slot];
    const newColor = to[slot];
    if (typeof oldColor === "string" && typeof newColor === "string" && oldColor !== newColor) {
      remap.set(oldColor, newColor);
    }
  }
  return remap;
}

type ThemePainted = {
  borderColor?: unknown;
  backgroundColor?: unknown;
  fg?: unknown;
  getChildren?: () => readonly unknown[];
};

/**
 * Recolor one renderable and its descendants from the old→new slot map: any
 * `borderColor` / `backgroundColor` / `fg` whose color equals an old slot
 * value becomes the new slot's hex (written as a string — the renderable's
 * setter parses it), then recurse into children. Idempotent — a second pass
 * with the same map finds nothing, so overlapping container walks (a box
 * walked both directly and through a parent) are harmless.
 *
 * Covers what `applyTheme`'s explicit list cannot know: transcript frames
 * (user echoes, code segments, block bodies, side-worker boxes), tone-colored
 * block headers (`theme.error` / `theme.tool`), dock/queue-dock buttons and
 * sidebar panels painted with `getTheme()` at creation time.
 */
function recolorThemeTree(node: unknown, remap: Map<string, string>): void {
  if (node === null || node === undefined) {
    return;
  }
  const target = node as ThemePainted;
  for (const prop of ["borderColor", "backgroundColor", "fg"] as const) {
    const hex = themeColorToHex(target[prop]);
    if (hex !== undefined) {
      const next = remap.get(hex);
      if (next !== undefined) {
        target[prop] = next;
      }
    }
  }
  if (typeof target.getChildren === "function") {
    for (const child of target.getChildren()) {
      recolorThemeTree(child, remap);
    }
  }
}

/**
 * Soft-wrap estimate for a single paragraph at `width` columns (char wrap).
 * Used when OpenTUI's `virtualLineCount` has not yet seen a finite width.
 */
export function wrappedLineCount(text: string, width: number): number {
  const inner = Number.isFinite(width) ? Math.floor(width) : 0;
  const paragraphs = text.length === 0 ? [""] : text.split("\n");
  if (inner < 1) {
    return Math.max(COMPOSER_MIN_ROWS, paragraphs.length);
  }
  let total = 0;
  for (const paragraph of paragraphs) {
    total += Math.max(1, Math.ceil(Math.max(paragraph.length, 1) / inner));
  }
  return total;
}

/**
 * Prefix-filter `commands` by a composer query. `[]` when the query is not a
 * slash query; `/` alone returns all of them. Mirrors `filterCommands`
 * (`commands/agent-commands.ts`) but over the chrome's OWN list, because the
 * chrome may be mounted with a mode's subset. The real shells override it via
 * {@link ShellChromeOptions.filterCommands} with the mode-aware registry (S4);
 * this fallback keeps the chrome mountable on its own in tests. Not trimmed —
 * see `filterCommands`'s own note on why a trailing space must never match.
 * Pure.
 */
function prefixFilter(commands: readonly SlashCommandOption[], query: string): SlashCommandOption[] {
  const q = query.toLowerCase();
  if (!q.startsWith("/")) {
    return [];
  }
  const needle = q.slice(1);
  return commands.filter((c) => c.name.slice(1).toLowerCase().startsWith(needle));
}

/** The composer handle: `.value` / `.focus()` over the underlying Textarea. */
export interface ComposerInput {
  value: string;
  focus(): void;
}

/** Everything the chrome needs that differs between the agent and chat modes. */
export interface ShellChromeOptions {
  /** Header identity line, e.g. `keryx · agent · anthropic/sonnet`. */
  title: string;
  /** Footer right-hand label, e.g. `provider/model`. */
  status: string;
  /** Footer left-hand hint shown whenever the shell is idle. */
  footerHint: string;
  /** Composer placeholder. */
  placeholder: string;
  /** Slash commands offered by the `/` dropdown, in menu order. */
  commands: readonly SlashCommandOption[];
  /** Header right-hand slot (token counter). Empty by default. */
  headerMeta?: string | undefined;
  /** Toast auto-clear window in ms (default 5000). */
  toastMs?: number | undefined;
  /** Menu filter override; defaults to a prefix match over `commands`. */
  filterCommands?: ((query: string) => readonly SlashCommandOption[]) | undefined;
  /** One shell-scoped, already-started advisory check. Never awaited by chrome. */
  versionCheck?: Promise<VersionCheckResult> | undefined;
  /** Current permission mode (ask/trust/auto), shown in the footer's right slot while busy. */
  permissionMode?: (() => string | undefined) | undefined;
}

/**
 * The mounted chrome: renderables the caller renders into, plus the behaviour
 * that used to be trapped in the closure. Every field is live from the moment
 * this object exists — there are no placeholders to rebind (AC2).
 */
export interface ShellChrome {
  /** The renderer this chrome was mounted on. */
  readonly renderer: Renderer;
  /** Root row: `main` + `sidebar`. */
  readonly root: Box;
  /** Left column: header, transcript, queue dock, dock, menu, composer, footer. */
  readonly main: Box;
  /** Right status column: `sidebarTop`, a spacer, then the pinned toast. */
  readonly sidebar: Box;
  /**
   * Where caller-owned sidebar panels (model, context, tools, workers) go. A
   * dedicated slot because the toast is pinned to the BOTTOM by a `flexGrow`
   * spacer: anything added to `sidebar` itself would land under that spacer,
   * beside the toast, instead of at the top.
   */
  readonly sidebarTop: Box;
  readonly header: Box;
  readonly scroll: ScrollBox;
  /** The scrollbox content the IO renders into. */
  readonly transcript: Box;
  /** Choice dock above the composer (`showComposerChoice` mounts into it). */
  readonly dock: Box;
  /**
   * Persistent queue dock above `dock`, listing queued main-turn messages
   * (`paintMainQueue` in `tui-shell.ts` mounts into it). Unlike `dock` it is
   * multi-item and stays mounted for as long as the queue is non-empty
   * (`.visible` toggles with `mainQueue.length > 0`).
   */
  readonly queueDock: Box;
  readonly menu: Select;
  readonly composer: Box;
  readonly textarea: Textarea;
  readonly footer: Box;
  readonly input: ComposerInput;

  focusComposer(): void;
  blurComposer(): void;
  /** Recompute the composer height from its current wrapped line count. */
  syncComposerHeight(): void;

  /** True while the `/` dropdown is open AND owns the keyboard. */
  menuActive(): boolean;
  /** Close the dropdown and hand the keyboard back to the composer. */
  closeMenu(): void;
  /**
   * Hide the dropdown and release its keyboard claim WITHOUT clearing the
   * composer or grabbing focus — for callers about to raise an overlay (an
   * approval dock, `ask_user`, the resume picker) over a still-typed `/…`
   * query. Writing `chrome.menu.visible = false` instead leaves the private
   * `menuNav` true, and the next keystroke then reopens a VISIBLE BUT UNFOCUSED
   * menu. Idempotent.
   */
  hideMenu(): void;
  /** Re-run the menu filter against the current composer value. */
  refilterMenu(): void;

  /**
   * True while any overlay owns the keyboard: the dock, a `withOverlay` run, or
   * a registered source.
   */
  overlayActive(): boolean;
  /**
   * Register an extra overlay predicate; returns an unsubscribe fn. This is one
   * of the two REAL cycles: overlays the caller owns (a pending approval, a
   * full-screen picker) must suppress the chrome's own key router, but the
   * chrome cannot know about them. A registration function keeps the dependency
   * one-way instead of reintroducing a mutable binding rewired later.
   */
  addOverlaySource(isActive: () => boolean): () => void;
  /** Mark an overlay active for the duration of an async run. */
  withOverlay<T>(run: () => Promise<T>): Promise<T>;

  /** Transient `✓ msg` in the sidebar; replaces any pending toast. */
  showToast(message: string): void;
  /** Recolor chrome surfaces from the active theme. */
  applyTheme(theme?: Theme): void;

  /** Start the footer spinner + the in-transcript live status line. */
  startBusy(phase?: string): void;
  /** Stop the spinner, drop the live status line, restore the idle hint. */
  stopBusy(): void;
  /** Update the spinner phase; a no-op paint while idle. */
  setBusyPhase(phase: string): void;
  isBusy(): boolean;
  /** Repaint the footer status (after something changed the override). */
  repaintStatus(): void;
  /**
   * Override the footer's left hint while the callback returns content. The
   * second REAL cycle: block-nav mode owns the footer even mid-turn, and the
   * 120ms spinner interval would otherwise repaint over it — but block nav is
   * agent-specific and is built after the chrome. A setter keeps the arrow
   * pointing one way. Pass `undefined` to drop the override.
   */
  setFooterOverride(paint: (() => StyledContent | undefined) | undefined): void;

  setTitle(text: string): void;
  setStatus(text: string): void;
  setHeaderMeta(text: string): void;

  /** Subscribe to submitted lines (composer Enter + `/`-menu selection). */
  onSubmit(handler: (line: string) => void): () => void;

  /** Clear timers and drop the chrome's own listeners. */
  destroy(): void;
}

/**
 * Create the renderer the shell chrome expects: full-screen (own the alternate
 * screen buffer so prior scrollback is cleared on launch and restored on exit)
 * with mouse tracking on, because the alternate screen would otherwise disable
 * the terminal's native selection — copy-on-select is re-implemented over OSC52
 * inside {@link createShellChrome}. Split out of the shell so both modes boot
 * the renderer identically; the caller's `onDestroy` should call the chrome's
 * `destroy()`.
 */
export async function createShellRenderer(
  otui: OpenTui,
  opts: { onDestroy?: (() => void) | undefined } = {},
): Promise<Renderer> {
  return await otui.createCliRenderer({
    exitOnCtrlC: true,
    screenMode: "alternate-screen",
    clearOnShutdown: true,
    useMouse: true,
    backgroundColor: getTheme().bg,
    ...(opts.onDestroy !== undefined ? { onDestroy: opts.onDestroy } : {}),
  });
}

/**
 * Mount the chrome on `renderer` and return the live handle.
 *
 * The body reads top to bottom in the order the layout stacks, and that order is
 * load-bearing: each section only ever references what is already above it.
 */
export async function createShellChrome(
  otui: OpenTui,
  renderer: Renderer,
  opts: ShellChromeOptions,
): Promise<ShellChrome> {
  const r = renderer;
  const toastMs = opts.toastMs ?? TOAST_MS;
  const filter = opts.filterCommands ?? ((query: string) => prefixFilter(opts.commands, query));
  /** Unique suffix for generated renderable ids. */
  let uid = 0;
  let alive = true;
  /** The palette every currently-painted renderable was colored with. */
  let appliedTheme: Theme = getTheme();

  // --- layout skeleton ----------------------------------------------------
  // opencode-style: a main chat column on the left + a right status sidebar.
  const rootRow = new otui.BoxRenderable(r, { id: "root-row", flexGrow: 1, flexDirection: "row" });
  r.root.add(rootRow);
  const main = new otui.BoxRenderable(r, { id: "main", flexGrow: 1, minWidth: 0, flexDirection: "column" });
  rootRow.add(main);
  const sidebar = new otui.BoxRenderable(r, {
    id: "sidebar",
    width: SIDEBAR_WIDTH,
    flexShrink: 0,
    flexDirection: "column",
    border: ["left"],
    borderColor: getTheme().highlight,
    paddingLeft: SIDEBAR_PADDING_LEFT,
    paddingRight: SIDEBAR_PADDING_RIGHT,
    paddingTop: 1,
  });
  rootRow.add(sidebar);

  // --- toast, FIRST so `showToast` is never a no-op -----------------------
  // Pinned to the bottom of the sidebar; the spacer pushes it down and leaves
  // `sidebarTop` above it for the caller's panels (model, context, tools,
  // workers). Both slots exist from mount so the caller never has to insert
  // renderables around a spacer it does not own.
  const sidebarTop = new otui.BoxRenderable(r, { id: "sb-top", flexShrink: 0, flexDirection: "column" });
  sidebar.add(sidebarTop);
  if (opts.versionCheck !== undefined) {
    // Reserve the notice's position before callers append model/context/worker
    // panels. Late settlement then changes content in place instead of appending
    // below a full sidebar where the advisory can be clipped off-screen.
    const versionNotice = new otui.TextRenderable(r, {
      id: `sb-version-${uid++}`,
      content: "",
    });
    sidebarTop.add(versionNotice);
    void opts.versionCheck.then(
      (result) => {
        const advisory = formatSidebarVersionUpdateAdvisory(result);
        if (!alive || advisory === undefined) return;
        try {
          versionNotice.content = otui.t`${otui.yellow(advisory)}`;
        } catch {
          // The renderer may have been torn down between settlement and paint.
        }
      },
      () => {
        // The production service resolves typed unavailable, but an injected
        // promise is still prevented from becoming an unhandled rejection.
      },
    );
  }
  const sidebarSpacer = new otui.BoxRenderable(r, { id: "sb-spacer", flexGrow: 1 });
  sidebar.add(sidebarSpacer);
  const toastText = new otui.TextRenderable(r, { id: "sb-toast", content: "" });
  sidebar.add(toastText);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const clearToastTimer = (): void => {
    if (toastTimer !== undefined) {
      clearTimeout(toastTimer);
      toastTimer = undefined;
    }
  };
  const showToast = (message: string): void => {
    toastText.content = otui.t`${otui.green(`✓ ${message}`)}`;
    clearToastTimer();
    toastTimer = setTimeout(() => {
      toastText.content = "";
      toastTimer = undefined;
    }, toastMs);
  };

  // Copy-on-select (grok/opencode): a changed mouse selection is copied to the
  // SYSTEM clipboard over OSC52 (works locally and over SSH, if the terminal
  // permits clipboard access). Best-effort; any failure is ignored. Subscribed
  // AFTER `showToast` exists — the old closure's ordering bug in reverse.
  const onSelection = (): void => {
    try {
      const text = r.getSelection()?.getSelectedText() ?? "";
      if (text.length > 0) {
        r.copyToClipboardOSC52(text);
        showToast("Copied to clipboard");
      }
    } catch {
      // clipboard access not permitted — ignore
    }
  };
  r.on(otui.CliRenderEvents.SELECTION, onSelection);

  // --- header -------------------------------------------------------------
  // grok-style: identity on the left, a caller-owned meta slot on the right.
  const header = new otui.BoxRenderable(r, {
    id: "header",
    flexShrink: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const headerLeft = new otui.TextRenderable(r, { id: "header-left", content: otui.t`${otui.dim(opts.title)}` });
  header.add(headerLeft);
  const headerRight = new otui.TextRenderable(r, { id: "header-right", content: "" });
  header.add(headerRight);
  main.add(header);
  const paintDim = (target: Text, text: string): void => {
    target.content = text.length === 0 ? "" : otui.t`${otui.dim(text)}`;
  };
  paintDim(headerRight, opts.headerMeta ?? "");

  // --- transcript ---------------------------------------------------------
  // Scrollable and sticky-to-bottom so long conversations auto-follow; the IO
  // renders into `.content`.
  const scroll = new otui.ScrollBoxRenderable(r, {
    id: "transcript",
    flexGrow: 1,
    minHeight: 0,
    scrollY: true,
    stickyScroll: true,
    stickyStart: "bottom",
    contentOptions: { flexDirection: "column", paddingLeft: 1, paddingRight: 1 },
  });
  main.add(scroll);
  const transcript = scroll.content;

  /** In-transcript live status line; re-pinned to the END of the transcript on every add. */
  let liveStatus: Text | undefined;
  // The busy line used to be added FIRST and every later block landed BELOW it,
  // so it scrolled off the top while a turn streamed (user-reported: the line
  // "shows the overall state" yet drifts away). Patching transcript.add here
  // (the chrome owns the transcript) keeps the line the LAST child whenever
  // anything else is added: pull it out, append the new child, re-append the
  // status. Every caller — transcript.add(...) in tui-shell and the block
  // renderers — goes through this instance method, so pinning is free for all.
  const originalTranscriptAdd = transcript.add.bind(transcript);
  const originalTranscriptRemove = transcript.remove.bind(transcript);
  transcript.add = (child: unknown, index?: number): number => {
    if (liveStatus !== undefined && child !== liveStatus) {
      originalTranscriptRemove(liveStatus);
      const added = originalTranscriptAdd(child, index);
      originalTranscriptAdd(liveStatus);
      return added;
    }
    return originalTranscriptAdd(child, index);
  };

  // --- queue dock -----------------------------------------------------------
  // Persistent (not ephemeral like `dock` below): lists queued main-turn
  // messages so they stop being painted into `transcript` (flow 170). Mirrors
  // `dock`'s own styling below so the two docks read as one visual family, but
  // starts hidden — `paintMainQueue()` in tui-shell.ts flips `.visible` once
  // `mainQueue.length > 0`. Inserted between `scroll` and `dock` in add-order:
  // the passive queue reminder sits one step further from the composer than
  // the active choice dock.
  const queueDock = new otui.BoxRenderable(r, {
    id: "queue-dock",
    flexShrink: 0,
    flexDirection: "column",
    visible: false,
    backgroundColor: getTheme().panel,
    borderStyle: "rounded",
    border: true,
    borderColor: getTheme().border,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });
  main.add(queueDock);

  // --- bottom stack: dock, menu, composer ---------------------------------
  // Layout order = the visual bottom stack: dock and menu open *upward* into the
  // transcript, so they are added before the composer.
  const dock = new otui.BoxRenderable(r, {
    id: "choice-dock",
    flexShrink: 0,
    flexDirection: "column",
    visible: false,
    backgroundColor: getTheme().panel,
    borderStyle: "rounded",
    border: true,
    borderColor: getTheme().border,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });
  main.add(dock);

  // A picker/approval overlay owns the keyboard while it is up, so the `/`-menu
  // router below must stay inert. `dock.visible` covers every composer-dock menu;
  // `overlayDepth` covers `withOverlay` runs (the full-screen pickers live on
  // `r.root`); registered sources cover whatever the caller owns.
  let overlayDepth = 0;
  const overlaySources = new Set<() => boolean>();
  const overlayActive = (): boolean => {
    if (overlayDepth > 0 || dock.visible === true) {
      return true;
    }
    for (const isActive of overlaySources) {
      if (isActive()) {
        return true;
      }
    }
    return false;
  };
  const withOverlay = async <T>(run: () => Promise<T>): Promise<T> => {
    overlayDepth += 1;
    try {
      return await run();
    } finally {
      overlayDepth -= 1;
    }
  };
  const addOverlaySource = (isActive: () => boolean): (() => void) => {
    overlaySources.add(isActive);
    return () => {
      overlaySources.delete(isActive);
    };
  };

  // Live `/` command dropdown (Pi/grok-style): a Select filtered as the composer
  // changes.
  const menu = new otui.SelectRenderable(r, {
    id: "menu",
    flexShrink: 0,
    height: MENU_HEIGHT,
    visible: false,
    options: [...opts.commands],
    showScrollIndicator: true,
    wrapSelection: true,
    backgroundColor: getTheme().panel,
    focusedBackgroundColor: getTheme().panel,
    selectedBackgroundColor: getTheme().highlight,
    textColor: getTheme().text,
    focusedTextColor: getTheme().text,
    selectedTextColor: getTheme().focus,
    descriptionColor: getTheme().muted,
    selectedDescriptionColor: getTheme().muted,
  });
  main.add(menu);

  // Bordered composer: wrap at the column width, grow up to 1/3 of the
  // viewport, then scroll. Enter submits (Shift/Alt+Enter insert a newline).
  // minWidth: 0 is load-bearing — without it Yoga sizes the textarea to the
  // unwrapped text and wrap never fires, so the cursor scrolls off to the left.
  const composer = new otui.BoxRenderable(r, {
    id: "composer",
    flexShrink: 0,
    minWidth: 0,
    width: "100%",
    flexDirection: "column",
    borderStyle: "rounded",
    border: true,
    borderColor: getTheme().border,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const textarea = new otui.TextareaRenderable(r, {
    id: "prompt",
    placeholder: opts.placeholder,
    wrapMode: "word",
    minWidth: 0,
    width: "100%",
    minHeight: COMPOSER_MIN_ROWS,
    height: COMPOSER_MIN_ROWS,
    flexShrink: 0,
    overflow: "scroll",
    // Enter = submit; Shift/Meta+Enter = newline (the default Textarea bindings
    // are inverted).
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "kpenter", action: "submit" },
      { name: "linefeed", action: "newline" },
      { name: "return", shift: true, action: "newline" },
      { name: "linefeed", shift: true, action: "newline" },
      { name: "kpenter", shift: true, action: "newline" },
      { name: "return", meta: true, action: "newline" },
      { name: "linefeed", meta: true, action: "newline" },
    ],
  });
  composer.add(textarea);
  main.add(composer);

  const viewportRows = (): number => {
    const h = (r as { height?: number }).height;
    return typeof h === "number" && h > 0 ? h : COMPOSER_MAX_ROWS * 3;
  };

  const syncComposerHeight = (): void => {
    const cap = composerMaxRowsForViewport(viewportRows());
    let lines = 1;
    try {
      const wrapWidth = typeof textarea.width === "number" && textarea.width > 0 ? textarea.width : 0;
      lines = Math.max(
        textarea.virtualLineCount || 0,
        textarea.lineCount || 0,
        wrappedLineCount(textarea.plainText, wrapWidth),
        1,
      );
    } catch {
      lines = wrappedLineCount(textarea.plainText, 0);
    }
    const h = composerHeightForLines(lines, cap);
    if (textarea.height !== h) {
      textarea.height = h;
    }
    const boxH = h + COMPOSER_BORDER_ROWS;
    if (composer.height !== boxH) {
      composer.height = boxH;
    }
    textarea.maxHeight = cap;
  };

  /** Adapter so callers keep using `.value` / `.focus()` over the Textarea. */
  const input: ComposerInput = {
    get value(): string {
      return textarea.plainText;
    },
    set value(v: string) {
      const next = v ?? "";
      if (textarea.plainText !== next) {
        textarea.setText(next);
        try {
          textarea.cursorOffset = next.length;
        } catch {
          // best-effort
        }
      }
      syncComposerHeight();
    },
    focus(): void {
      textarea.focus();
    },
  };

  // --- region click-to-focus (flow 170 T6, PRD FR-11/FR-13/FR-15) ---------
  // Clicking a region routes keyboard focus to whatever it logically belongs
  // to. Both handlers defer entirely to an active overlay (FR-15) via the
  // SAME `overlayActive()` the `/`-menu key router above already relies on —
  // confirmed by reading its body (a few lines up) rather than assumed: it
  // already folds in anything registered through `addOverlaySource` (e.g.
  // flow 170 T5's queue-nav mode), so this one check is sufficient on its
  // own, no separate queue-nav-aware guard needed.
  scroll.onMouseDown = (event) => {
    if (overlayActive()) return;
    input.focus(); // FR-13: transcript/output-area (or empty space below it,
    // since `scroll` is the flexGrow:1 filler) click -> composer.
    // `ScrollBoxRenderable` is itself focusable (for keyboard scrolling), and
    // the renderer's OWN mouse dispatch (`dispatchMouseEvent`, bundled
    // `@opentui/core`) walks from the click target up through `.parent`
    // AFTER firing this handler, auto-focusing the first focusable ancestor
    // it finds — which would be `scroll` itself, immediately blurring the
    // composer this handler just focused. `preventDefault()` is exactly the
    // renderer's own escape hatch for that walk (confirmed against the
    // bundled implementation, not assumed) — without it, every transcript
    // click would visibly focus the composer for one frame and then silently
    // lose it again.
    event.preventDefault();
  };
  // FR-11: `sidebar` is display-only today — model/context/tools/status text
  // plus per-row subagent entries that already own their own `onMouseDown`
  // (`subagent-inspector.ts`'s `paintSubagentSidebar`). It has no focusable
  // child of its own, and `Renderable.focus()` (the OpenTUI base class every
  // Box inherits) is a real, stateful operation: making `sidebar` focusable
  // and calling `.focus()` on it would blur whatever currently holds
  // keyboard focus (`ctx.focusRenderable` blurs the previously focused
  // renderable — confirmed against the bundled `@opentui/core`
  // implementation, not assumed) and then swallow every subsequent keystroke
  // into nothing, since a plain `BoxRenderable` has no `handleKeyPress` to
  // route them anywhere — a keyboard dead-zone strictly worse than today's
  // no-op. So this handler intentionally does NOT call `.focus()` on
  // anything: it exists — and keeps the `overlayActive()` guard — so the
  // click-to-focus routing point FR-11 asks for is uniformly present across
  // all three regions, ready to wire to a real focus target the day the
  // sidebar gains one (a keyboard-navigable subagent list, say), without
  // faking keyboard ownership over content that cannot use it today.
  sidebar.onMouseDown = () => {
    if (overlayActive()) return;
  };

  // --- footer + busy spinner ----------------------------------------------
  // Live status (spinner + phase + elapsed) while busy; the idle hint otherwise.
  const footer = new otui.BoxRenderable(r, {
    id: "footer",
    flexShrink: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const footerLeft = new otui.TextRenderable(r, { id: "footer-left", content: otui.t`${otui.dim(opts.footerHint)}` });
  footer.add(footerLeft);
  const footerRight = new otui.TextRenderable(r, { id: "footer-right", content: otui.t`${otui.dim(opts.status)}` });
  footer.add(footerRight);
  main.add(footer);

  // `liveStatus` is declared with the transcript pin wrapper above; this block
  // only owns the phase/timer/spinner state.
  let busyPhase = "waiting for model";
  let busyStartedAt = 0;
  let spinIdx = 0;
  let busyTimer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let footerOverride: (() => StyledContent | undefined) | undefined;

  const paintBusyStatus = (): void => {
    // The override owns the footer even mid-turn: the spinner interval would
    // otherwise repaint over it every 120ms.
    const override = footerOverride?.();
    if (override !== undefined) {
      footerLeft.content = override;
      return;
    }
    if (!busy) {
      footerLeft.content = otui.t`${otui.dim(opts.footerHint)}`;
      footerRight.content = otui.t`${otui.dim(opts.status)}`;
      return;
    }
    const frame = SPINNER[spinIdx % SPINNER.length] ?? "⠋";
    const secs = ((Date.now() - busyStartedAt) / 1000).toFixed(1);
    const line = `${frame} ${busyPhase} · ${secs}s`;
    footerLeft.content = otui.t`${otui.yellow(line)}`;
    // The footer's right slot carries the permission mode while a turn runs
    // (provider/model stays in the header title); idle restores the status.
    const perm = opts.permissionMode?.();
    footerRight.content = otui.t`${otui.dim(
      perm !== undefined && perm.length > 0 ? `mode ${perm}` : opts.status,
    )}`;
    if (liveStatus !== undefined) {
      liveStatus.content = otui.t`${otui.dim(line)}`;
    }
  };

  const clearBusyTimer = (): void => {
    if (busyTimer !== undefined) {
      clearInterval(busyTimer);
      busyTimer = undefined;
    }
  };

  const setBusyPhase = (phase: string): void => {
    busyPhase = phase;
    paintBusyStatus();
  };

  const startBusy = (phase = "waiting for model"): void => {
    busy = true;
    busyPhase = phase;
    busyStartedAt = Date.now();
    spinIdx = 0;
    liveStatus = new otui.TextRenderable(r, {
      id: `ls${uid++}`,
      content: otui.t`${otui.dim(`⠋ ${phase} · 0.0s`)}`,
      marginTop: 1,
    });
    transcript.add(liveStatus);
    clearBusyTimer();
    busyTimer = setInterval(() => {
      spinIdx += 1;
      paintBusyStatus();
    }, SPINNER_MS);
    paintBusyStatus();
  };

  const stopBusy = (): void => {
    busy = false;
    clearBusyTimer();
    // Remove the in-transcript spinner line; the caller's "worked for Ns"
    // replaces it.
    if (liveStatus !== undefined) {
      try {
        transcript.remove(liveStatus);
      } catch {
        // best-effort
      }
      liveStatus = undefined;
    }
    paintBusyStatus(); // the idle hint, or the override when one is installed
  };

  // --- `/`-menu wiring ----------------------------------------------------
  // `menuNav` = the dropdown (not the composer) currently owns the keyboard. The
  // dropdown is FOCUSED as soon as it opens, so ↑/↓/Enter work immediately;
  // printable keys and Backspace are re-routed into the composer value below so
  // typing still filters live.
  let menuNav = false;
  const refilter = (): void => {
    const matches = [...filter(input.value)];
    if (matches.length > 0 && input.value.startsWith("/")) {
      menu.options = matches;
      menu.visible = true;
      if (!menuNav) {
        menu.focus();
        menuNav = true;
      }
    } else {
      menu.visible = false;
      if (menuNav) {
        menuNav = false;
        input.focus();
      }
    }
  };
  /**
   * Drop the dropdown AND its keyboard claim. The two must always move together:
   * `menuNav` gates `refilter`'s `menu.focus()`, so hiding the menu on its own
   * leaves the next reopen visible-but-unfocused.
   */
  const hideMenu = (): void => {
    menu.visible = false;
    menuNav = false;
  };
  const closeMenu = (): void => {
    hideMenu();
    input.value = "";
    input.focus();
  };
  textarea.onContentChange = () => {
    syncComposerHeight();
    refilter();
  };
  const onComposerResized = (): void => {
    syncComposerHeight();
  };
  textarea.on(otui.LayoutEvents.RESIZED, onComposerResized);
  textarea.focus();
  syncComposerHeight();

  // --- submit hook --------------------------------------------------------
  const submitHandlers = new Set<(line: string) => void>();
  const emitSubmit = (line: string): void => {
    for (const handler of [...submitHandlers]) {
      handler(line);
    }
  };

  // Selecting a command from the dropdown runs it through the same hook as a
  // composer submission and hands focus back to the composer.
  menu.on(otui.SelectRenderableEvents.ITEM_SELECTED, () => {
    const opt = menu.getSelectedOption();
    closeMenu();
    if (opt !== null) {
      emitSubmit(opt.name);
    }
  });
  textarea.onSubmit = () => {
    const line = input.value.trim();
    input.value = "";
    hideMenu();
    syncComposerHeight();
    emitSubmit(line);
  };

  // Route printable keys / Backspace / Esc for the open dropdown — via the
  // GLOBAL internal key handler, which runs BEFORE the focused renderable, so a
  // handled key does not also move the composer's cursor or submit a turn.
  // ↑/↓/Enter deliberately fall through to the focused SelectRenderable.
  const unsubscribeMenuKeys = onKeypress(r, (key) => {
    // An overlay owns the keyboard: its keys must not be swallowed into the
    // filter query behind it, and Esc means whatever the overlay says it means.
    if (!menu.visible || !menuNav || overlayActive()) {
      return;
    }
    if (key.name === "escape") {
      closeMenu();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    // Tab ACCEPTS the highlighted command into the composer instead of running
    // it — unlike Enter (`ITEM_SELECTED` below), which submits immediately.
    // Commands that take a required text argument (`/goal <text>`, `/delegate
    // <agent> <task>`, …) have no way to receive one from Enter-select alone;
    // Tab hands the keyboard back to the composer, pre-filled with `<name> `,
    // so the user can keep typing right where the dropdown left off.
    if (key.name === "tab") {
      const opt = menu.getSelectedOption();
      if (opt !== null) {
        // `hideMenu()` below does NOT by itself protect this against a
        // re-fired `refilter()`: `textarea.setText`'s `onContentChange` is
        // DEFERRED, not synchronous, so it can still run after `hideMenu()`
        // has already reset `menuNav`. The only thing stopping that deferred
        // refilter from re-matching `"<name> "` and reopening/refocusing the
        // menu right out from under the user is `filterCommands`/
        // `prefixFilter` never matching a trailing space (see their own
        // docstrings) — do not reintroduce `.trim()` there without
        // re-verifying this Tab path stays closed.
        input.value = `${opt.name} `;
      }
      hideMenu();
      input.focus();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    if (key.name === "backspace") {
      input.value = input.value.slice(0, -1);
      refilter();
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    // A printable single character (no modifiers) → append to the filter query.
    const ch = key.sequence;
    if (!key.ctrl && !key.meta && typeof ch === "string" && ch.length === 1 && ch >= " ") {
      input.value += ch;
      refilter();
      key.preventDefault();
      key.stopPropagation();
    }
  });

  const applyTheme = (theme: Theme = getTheme()): void => {
    // Theme-switch repaint, in place. The chrome's own surfaces are listed
    // explicitly below; everything else the shell painted with the theme —
    // transcript frames, tone-colored block headers, dock/queue-dock buttons,
    // sidebar panels — carried the OLD palette's hex into `borderColor` /
    // `backgroundColor` / `fg` and is moved to the new palette by the tree
    // walk below (value-matching old slot hexes, see `themeColorRemap`).
    const remap = themeColorRemap(appliedTheme, theme);
    try {
      r.setBackgroundColor(theme.bg);
    } catch {
      // renderer may not expose the setter in tests
    }
    sidebar.borderColor = theme.highlight;
    dock.backgroundColor = theme.panel;
    dock.borderColor = theme.border;
    queueDock.backgroundColor = theme.panel;
    queueDock.borderColor = theme.border;
    composer.borderColor = theme.border;
    menu.backgroundColor = theme.panel;
    menu.focusedBackgroundColor = theme.panel;
    menu.selectedBackgroundColor = theme.highlight;
    menu.textColor = theme.text;
    menu.focusedTextColor = theme.text;
    menu.selectedTextColor = theme.focus;
    menu.descriptionColor = theme.muted;
    menu.selectedDescriptionColor = theme.muted;
    // Walk the content containers by direct reference rather than trusting a
    // parent chain (ScrollBox children semantics vary): each walk is
    // idempotent, so overlapping trees cost nothing.
    recolorThemeTree(transcript, remap);
    recolorThemeTree(dock, remap);
    recolorThemeTree(queueDock, remap);
    recolorThemeTree(sidebarTop, remap);
    recolorThemeTree(menu, remap);
    recolorThemeTree(composer, remap);
    recolorThemeTree(header, remap);
    recolorThemeTree(footer, remap);
    appliedTheme = theme;
  };
  const unsubTheme = onThemeChange((theme) => applyTheme(theme));

  return {
    renderer: r,
    root: rootRow,
    main,
    sidebar,
    sidebarTop,
    header,
    scroll,
    transcript,
    dock,
    queueDock,
    menu,
    composer,
    textarea,
    footer,
    input,

    focusComposer: () => {
      textarea.focus();
    },
    blurComposer: () => {
      textarea.blur();
    },
    syncComposerHeight,

    menuActive: () => menu.visible && menuNav,
    closeMenu,
    hideMenu,
    refilterMenu: refilter,

    overlayActive,
    addOverlaySource,
    withOverlay,

    showToast,
    applyTheme,

    startBusy,
    stopBusy,
    setBusyPhase,
    isBusy: () => busy,
    repaintStatus: paintBusyStatus,
    setFooterOverride: (paint) => {
      footerOverride = paint;
      paintBusyStatus();
    },

    setTitle: (text) => paintDim(headerLeft, text),
    setStatus: (text) => paintDim(footerRight, text),
    setHeaderMeta: (text) => paintDim(headerRight, text),

    onSubmit: (handler) => {
      submitHandlers.add(handler);
      return () => {
        submitHandlers.delete(handler);
      };
    },

    destroy: () => {
      alive = false;
      unsubTheme();
      destroyModalHost(r);
      clearBusyTimer();
      clearToastTimer();
      unsubscribeMenuKeys();
      try {
        textarea.off(otui.LayoutEvents.RESIZED, onComposerResized);
      } catch {
        // best-effort teardown
      }
      try {
        r.off(otui.CliRenderEvents.SELECTION, onSelection);
      } catch {
        // best-effort teardown
      }
    },
  };
}
