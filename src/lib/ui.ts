import { stdout } from "node:process";
import { classifyDiffLine, looksLikeUnifiedDiff, payloadKind, segmentMarkdown, splitLines } from "./md-blocks";

// Terminal styling helpers. Colors are emitted only for an interactive TTY and
// are suppressed when `NO_COLOR` is set; `FORCE_COLOR` forces them on (useful in
// tests and CI). Everything degrades to plain text so piped/redirected output
// stays clean.
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }
  return Boolean(stdout.isTTY);
}

function wrap(open: number, close: number): (text: string) => string {
  return (text) => (colorEnabled() ? `[${open}m${text}[${close}m` : text);
}

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export const symbols = {
  ok: "✓",
  cross: "✗",
  off: "·",
  arrow: "→",
  bullet: "•",
};

const RULE_WIDTH = 52;

export function banner(title: string, subtitle?: string): void {
  const rule = style.cyan("━".repeat(RULE_WIDTH));
  console.log(rule);
  console.log(`  ${style.bold(title)}`);
  if (subtitle) {
    console.log(`  ${style.dim(subtitle)}`);
  }
  console.log(rule);
}

export function heading(title: string): void {
  console.log(`\n${style.bold(style.cyan(title))}`);
}

// One "label: state" row with a leading marker. Disabled rows are dimmed so the
// enabled set reads at a glance; `detail` is an optional dim suffix.
export function statusLine(label: string, enabled: boolean, detail?: string): void {
  const marker = enabled ? style.green(symbols.ok) : style.gray(symbols.off);
  const name = enabled ? label : style.gray(label);
  const suffix = detail ? style.dim(` (${detail})`) : "";
  console.log(`  ${marker} ${name}${suffix}`);
}

export function nextSteps(steps: string[]): void {
  if (steps.length === 0) {
    return;
  }
  heading("Next steps");
  for (const step of steps) {
    console.log(`  ${style.cyan(symbols.arrow)} ${step}`);
  }
}

export function note(message: string): void {
  console.log(`  ${style.dim(message)}`);
}

// Inline markdown spans: `code` then **bold**. Code is rendered first so its
// content is never re-scanned for bold markers. Pure + deterministic.
function renderInline(text: string): string {
  const withCode = text.replace(/`([^`]+)`/g, (_match, code: string) => style.gray(code));
  return withCode.replace(/\*\*([^*]+)\*\*/g, (_match, bold: string) => style.bold(bold));
}

// One prose line: ATX heading (`#`..`######`), -/* bullet, or inline spans.
function renderTextLine(line: string): string {
  const heading = /^#{1,6}\s+(.*)$/.exec(line);
  if (heading !== null) {
    return style.bold(style.cyan(heading[1] ?? ""));
  }
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (bullet !== null) {
    return `${bullet[1] ?? ""}${style.cyan(symbols.bullet)} ${renderInline(bullet[2] ?? "")}`;
  }
  return renderInline(line);
}

// Unified diff → ANSI: green additions, red deletions, cyan `@@` hunk headers,
// dim `---`/`+++` file headers, plain context. Line classification is shared
// with the TUI via `classifyDiffLine`, so the two shells cannot drift. Pure;
// returns the input unchanged when color is disabled.
export function renderDiff(text: string): string {
  if (!colorEnabled()) {
    return text;
  }
  return splitLines(text)
    .map((line) => {
      switch (classifyDiffLine(line)) {
        case "add":
          return style.green(line);
        case "del":
          return style.red(line);
        case "hunk":
          return style.cyan(line);
        case "meta":
          return style.dim(line);
        default:
          return line;
      }
    })
    .join("\n");
}

// A fenced block: a dim language tag (when the fence carried an info string)
// above the body. Diff payloads — either a `diff`/`patch` fence or a body that
// sniffs as a unified diff — are colorized instead of flatly dimmed.
function renderCodeSegment(lang: string, body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  if (lang.length > 0) {
    out.push(style.dim(lang));
  }
  if (payloadKind(lang, lines.length) === "diff" || looksLikeUnifiedDiff(body)) {
    out.push(renderDiff(body));
    return out;
  }
  for (const line of lines) {
    out.push(style.gray(line));
  }
  return out;
}

// Lightweight markdown → styled terminal text: ATX headings (`#`..`######`),
// **bold**, `inline code`, fenced ``` / ~~~ code blocks, and -/* bullet lists.
// Fence handling goes through `segmentMarkdown` so the readline renderer and the
// TUI segment identically. Pure, deterministic (no IO / clock / randomness).
// When color is disabled (NO_COLOR or a non-TTY sink) the input is returned
// unchanged — already plain, structurally faithful text with no escape codes.
export function renderMarkdown(md: string): string {
  if (!colorEnabled()) {
    return md;
  }
  const out: string[] = [];
  for (const segment of segmentMarkdown(md)) {
    if (segment.kind === "code") {
      out.push(...renderCodeSegment(segment.lang, segment.body));
      continue;
    }
    for (const line of segment.text.split("\n")) {
      out.push(renderTextLine(line));
    }
  }
  return out.join("\n");
}

// Collapse multi-line tool output to a one-line summary plus a hidden-line count
// (for a line-based "collapsible panel"): `summary` is the first NON-empty line
// clipped to `maxWidth`; `lineCount` is the total lines (trailing blank lines
// ignored); `hidden` is the count of lines beyond the first. Pure + deterministic.
export function collapseToolOutput(text: string, maxWidth = 100): { summary: string; lineCount: number; hidden: number } {
  const trimmed = text.replace(/\n+$/, "");
  const lines = trimmed.length === 0 ? [] : trimmed.split("\n");
  const firstNonEmpty = lines.find((line) => line.trim().length > 0) ?? "";
  const summary = firstNonEmpty.length > maxWidth ? `${firstNonEmpty.slice(0, maxWidth)}…` : firstNonEmpty;
  const lineCount = lines.length;
  return { summary, lineCount, hidden: Math.max(0, lineCount - 1) };
}

// Prefix every NON-empty line of `text` with `pad` (a left gutter), leaving
// empty lines untouched so no trailing whitespace is introduced. Pure — used to
// give agent-mode output a consistent left margin (OpenCode/codex aesthetic).
export function indentBlock(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

// Compact, human-readable rendering of a tool call's raw JSON input string for
// the agent transcript: `{"path":"src","depth":2}` → `path=src, depth=2`. Pure +
// deterministic (no color; the caller styles it). Falls back to the raw string
// (clipped to `max`) when the input is not a JSON object — e.g. a bare string or
// malformed JSON. Scalar values are shown inline; nested objects/arrays collapse
// to a `{…}` / `[…]` placeholder so a single call never explodes the line.
export function summarizeToolArgs(input: string, max = 80): string {
  const clip = (s: string): string => (s.length > max ? `${s.slice(0, max)}…` : s);
  const raw = input.trim();
  if (raw.length === 0) {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return clip(raw);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return clip(raw);
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    let shown: string;
    if (value === null) {
      shown = "null";
    } else if (Array.isArray(value)) {
      shown = "[…]";
    } else if (typeof value === "object") {
      shown = "{…}";
    } else {
      shown = String(value);
    }
    parts.push(`${key}=${shown}`);
  }
  return clip(parts.join(", "));
}

// A styled conversational role marker for the inline chat header/prompt.
export function roleLabel(role: string): string {
  if (role === "assistant") {
    return style.gray("assistant");
  }
  if (role === "you" || role === "user") {
    return style.cyan("you");
  }
  return style.dim(role);
}

export type HelpOption = { flag: string; desc: string };

// Bold command name plus a dim one-line summary; the header for `--help` output.
export function helpTitle(command: string, summary: string): void {
  console.log(`${style.bold(command)} ${style.dim(`— ${summary}`)}`);
}

export function helpUsage(lines: string[]): void {
  heading("Usage");
  for (const line of lines) {
    console.log(`  ${style.cyan(line)}`);
  }
}

export function helpOptions(options: HelpOption[]): void {
  heading("Options");
  const width = Math.max(...options.map((option) => option.flag.length));
  for (const option of options) {
    console.log(`  ${style.cyan(option.flag.padEnd(width))}  ${style.dim(option.desc)}`);
  }
}
