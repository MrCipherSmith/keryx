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
  segmentMarkdown,
  splitLines,
  stripTrailingCr,
  type MdSegment,
} from "../lib/md-blocks";

// --- registry (pure) -------------------------------------------------------

/** Shown instead of a block's body once bounded retention has dropped it. */
export const EVICTED_BLOCK_TEXT = "(output no longer retained)";

/** Shown for an id the registry has never seen — distinct from an eviction. */
export const UNKNOWN_BLOCK_TEXT = "(no such block)";

/** Appended to a body that was clipped to fit `maxRetainedChars` on register. */
export const TRUNCATED_BLOCK_NOTICE = "… (output truncated at the retention cap)";

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
  /**
   * The retained payload — a PREFIX of the registered text when `truncated`.
   * Absent once the block has been evicted.
   */
  fullText?: string | undefined;
  lineCount: number;
  collapsed: boolean;
  retained: boolean;
  /** True when the payload exceeded `maxRetainedChars` and was clipped (D-4). */
  truncated: boolean;
}

export interface BlockRegistryOptions {
  /** Max blocks holding their `fullText` at once. */
  maxBlocks?: number;
  /**
   * Hard cap on total retained characters across all blocks. A single payload
   * larger than the cap is CLIPPED on register (never admitted whole), so the
   * cap is a real bound rather than a best effort.
   */
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
  /**
   * The body to show/copy: the payload (plus a truncation notice when it was
   * clipped), the evicted marker, or the unknown-id marker. The three are
   * distinct strings so a caller can tell "dropped by retention" from "never
   * existed" and never report a marker as a successful copy.
   */
  bodyText(id: string): string;
  /** Total retained characters right now — never above `maxRetainedChars`. */
  retainedChars(): number;
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
  // never evicted wholesale: a single oversized payload would otherwise be
  // dropped the instant it arrived, which reads as a bug rather than as a
  // retention policy. It does not weaken the char bound — `register` already
  // clipped that payload to the cap, so "keep only the newest" always fits.
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
      // A payload larger than the whole cap is clipped to its HEAD rather than
      // rejected: expanding a huge tool output must still show its beginning,
      // and the cap must still hold afterwards (AC8 / D-4).
      const truncated = block.fullText.length > maxRetainedChars;
      blocks.push({
        id,
        kind: block.kind,
        summary: block.summary,
        fullText: truncated ? block.fullText.slice(0, maxRetainedChars) : block.fullText,
        lineCount: block.lineCount,
        collapsed: true,
        retained: true,
        truncated,
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
    bodyText: (id) => {
      const block = find(id);
      if (block === undefined) {
        return UNKNOWN_BLOCK_TEXT;
      }
      if (block.fullText === undefined) {
        return EVICTED_BLOCK_TEXT;
      }
      return block.truncated ? `${block.fullText}\n${TRUNCATED_BLOCK_NOTICE}` : block.fullText;
    },
    retainedChars,
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
 *
 * DELIBERATE divergence from `segmentMarkdown` (pinned by test): a trailing
 * PARTIAL line is not fence-tested, so mid-stream `push("a\n```ts")` reports one
 * text segment `"a\n```ts"` where `segmentMarkdown` of the same string reports
 * text + an open code segment. A partial line is not yet knowable — `` ``` ``
 * may still grow into inline prose — and the marker is replaced by the framed
 * block on the very next token that completes the line. Freezing a segment on a
 * guess would mean un-freezing it, which is exactly what R1 forbids.
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
    const pendingLines = partial.length > 0 ? [...lines, stripTrailingCr(partial)] : lines;
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
        consume(stripTrailingCr(line)); // CRLF chunks segment like LF ones
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
  const lines = splitLines(text.replace(/\n+$/, ""));
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
  const lines = splitLines(md);
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
  const lines = splitLines(text);
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
  for (const [index, line] of splitLines(text).entries()) {
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

/** An assistant reply rendered as a column of per-segment sibling views. */
export interface AssistantMessageStream {
  /** Append a streamed chunk; the container is created on the first content. */
  push(chunk: string): void;
  /**
   * The authoritative final text: re-segment ONCE (not per token) and rebuild.
   * A message that segments to nothing is removed rather than left as an empty
   * container.
   */
  finalize(text: string): void;
  /** True while a message container is open (content streamed, not finalized). */
  open(): boolean;
}

let messageSeq = 0;

/**
 * A streaming assistant message: one `SegmentView` per markdown segment, so a
 * fence can be framed with its language tag instead of being flattened into one
 * dim line (flow 109 / AC5).
 *
 * Extracted in flow 112 (T6) so BOTH shells render assistant text through the
 * same object: `createTuiAgentIo`'s `write`/`onAssistantText` (agent) and the
 * chat driver's `ShellIO.write`/`onTurnEnd` (chat) are the same two calls under
 * different hook names, and the two surfaces cannot drift apart by construction.
 *
 * Repaints run from `frozen` onwards only: earlier segments are settled, so a
 * token costs the trailing segment's render and nothing else (risk R1).
 */
export function createAssistantMessageStream(
  otui: OpenTui,
  renderer: Renderer,
  parent: Box,
): AssistantMessageStream {
  type Message = {
    container: Box;
    segmenter: StreamSegmenter;
    views: SegmentView[];
    /** Views whose segment is final; never repainted again. */
    frozen: number;
  };
  let message: Message | undefined;

  const start = (): Message => {
    messageSeq += 1;
    const container = new otui.BoxRenderable(renderer, {
      id: `msg${messageSeq}`,
      flexDirection: "column",
      flexShrink: 0,
    });
    parent.add(container);
    return { container, segmenter: createStreamSegmenter(), views: [], frozen: 0 };
  };

  const paint = (m: Message, segments: readonly MdSegment[], frozen: number): void => {
    for (let i = m.frozen; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === undefined) {
        continue;
      }
      const existing = m.views[i];
      if (existing !== undefined && existing.kind === segment.kind) {
        existing.update(segment);
        continue;
      }
      existing?.destroy();
      m.views[i] = createSegmentView(otui, renderer, m.container, segment);
    }
    for (const stale of m.views.splice(segments.length)) {
      stale.destroy();
    }
    m.frozen = frozen;
  };

  return {
    push: (chunk) => {
      if (chunk.length === 0) {
        return;
      }
      const m = (message ??= start());
      const { segments, frozen } = m.segmenter.push(chunk);
      paint(m, segments, frozen);
    },
    finalize: (text) => {
      const m = message ?? start();
      for (const view of m.views.splice(0)) {
        view.destroy();
      }
      m.frozen = 0;
      const segments = segmentMarkdown(text);
      paint(m, segments, segments.length);
      if (segments.length === 0) {
        try {
          parent.remove(m.container);
        } catch {
          // best-effort teardown
        }
      }
      message = undefined;
    },
    open: () => message !== undefined,
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
   *
   * The body is IDEMPOTENT: repainting an expanded block with the text it is
   * already showing touches no renderable and re-parses nothing, so a repaint
   * driven by something else (a focus move, entering nav mode) is cheap.
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
  let bodyText: Text | undefined;
  /** The text the mounted body currently shows — `undefined` while it is dropped. */
  let painted: string | undefined;

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
    bodyText = undefined;
    painted = undefined;
  };

  /**
   * Show `text` in the body, doing the LEAST work that gets there: nothing at all
   * when the same text is already mounted, a content swap on the existing
   * renderable when it changed (an eviction repainting its marker), and a fresh
   * frame only on the collapsed → expanded edge.
   *
   * This is what makes `paintAll` — and therefore every `↑`/`↓` in nav mode —
   * cheap: without it each keystroke destroyed and rebuilt every expanded body
   * and re-parsed up to `MAX_BODY_LINES` of markdown per block. The renderable
   * ids are stable for the same reason: churning them on each repaint defeats any
   * id-keyed caching downstream.
   */
  const showBody = (text: string): void => {
    if (body !== undefined && painted === text) {
      return;
    }
    const content = new otui.StyledText(payloadChunks(otui, clipBody(text)));
    painted = text;
    if (bodyText !== undefined) {
      bodyText.content = content;
      return;
    }
    const frame = new otui.BoxRenderable(renderer, {
      id: `${id}-b`,
      flexDirection: "column",
      flexShrink: 0,
      alignSelf: "flex-start",
      borderStyle: "rounded",
      border: true,
      borderColor: FRAME_COLOR,
      paddingLeft: 1,
      paddingRight: 1,
    });
    const child = new otui.TextRenderable(renderer, { id: `${id}-bt`, content });
    frame.add(child);
    box.add(frame);
    body = frame;
    bodyText = child;
  };

  return {
    id: block.id,
    render: (state, opts = {}) => {
      paintHeader(state, opts.focused === true);
      if (state.collapsed) {
        dropBody();
        return;
      }
      showBody(opts.body ?? state.fullText ?? EVICTED_BLOCK_TEXT);
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

/** Registry + mounted views for one transcript: what the shell's IO writes to. */
export interface BlockMount {
  /** Register `input` and mount its (collapsed) view; returns the block id. */
  add(input: BlockInput, options?: BlockViewOptions): string;
  /** The mounted view for a block id — the nav controller's `view` port. */
  view(id: string): BlockView | undefined;
}

/**
 * The register → mount step of the shell's block wiring, extracted so a headless
 * test drives the SAME code the shell does instead of a hand-written replica.
 * Painting stays with the caller (the nav controller owns the focus highlight).
 */
export function createBlockMount(
  otui: OpenTui,
  renderer: Renderer,
  parent: Box,
  registry: BlockRegistry,
): BlockMount {
  const views = new Map<string, BlockView>();
  return {
    add: (input, options = {}) => {
      const id = registry.register(input);
      const state = registry.get(id);
      if (state !== undefined) {
        views.set(id, createBlockView(otui, renderer, parent, state, options));
      }
      return id;
    },
    view: (id) => views.get(id),
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
  /**
   * Copy a block's retained body. `false` — with no success toast — when the id
   * is unknown, when retention already dropped the payload, or when clipboard
   * access is refused.
   */
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

  // Never report a marker string as a successful copy: an evicted or unknown
  // block has nothing to put on the clipboard, so it toasts the truth and fails.
  const copy = (id: string): boolean => {
    const state = registry.get(id);
    if (state === undefined) {
      return false;
    }
    if (!state.retained) {
      toast("Output no longer retained");
      return false;
    }
    try {
      copyText(registry.bodyText(id));
      toast(state.truncated ? "Copied to clipboard (truncated)" : "Copied to clipboard");
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
   * Repaint the focus highlight after a registry focus move: ONLY the block that
   * lost it and the one that gained it, never the whole transcript — a move
   * changes nothing about any other block, and repainting them all made every
   * keystroke cost the entire visible transcript. `next` is `undefined` only on
   * an empty registry (the moves clamp otherwise), so a miss is a no-op.
   *
   * Scroll-into-view is NOT done here: `createBlockView` does not expose its box,
   * and the transcript is short enough in practice that the highlight stays
   * visible — revisit if that stops holding.
   */
  const moveFocus = (previous: BlockState | undefined, next: BlockState | undefined): void => {
    if (next === undefined) {
      return;
    }
    if (previous !== undefined && previous.id !== next.id) {
      paint(previous.id);
    }
    paint(next.id);
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
        moveFocus(focused, registry.focusPrev());
      } else if (key.name === "down") {
        moveFocus(focused, registry.focusNext());
      } else if (isEnter || isSpace) {
        if (focused !== undefined) {
          toggle(focused.id); // `setCollapsed` repaints it — a second pass paints nothing new
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
