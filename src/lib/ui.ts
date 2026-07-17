import { stdout } from "node:process";

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

// Lightweight markdown → styled terminal text: ATX headings (`#`..`######`),
// **bold**, `inline code`, fenced ``` code blocks, and -/* bullet lists. Pure,
// deterministic (no IO / clock / randomness). When color is disabled (NO_COLOR
// or a non-TTY sink) the input is returned unchanged — already plain,
// structurally faithful text with no escape codes.
export function renderMarkdown(md: string): string {
  if (!colorEnabled()) {
    return md;
  }
  const out: string[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode; // drop the fence line itself
      continue;
    }
    if (inCode) {
      out.push(style.gray(line));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      out.push(style.bold(style.cyan(heading[1] ?? "")));
      continue;
    }
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      out.push(`${bullet[1] ?? ""}${style.cyan(symbols.bullet)} ${renderInline(bullet[2] ?? "")}`);
      continue;
    }
    out.push(renderInline(line));
  }
  return out.join("\n");
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
