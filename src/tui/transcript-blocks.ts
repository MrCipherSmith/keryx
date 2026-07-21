// Retained, addressable transcript blocks for the OpenTUI shell (flow 109).
//
// Two independently testable halves:
//
//  1. `createBlockRegistry` — a PURE state machine (ids, per-block collapse,
//     focus movement, bounded retention). It touches no renderable, so the
//     registry tests run even when the optional `@opentui/core` is absent.
//  2. `createSegmentView` / `createBlockView` / `createStreamSegmenter` — the
//     renderer half. `otui` is always a PARAMETER (ADR-0005 + the lazy
//     optional-import guard, src/capability/no-optional-imports); the package is
//     only ever referenced structurally through `typeof import(...)`, never
//     imported at top level — not even as a type.
//
// Rendering is deliberately STRUCTURAL: a frame, a language tag, and diff line
// classes derived from the pure helpers in `src/lib/md-blocks.ts`. The native
// `CodeRenderable`/`DiffRenderable` are NOT used (flow 109 decision D-2) — they
// drive a tree-sitter Worker that can fetch grammars over the network at render
// time, which contradicts the shell's worker-free stance and keryx's egress
// posture.
import {
  blockLabel,
  classifyDiffLine,
  fenceInfo,
  looksLikeUnifiedDiff,
  payloadKind,
  type MdSegment,
} from "../lib/md-blocks";

// --- registry (pure) -------------------------------------------------------

/** Shown instead of a block's body once bounded retention has dropped it. */
export const EVICTED_BLOCK_TEXT = "(output no longer retained)";

/** What a caller hands to `register`. */
export interface BlockInput {
  /** Semantic class used for the header label, e.g. `thought` / `tool` / `output`. */
  kind: string;
  /** One-line collapsed preview (already clipped by the caller). */
  summary: string;
  /** The payload retained for expand/copy, subject to the retention bounds. */
  fullText: string;
  /** Line count of `fullText` as the caller measured it. */
  lineCount: number;
}

/** A registered block. `fullText` is absent once the block has been evicted. */
export interface BlockState {
  id: string;
  kind: string;
  summary: string;
  fullText?: string | undefined;
  lineCount: number;
  collapsed: boolean;
  retained: boolean;
}

export interface BlockRegistryOptions {
  /** Max blocks holding their `fullText` at once. */
  maxBlocks?: number;
  /** Max total retained characters across all blocks. */
  maxRetainedChars?: number;
}

export interface BlockRegistry {
  /** Register a block (starts collapsed) and return its id. */
  register(block: BlockInput): string;
  /** A snapshot of one block, or `undefined` for an unknown id. */
  get(id: string): BlockState | undefined;
  /** Flip one block's collapse state; unknown ids are inert. */
  toggle(id: string): void;
  /** Move focus to `id`; unknown ids leave focus untouched. */
  focus(id: string): BlockState | undefined;
  /** Move focus one block forward, clamped at the last block. */
  focusNext(): BlockState | undefined;
  /** Move focus one block backward, clamped at the first block. */
  focusPrev(): BlockState | undefined;
  focused(): BlockState | undefined;
  /** Every block, oldest first — evicted ones included. */
  list(): BlockState[];
  /** The body to show/copy: the payload, or the evicted marker. */
  bodyText(id: string): string;
}

// Defaults sized for a long session: a few dozen blocks, a few hundred KB. Both
// bounds are enforced together (D-4).
const DEFAULT_MAX_BLOCKS = 64;
const DEFAULT_MAX_RETAINED_CHARS = 400_000;

/**
 * Bounded, addressable block store. Blocks are never removed — an evicted block
 * keeps its id, kind, summary, line count, collapse state and its place in
 * `list()`, and only loses `fullText` (AC8). Pure: no IO, no clock, no OpenTUI.
 */
export function createBlockRegistry(options: BlockRegistryOptions = {}): BlockRegistry {
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxRetainedChars = options.maxRetainedChars ?? DEFAULT_MAX_RETAINED_CHARS;
  const blocks: BlockState[] = [];
  let seq = 0;
  let focusIndex = -1;

  const snapshot = (block: BlockState): BlockState => ({ ...block });
  const find = (id: string): BlockState | undefined => blocks.find((b) => b.id === id);
  const retainedChars = (): number => blocks.reduce((n, b) => n + (b.fullText?.length ?? 0), 0);
  const retainedCount = (): number => blocks.reduce((n, b) => n + (b.retained ? 1 : 0), 0);
  const newestRetained = (): BlockState | undefined => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block?.retained === true) {
        return block;
      }
    }
    return undefined;
  };

  // Evict oldest-first until BOTH bounds hold. The newest retained block is
  // never evicted: a single oversized payload would otherwise be dropped the
  // instant it arrived, which reads as a bug rather than as a retention policy.
  const enforceBounds = (): void => {
    for (;;) {
      if (retainedCount() <= maxBlocks && retainedChars() <= maxRetainedChars) {
        return;
      }
      const oldest = blocks.find((b) => b.retained);
      if (oldest === undefined || oldest === newestRetained()) {
        return;
      }
      oldest.retained = false;
      oldest.fullText = undefined;
    }
  };

  return {
    register: (block) => {
      seq += 1;
      const id = `blk${seq}`;
      blocks.push({
        id,
        kind: block.kind,
        summary: block.summary,
        fullText: block.fullText,
        lineCount: block.lineCount,
        collapsed: true,
        retained: true,
      });
      // The FIRST block takes focus; later registrations never move it, so a
      // turn finishing mid-navigation cannot yank the user somewhere else.
      if (focusIndex < 0) {
        focusIndex = 0;
      }
      enforceBounds();
      return id;
    },
    get: (id) => {
      const block = find(id);
      return block === undefined ? undefined : snapshot(block);
    },
    toggle: (id) => {
      const block = find(id);
      if (block !== undefined) {
        block.collapsed = !block.collapsed;
      }
    },
    focus: (id) => {
      const index = blocks.findIndex((b) => b.id === id);
      if (index < 0) {
        return undefined;
      }
      focusIndex = index;
      const block = blocks[index];
      return block === undefined ? undefined : snapshot(block);
    },
    focusNext: () => {
      if (blocks.length === 0) {
        return undefined;
      }
      focusIndex = Math.min(focusIndex + 1, blocks.length - 1);
      const block = blocks[focusIndex];
      return block === undefined ? undefined : snapshot(block);
    },
    focusPrev: () => {
      if (blocks.length === 0) {
        return undefined;
      }
      focusIndex = Math.max(focusIndex - 1, 0);
      const block = blocks[focusIndex];
      return block === undefined ? undefined : snapshot(block);
    },
    focused: () => {
      const block = focusIndex < 0 ? undefined : blocks[focusIndex];
      return block === undefined ? undefined : snapshot(block);
    },
    list: () => blocks.map(snapshot),
    bodyText: (id) => find(id)?.fullText ?? EVICTED_BLOCK_TEXT,
  };
}

// --- streaming segmentation (pure) -----------------------------------------

/** The segment list of a message being streamed. */
export interface StreamSegments {
  /** Frozen segments first, then at most one still-growing trailing segment. */
  segments: readonly MdSegment[];
  /** How many leading entries are final (their closing fence was seen). */
  frozen: number;
}

export interface StreamSegmenter {
  /** Feed the next streamed chunk and return the updated segment list. */
  push(chunk: string): StreamSegments;
  state(): StreamSegments;
  /** Drop all state (start of a new assistant message). */
  reset(): void;
}

/**
 * Incremental line-oriented markdown segmenter for the streaming path (risk R1).
 *
 * Fences are only recognised on COMPLETE lines, so the buffer is scanned once
 * overall rather than once per token: a segment is frozen the moment its closing
 * fence arrives and is never revisited, and the caller only has to repaint the
 * single trailing segment. Fence rules come from `fenceInfo`, so this and
 * `segmentMarkdown` cannot drift.
 */
export function createStreamSegmenter(): StreamSegmenter {
  let frozen: MdSegment[] = [];
  let lines: string[] = [];
  let partial = "";
  let marker = "";
  let lang = "";
  let inCode = false;

  const consume = (line: string): void => {
    const fence = fenceInfo(line);
    if (!inCode) {
      if (fence === undefined) {
        lines.push(line);
        return;
      }
      const text = lines.join("\n");
      if (text.length > 0) {
        frozen.push({ kind: "text", text });
      }
      lines = [];
      inCode = true;
      marker = fence.marker;
      lang = fence.lang;
      return;
    }
    if (fence?.marker === marker) {
      frozen.push({ kind: "code", lang, body: lines.join("\n") });
      lines = [];
      inCode = false;
      marker = "";
      lang = "";
      return;
    }
    lines.push(line);
  };

  const state = (): StreamSegments => {
    const pendingLines = partial.length > 0 ? [...lines, partial] : lines;
    const pending = pendingLines.join("\n");
    if (inCode) {
      return { segments: [...frozen, { kind: "code", lang, body: pending }], frozen: frozen.length };
    }
    // An empty trailing text segment is dropped, mirroring `segmentMarkdown`.
    return pending.length > 0
      ? { segments: [...frozen, { kind: "text", text: pending }], frozen: frozen.length }
      : { segments: [...frozen], frozen: frozen.length };
  };

  return {
    push: (chunk) => {
      partial += chunk;
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const line of parts) {
        consume(line);
      }
      return state();
    },
    state,
    reset: () => {
      frozen = [];
      lines = [];
      partial = "";
      marker = "";
      lang = "";
      inCode = false;
    },
  };
}

// --- renderer half (otui is a PARAMETER, never a top-level import) ----------

/** The `@opentui/core` module shape, referenced structurally (type-only). */
type OpenTui = typeof import("@opentui/core");
type Renderer = Awaited<ReturnType<OpenTui["createCliRenderer"]>>;
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Text = InstanceType<OpenTui["TextRenderable"]>;
type Chunk = ReturnType<OpenTui["bold"]>;

/** Frame color shared with the user-echo and side-worker boxes. */
const FRAME_COLOR = "#3a4a4a";

/** Expanded bodies are clipped for the viewport; `y` / `/copy` still get it all. */
export const MAX_BODY_LINES = 200;

let viewSeq = 0;

function lineCountOf(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/** `body` clipped to `MAX_BODY_LINES` with a trailing "N more lines" notice. */
function clipBody(text: string): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= MAX_BODY_LINES) {
    return lines.join("\n");
  }
  const hidden = lines.length - MAX_BODY_LINES;
  return [...lines.slice(0, MAX_BODY_LINES), `… (${hidden} more line${hidden === 1 ? "" : "s"} not shown)`].join("\n");
}

/**
 * Lightweight markdown → OpenTUI text chunks, mirroring the readline
 * `renderMarkdown` rules (ATX headings, **bold**, `inline code`, fenced blocks,
 * -/* bullets) but emitting `@opentui/core` chunks instead of ANSI, so it needs
 * no parser worker (the native `MarkdownRenderable` spins a WASM worker that is
 * unavailable headless) and renders through a plain `TextRenderable`.
 * Moved out of `tui-shell.ts` in flow 109 so it is directly testable.
 */
export function markdownToChunks(otui: OpenTui, md: string): Chunk[] {
  const out: Chunk[] = [];
  const plain = (s: string): void => {
    if (s.length > 0) {
      out.push(...otui.stringToStyledText(s).chunks);
    }
  };
  const inline = (text: string): void => {
    const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      plain(text.slice(last, m.index));
      if (m[1] !== undefined) {
        out.push(otui.dim(m[1].slice(1, -1))); // `code` → dim
      } else if (m[2] !== undefined) {
        out.push(otui.bold(m[2].slice(2, -2))); // **bold**
      }
      last = m.index + m[0].length;
    }
    plain(text.slice(last));
  };
  const lines = md.split("\n");
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Fence rules are shared with `segmentMarkdown` (indent ≤ 3 per CommonMark),
    // so a fence nested in a list item is not rendered as literal prose.
    if (fenceInfo(line) !== undefined) {
      inCode = !inCode; // drop the fence line
      continue;
    }
    if (i > 0) {
      plain("\n");
    }
    if (inCode) {
      out.push(otui.dim(line));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push(otui.cyan(otui.bold(heading[1] ?? "")));
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      plain(`${bullet[1] ?? ""}• `);
      inline(bullet[2] ?? "");
      continue;
    }
    inline(line);
  }
  return out;
}

/** Unified diff → chunks: green add, red del, cyan hunk, dim file headers. */
export function diffChunks(otui: OpenTui, text: string): Chunk[] {
  const out: Chunk[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      out.push(...otui.stringToStyledText("\n").chunks);
    }
    switch (classifyDiffLine(line)) {
      case "add":
        out.push(otui.green(line));
        break;
      case "del":
        out.push(otui.red(line));
        break;
      case "hunk":
        out.push(otui.cyan(line));
        break;
      case "meta":
        out.push(otui.dim(line));
        break;
      default:
        out.push(...otui.stringToStyledText(line).chunks);
    }
  }
  return out;
}

/** Flat dim body — the code payload, with no tree-sitter highlighting (D-2). */
function codeChunks(otui: OpenTui, text: string): Chunk[] {
  const out: Chunk[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) {
      out.push(...otui.stringToStyledText("\n").chunks);
    }
    out.push(otui.dim(line));
  }
  return out;
}

/**
 * Chunks for an arbitrary payload: a diff (by fence language OR by sniffing the
 * body) is colorized, markdown-ish payloads go through `markdownToChunks`, and
 * anything else renders as flat dim code.
 */
export function payloadChunks(otui: OpenTui, text: string, lang = ""): Chunk[] {
  const kind = payloadKind(lang, lineCountOf(text));
  if (kind === "diff" || looksLikeUnifiedDiff(text)) {
    return diffChunks(otui, text);
  }
  if (kind === "markdown" || lang.length === 0) {
    return markdownToChunks(otui, text);
  }
  return codeChunks(otui, text);
}

/** One rendered `MdSegment` of an assistant message. */
export interface SegmentView {
  readonly kind: MdSegment["kind"];
  /** Repaint in place from a segment of the SAME kind (the streaming path). */
  update(segment: MdSegment): void;
  destroy(): void;
}

/**
 * Render one markdown segment as a sibling renderable inside `parent` (AC5).
 * Prose is a plain `TextRenderable` so it keeps wrapping at the transcript
 * width; a fenced segment is a framed box whose header carries the language tag
 * and the line count. Frames never grow: `flexShrink: 0` + `alignSelf:
 * "flex-start"` and no `flexGrow` (AC11 / flow 075).
 */
export function createSegmentView(otui: OpenTui, renderer: Renderer, parent: Box, segment: MdSegment): SegmentView {
  viewSeq += 1;
  const id = `seg${viewSeq}`;
  if (segment.kind === "text") {
    const text = new otui.TextRenderable(renderer, {
      id,
      content: new otui.StyledText(markdownToChunks(otui, segment.text)),
    });
    parent.add(text);
    return {
      kind: "text",
      update: (next) => {
        if (next.kind === "text") {
          text.content = new otui.StyledText(markdownToChunks(otui, next.text));
        }
      },
      destroy: () => {
        try {
          parent.remove(text);
          text.destroyRecursively();
        } catch {
          // best-effort teardown
        }
      },
    };
  }

  const frame = new otui.BoxRenderable(renderer, {
    id,
    flexDirection: "column",
    flexShrink: 0,
    alignSelf: "flex-start",
    borderStyle: "rounded",
    border: true,
    borderColor: FRAME_COLOR,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const tag = (lang: string, body: string): string => {
    const n = lineCountOf(body);
    return `${lang.length > 0 ? lang : "text"} · ${n} ${n === 1 ? "line" : "lines"}`;
  };
  const header = new otui.TextRenderable(renderer, {
    id: `${id}-tag`,
    content: otui.t`${otui.dim(tag(segment.lang, segment.body))}`,
  });
  const body = new otui.TextRenderable(renderer, {
    id: `${id}-body`,
    content: new otui.StyledText(payloadChunks(otui, segment.body, segment.lang)),
  });
  frame.add(header);
  frame.add(body);
  parent.add(frame);
  return {
    kind: "code",
    update: (next) => {
      if (next.kind !== "code") {
        return;
      }
      header.content = otui.t`${otui.dim(tag(next.lang, next.body))}`;
      body.content = new otui.StyledText(payloadChunks(otui, next.body, next.lang));
    },
    destroy: () => {
      try {
        parent.remove(frame);
        frame.destroyRecursively();
      } catch {
        // best-effort teardown
      }
    },
  };
}

/** Header tint of a collapsible block. */
export type BlockTone = "dim" | "cyan" | "red";

export interface BlockViewOptions {
  /** Trailing hint in the header, e.g. `ctrl+o`. */
  hint?: string;
  tone?: BlockTone;
}

export interface BlockView {
  readonly id: string;
  /**
   * Repaint from `state`: the header marker/label always, and the body child —
   * created on expand, destroyed on collapse. `body` is the text to show when
   * expanded (the caller passes `registry.bodyText(id)` so an evicted block
   * shows the documented marker).
   */
  render(state: BlockState, opts?: { focused?: boolean; body?: string }): void;
  destroy(): void;
}

/**
 * A collapsible transcript block: a one-line header (`▸`/`▾` + `blockLabel` +
 * the collapsed summary) with a framed body child that only exists while the
 * block is expanded. The focused block's header is highlighted so block-nav mode
 * is visible without a cursor.
 */
export function createBlockView(
  otui: OpenTui,
  renderer: Renderer,
  parent: Box,
  block: BlockState,
  options: BlockViewOptions = {},
): BlockView {
  viewSeq += 1;
  const id = `blkv${viewSeq}`;
  const tone = options.tone ?? "dim";
  const box = new otui.BoxRenderable(renderer, {
    id,
    flexDirection: "column",
    flexShrink: 0,
    alignSelf: "flex-start",
  });
  const header = new otui.TextRenderable(renderer, { id: `${id}-h`, content: "" });
  box.add(header);
  parent.add(box);
  let body: Box | undefined;

  const paintHeader = (state: BlockState, focused: boolean): void => {
    const label = blockLabel({
      kind: state.kind,
      lineCount: state.lineCount,
      collapsed: state.collapsed,
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
    });
    const line = state.summary.length > 0 ? `${label}  ${state.summary}` : label;
    if (focused) {
      header.content = otui.t`${otui.yellow(`❯ ${line}`)}`;
      return;
    }
    header.content =
      tone === "red" ? otui.t`${otui.red(line)}` : tone === "cyan" ? otui.t`${otui.cyan(line)}` : otui.t`${otui.dim(line)}`;
  };

  const dropBody = (): void => {
    if (body === undefined) {
      return;
    }
    try {
      box.remove(body);
      body.destroyRecursively();
    } catch {
      // best-effort teardown
    }
    body = undefined;
  };

  const makeBody = (text: string): void => {
    viewSeq += 1;
    const frame = new otui.BoxRenderable(renderer, {
      id: `${id}-b${viewSeq}`,
      flexDirection: "column",
      flexShrink: 0,
      alignSelf: "flex-start",
      borderStyle: "rounded",
      border: true,
      borderColor: FRAME_COLOR,
      paddingLeft: 1,
      paddingRight: 1,
    });
    frame.add(
      new otui.TextRenderable(renderer, {
        id: `${id}-bt${viewSeq}`,
        content: new otui.StyledText(payloadChunks(otui, clipBody(text))),
      }),
    );
    box.add(frame);
    body = frame;
  };

  return {
    id: block.id,
    render: (state, opts = {}) => {
      paintHeader(state, opts.focused === true);
      if (state.collapsed) {
        dropBody();
        return;
      }
      dropBody(); // rebuild so an evicted block repaints its marker
      makeBody(opts.body ?? state.fullText ?? EVICTED_BLOCK_TEXT);
    },
    destroy: () => {
      dropBody();
      try {
        parent.remove(box);
        box.destroyRecursively();
      } catch {
        // best-effort teardown
      }
    },
  };
}

// --- block navigation mode (Ctrl+O … Esc) — flow 109 D-3 --------------------
//
// Extracted from the `launchTuiAgentShell` closure in flow 109/T5 so the mode is
// reachable from a headless test: a test can mount real `createBlockView`s, hand
// the controller the same registry/scroll/guard callbacks the shell hands it, and
// drive REAL keys through `onKeypress`. The closure keeps only the wiring.
//
// Deliberately free of `otui`/`renderer`: everything it touches is expressed as a
// narrow structural port (`NavScroll`) or a callback, which is also what makes it
// testable with a real `ScrollBoxRenderable` OR a plain object.

/** The slice of `ScrollBoxRenderable` the nav mode drives (AC12 / D-5). */
export interface NavScroll {
  scrollTop: number;
  stickyScroll: boolean;
}

/** The keypress event fields nav mode reads (OpenTUI's internal keypress shape). */
export interface NavKeyEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  sequence: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface BlockNavOptions {
  registry: BlockRegistry;
  /** The mounted view for a block id, or `undefined` if it has none. */
  view: (id: string) => BlockView | undefined;
  scroll: NavScroll;
  /**
   * True while some other surface owns the keyboard — the `/` dropdown in nav
   * state, a picker/approval overlay (AC4). Nav keys stay completely inert.
   */
  isBlocked: () => boolean;
  /** Give the keyboard back to the composer (`input.focus()`). */
  focusComposer: () => void;
  /** Take the keyboard away from the composer (`textarea.blur()`). */
  blurComposer: () => void;
  /** Put text on the system clipboard; a throw means "not permitted". */
  copyText: (text: string) => void;
  toast: (message: string) => void;
  /** Chrome that depends on the mode (the footer hint) repaints here. */
  onChange?: () => void;
  /** Defers the post-layout scroll re-assert; overridable for determinism. */
  schedule?: (run: () => void) => void;
}

export interface BlockNavController {
  /** True while block-nav owns the keyboard. */
  active(): boolean;
  enter(): void;
  exit(): void;
  /**
   * Refocus the composer UNLESS block-nav owns the keyboard (risk R3). Every
   * turn-end refocus goes through this, so a turn finishing mid-navigation
   * cannot yank the user out of nav mode.
   */
  restoreComposerFocus(): void;
  /** Repaint one block from registry state (focus highlight included). */
  paint(id: string): void;
  paintAll(): void;
  /** Collapse/expand one block, preserving the viewport for non-newest ones. */
  setCollapsed(id: string, collapsed: boolean): void;
  toggle(id: string): void;
  /** Copy a block's retained body; `false` when clipboard access is refused. */
  copy(id: string): boolean;
  /** The newest block of `kind` (or the newest block of any kind). */
  newest(kind?: string): BlockState | undefined;
  /** The keypress handler — wire it through the shell's `onKeypress` helper. */
  handleKey(key: NavKeyEvent): void;
}

/**
 * Modal, keyboard-only block navigation: `Ctrl+O` enters (composer blurs, newest
 * block focused, sticky scroll suspended), `↑`/`↓` move focus, `Enter`/`Space`
 * toggle collapse, `y` copies, `Esc` exits and restores composer focus + the
 * saved scroll offset. A dedicated mode rather than bare single keys because the
 * printable/Esc/Backspace namespace is already claimed by the composer and the
 * `/`-menu router (D-3).
 */
export function createBlockNavController(options: BlockNavOptions): BlockNavController {
  const { registry, view, scroll, isBlocked, focusComposer, blurComposer, copyText, toast } = options;
  const schedule = options.schedule ?? ((run: () => void) => void setTimeout(run, 0));
  const onChange = options.onChange ?? ((): void => {});

  /** THE focus guard (risk R3): who owns the keyboard right now. */
  let focusOwner: "composer" | "blocks" = "composer";
  /** Scroll offset saved on entering nav mode, restored on exit. */
  let savedScrollTop = 0;

  const active = (): boolean => focusOwner === "blocks";

  const paint = (id: string): void => {
    const state = registry.get(id);
    const mounted = view(id);
    if (state === undefined || mounted === undefined) {
      return;
    }
    mounted.render(state, { focused: active() && registry.focused()?.id === id, body: registry.bodyText(id) });
  };

  const paintAll = (): void => {
    for (const state of registry.list()) {
      paint(state.id);
    }
  };

  const newest = (kind?: string): BlockState | undefined => {
    const all = registry.list();
    for (let i = all.length - 1; i >= 0; i--) {
      const block = all[i];
      if (block !== undefined && (kind === undefined || block.kind === kind)) {
        return block;
      }
    }
    return undefined;
  };

  /**
   * Expanding anything but the NEWEST block suspends sticky scroll and restores
   * the offset (D-5 / AC12): the alternate screen has no scrollback, so a jump to
   * the bottom would lose the user's place.
   */
  const setCollapsed = (id: string, collapsed: boolean): void => {
    const state = registry.get(id);
    if (state === undefined || state.collapsed === collapsed) {
      return;
    }
    const isNewest = registry.list().at(-1)?.id === id;
    const before = scroll.scrollTop;
    registry.toggle(id);
    paint(id);
    if (isNewest) {
      return;
    }
    scroll.stickyScroll = false;
    scroll.scrollTop = before;
    // Layout runs on the next frame; re-assert once the new height is known.
    schedule(() => {
      try {
        scroll.scrollTop = before;
      } catch {
        // best-effort
      }
    });
  };

  const toggle = (id: string): void => {
    const state = registry.get(id);
    if (state !== undefined) {
      setCollapsed(id, !state.collapsed);
    }
  };

  const copy = (id: string): boolean => {
    try {
      copyText(registry.bodyText(id));
      toast("Copied to clipboard");
      return true;
    } catch {
      return false; // clipboard access not permitted — ignore
    }
  };

  const enter = (): void => {
    const target = newest();
    if (target === undefined) {
      toast("No transcript blocks yet");
      return;
    }
    focusOwner = "blocks";
    registry.focus(target.id);
    savedScrollTop = scroll.scrollTop;
    scroll.stickyScroll = false; // expanding must not yank the viewport (AC12)
    blurComposer();
    paintAll();
    onChange();
  };

  const exit = (): void => {
    if (!active()) {
      return;
    }
    focusOwner = "composer";
    paintAll(); // drop the focus highlight
    scroll.scrollTop = savedScrollTop;
    scroll.stickyScroll = true;
    focusComposer();
    onChange();
  };

  /**
   * Repaint the focus highlight after a registry focus move. `next` is
   * `undefined` only on an empty registry (the moves clamp otherwise), so a miss
   * is a no-op. Scroll-into-view is NOT done here: `createBlockView` does not
   * expose its box, and the transcript is short enough in practice that the
   * highlight stays visible — revisit if that stops holding.
   */
  const moveFocus = (next: BlockState | undefined): void => {
    if (next === undefined) {
      return;
    }
    paintAll();
  };

  return {
    active,
    enter,
    exit,
    restoreComposerFocus: () => {
      if (focusOwner === "composer") {
        focusComposer();
      }
    },
    paint,
    paintAll,
    setCollapsed,
    toggle,
    copy,
    newest,
    handleKey: (key) => {
      // Never fire while the `/` dropdown drives the keyboard, or while a
      // picker/approval overlay is up (AC4).
      if (isBlocked()) {
        return;
      }
      if (!active()) {
        if (key.ctrl && key.name === "o") {
          enter();
          key.preventDefault();
          key.stopPropagation();
        }
        return;
      }
      const focused = registry.focused();
      const isEnter = key.name === "return" || key.name === "linefeed" || key.name === "kpenter";
      const isSpace = key.name === "space" || key.sequence === " ";
      if (key.name === "escape") {
        exit();
      } else if (key.name === "up") {
        moveFocus(registry.focusPrev());
      } else if (key.name === "down") {
        moveFocus(registry.focusNext());
      } else if (isEnter || isSpace) {
        if (focused !== undefined) {
          toggle(focused.id);
          paintAll();
        }
      } else if (key.name === "y" && !key.ctrl && !key.meta) {
        if (focused !== undefined) {
          copy(focused.id);
        }
      } else {
        return; // anything else (incl. Ctrl+C) keeps its normal meaning
      }
      key.preventDefault();
      key.stopPropagation();
    },
  };
}
