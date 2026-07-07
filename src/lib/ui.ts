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
