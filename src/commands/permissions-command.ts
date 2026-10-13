// Flow 396: the saved shell rules, as the operator manages them.
//
// One module behind every surface: `keryx permissions list|remove`, the readline `/permissions`,
// the TUI `/permissions` list and its modal. A rule gets here from an "Always" press (in the shell
// or from Telegram) and is taken back here; nothing in this module can add one.
//
// Removal edits the stored file only for the exact pattern asked for (`removeShellPattern`), so a
// rule the operator can still see is never lost as a side effect, and it also drops the pattern from
// the running session's set so the rule stops approving at once.

import {
  loadShellPermissionsWithAudit,
  removeShellPattern,
  shellPermissionsPath,
  type PatternRejection,
} from "../lib/shell-permissions";

export type PermissionRowKind = "active" | "inactive" | "session";

/** One line of the rules list; `n` is the 1-based number `remove` accepts. */
export interface PermissionRow {
  n: number;
  pattern: string;
  kind: PermissionRowKind;
  /** Why an inactive rule is not honoured. */
  reason?: string;
}

export interface PermissionsView {
  path: string;
  rows: PermissionRow[];
}

/** The rules in the order they are numbered: honoured, then not honoured, then session-only grants. */
export function loadPermissionsView(options: { dir?: string; sessionAllow?: ReadonlySet<string> } = {}): PermissionsView {
  const audit = loadShellPermissionsWithAudit(options.dir);
  const stored = new Set<string>([...audit.permissions.allow, ...audit.rejected.map((entry) => entry.pattern)]);
  const rows: PermissionRow[] = [];
  const push = (pattern: string, kind: PermissionRowKind, reason?: string): void => {
    rows.push({ n: rows.length + 1, pattern, kind, ...(reason !== undefined ? { reason } : {}) });
  };
  for (const pattern of audit.permissions.allow) push(pattern, "active");
  audit.rejected.forEach((entry: PatternRejection) => push(entry.pattern, "inactive", entry.reason));
  for (const pattern of options.sessionAllow ?? []) {
    if (!stored.has(pattern)) push(pattern, "session");
  }
  return { path: shellPermissionsPath(options.dir), rows };
}

// eslint-disable-next-line no-control-regex -- a stored pattern may hold control bytes; they are shown, never executed
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A pattern on one terminal line: a newline is shown as `\n`, other control bytes as spaces. */
export function patternOnOneLine(pattern: string): string {
  return pattern.replace(/\r?\n/g, "\\n").replace(CONTROL, " ");
}

/** The list as plain lines (CLI, readline and the TUI transcript). Never contains a secret: only the stored patterns. */
export function permissionsLines(view: PermissionsView): string[] {
  const of = (kind: PermissionRowKind): PermissionRow[] => view.rows.filter((row) => row.kind === kind);
  const active = of("active");
  const inactive = of("inactive");
  const session = of("session");
  const lines: string[] = [];
  lines.push(
    active.length === 0
      ? "No saved shell rules: every command that is not read-only asks first."
      : `Saved shell rules (${active.length}): commands that run without asking.`,
  );
  for (const row of active) lines.push(`  ${row.n}. ${patternOnOneLine(row.pattern)}`);
  if (inactive.length > 0) {
    lines.push("", `Not honoured (${inactive.length}): kept in the file, they approve nothing.`);
    for (const row of inactive) {
      lines.push(`  ${row.n}. ${patternOnOneLine(row.pattern)}`);
      lines.push(`     ${row.reason ?? "refused by the validators"}`);
    }
  }
  if (session.length > 0) {
    lines.push("", `Granted for this session only (${session.length}):`);
    for (const row of session) lines.push(`  ${row.n}. ${patternOnOneLine(row.pattern)}`);
  }
  lines.push("", `File: ${view.path}`);
  if (view.rows.length > 0) lines.push("Remove one with /permissions remove <number>, or keryx permissions remove <number>.");
  return lines;
}

export interface RemoveResult {
  ok: boolean;
  text: string;
  pattern?: string;
}

export interface RemoveOptions {
  dir?: string;
  /** The running shell's session set; the pattern leaves it too. */
  sessionAllow?: Set<string>;
  /** Runs after a rule was removed from the file (the shell refreshes its tamper fingerprint). */
  onChanged?: () => void;
}

/** Which row a `remove` argument names: its number, or the exact pattern text. */
export function resolvePermissionTarget(view: PermissionsView, target: string): PermissionRow | undefined {
  const wanted = target.trim();
  if (wanted.length === 0) return undefined;
  const byText = view.rows.find((row) => row.pattern === wanted);
  if (byText !== undefined) return byText;
  if (/^\d+$/.test(wanted)) return view.rows.find((row) => row.n === Number(wanted));
  return undefined;
}

/** Remove one rule by number or exact pattern. A rule that is gone, or never was, is said so and nothing changes. */
export function removePermission(target: string, options: RemoveOptions = {}): RemoveResult {
  const view = loadPermissionsView({
    ...(options.dir !== undefined ? { dir: options.dir } : {}),
    ...(options.sessionAllow !== undefined ? { sessionAllow: options.sessionAllow } : {}),
  });
  const row = resolvePermissionTarget(view, target);
  if (row === undefined) {
    return { ok: false, text: `No saved rule matches ${JSON.stringify(target.trim())}. Run list to see the numbers.` };
  }
  if (row.kind === "session") {
    options.sessionAllow?.delete(row.pattern);
    return { ok: true, pattern: row.pattern, text: `Removed the session grant: ${patternOnOneLine(row.pattern)}` };
  }
  if (!removeShellPattern(row.pattern, options.dir)) {
    return { ok: false, pattern: row.pattern, text: `Could not remove ${patternOnOneLine(row.pattern)} from ${view.path}.` };
  }
  options.sessionAllow?.delete(row.pattern);
  options.onChanged?.();
  return { ok: true, pattern: row.pattern, text: `Removed: ${patternOnOneLine(row.pattern)}. It asks again from now on.` };
}

/** The readline and TUI `/permissions [list | remove <number|pattern>]`. */
export function permissionsSlashText(rest: string, options: RemoveOptions = {}): string {
  const trimmed = rest.trim();
  const [sub] = trimmed.split(/\s+/);
  if (sub === "remove" || sub === "rm") {
    const target = trimmed.slice(sub.length).trim();
    if (target.length === 0) return "Usage: /permissions remove <number | pattern>\n";
    return `${removePermission(target, options).text}\n`;
  }
  if (trimmed.length > 0 && sub !== "list") return "Usage: /permissions [list | remove <number | pattern>]\n";
  return `${permissionsLines(
    loadPermissionsView({
      ...(options.dir !== undefined ? { dir: options.dir } : {}),
      ...(options.sessionAllow !== undefined ? { sessionAllow: options.sessionAllow } : {}),
    }),
  ).join("\n")}\n`;
}

function printPermissionsHelp(): void {
  console.log(
    [
      "Usage: keryx permissions <subcommand>",
      "",
      "  keryx permissions list [--json]        The saved shell rules: honoured, and not honoured with the reason.",
      "  keryx permissions remove <number|pattern>",
      "                                         Take one rule back. The number is the one `list` prints.",
      "",
      "A rule is saved when an approval is answered with Always, in the shell or from Telegram. It",
      "is removed here, never from a chat. A running shell stops using a removed rule on its next",
      "approval and warns that the file changed.",
    ].join("\n"),
  );
}

export async function permissionsCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || sub === "help") {
    printPermissionsHelp();
    return;
  }
  if (sub === undefined || sub === "list" || sub === "--json") {
    const flags = sub === "--json" ? [sub, ...rest] : rest;
    const unknown = flags.filter((arg) => arg !== "--json");
    if (unknown.length > 0) {
      throw new Error(`Unknown option${unknown.length > 1 ? "s" : ""} for \`keryx permissions list\`: ${unknown.join(", ")}. Accepted: --json.`);
    }
    const view = loadPermissionsView();
    if (flags.includes("--json")) {
      console.log(
        JSON.stringify(
          {
            path: view.path,
            rules: view.rows.map((row) => ({
              n: row.n,
              pattern: row.pattern,
              honoured: row.kind === "active",
              ...(row.reason !== undefined ? { reason: row.reason } : {}),
            })),
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(permissionsLines(view).join("\n"));
    return;
  }
  if (sub === "remove" || sub === "rm") {
    const target = rest.join(" ").trim();
    if (target.length === 0 || target.startsWith("--")) {
      throw new Error("Usage: keryx permissions remove <number | pattern>");
    }
    const result = removePermission(target);
    if (!result.ok) throw new Error(result.text);
    console.log(result.text);
    return;
  }
  throw new Error(`Unknown permissions subcommand: ${sub}. Run \`keryx permissions --help\`.`);
}
