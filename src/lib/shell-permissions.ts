// Shell command allowlist for the interactive agent (inspired by OpenCode /
// Claude Code / Grok Build permission models).
//
// - OpenCode: bash rules with `*` wildcards; ask UI offers once / always / reject;
//   "always" stores a command-prefix pattern for the session (or config).
// - Claude Code: `permissions.allow: ["Bash(npm run *)"]` with Tool(specifier)
//   patterns; deny > ask > allow.
// - Grok Build: always-approve mode + remembered "always allow" for common
//   command prefixes.
//
// keryx stores shell allow patterns in `~/.local/share/keryx/permissions.json`
// (same XDG base as auth.json). Default is ask (prompt). Never throws.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { shellConfigPath } from "./shell-config";
import { isDestructiveCommand, touchesAgentCredentials } from "./command-risk";
import { createHash } from "node:crypto";
import { hasUnquotedMetacharacter } from "./shell-syntax";

export { hasUnquotedMetacharacter };

/** On-disk shell permission file shape. */
export interface ShellPermissions {
  /**
   * Glob patterns that auto-allow `shell_exec` without prompting.
   * Matching is case-sensitive; `*` / `?` wildcards (OpenCode-style).
   * Examples: `keryx wiki index`, `keryx *`, `git status*`.
   */
  allow: string[];
}

/**
 * Command words whose first token says nothing about what will actually run:
 * interpreters, generic wrappers, package/build runners, remote-exec and
 * download tools, container runtimes. A `<word> *` grant for any of them is a
 * grant of arbitrary code execution.
 *
 * The ban applies ONLY to the "everything after this word" form (`bash *`).
 * A narrower pattern that constrains the arguments (`bun test*`) is still
 * offerable, because it no longer covers arbitrary invocations.
 *
 * This list is an EXPEDIENT, not a boundary: it is inevitably incomplete. The
 * boundaries are the metacharacter rule and the destructive classifier below,
 * both of which apply to every pattern regardless of its first word.
 */
const PREFIX_BANNED: ReadonlySet<string> = new Set([
  // interpreters / runtimes
  "sh", "bash", "zsh", "ksh", "dash", "fish",
  "python", "python2", "python3", "node", "bun", "deno", "perl", "ruby", "php", "lua",
  "java", "dotnet", "rscript", "tclsh",
  // generic wrappers that execute their argument
  "env", "eval", "exec", "xargs", "nice", "nohup", "time", "watch", "script",
  "sudo", "doas", "su", "pkexec", "runas",
  // remote execution and transfer
  "ssh", "scp", "rsync", "nc", "ncat", "socat", "telnet",
  // download tools (a fetched script is arbitrary code)
  "curl", "wget", "fetch", "aria2c", "httpie", "http",
  // container / cluster runtimes (equivalent to root on the host)
  "docker", "podman", "nerdctl", "kubectl", "helm", "systemd-run",
  // build/package runners that execute project-defined scripts
  "make", "npm", "npx", "yarn", "pnpm", "cargo", "go", "gradle", "mvn", "ant",
  // tools whose flags execute arbitrary commands
  "git", "find", "awk", "gawk", "sed", "vim", "vi", "ex", "emacs", "gdb", "lldb",
  "at", "batch", "crontab", "tmux", "screen", "osascript", "open", "tee", "cd",
]);

/** Reason a pattern was refused (never silently dropped). */
export interface PatternRejection {
  pattern: string;
  reason: string;
}

/** Result of {@link validateShellPattern}. */
export type PatternValidation = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether `pattern` may EVER auto-approve a command without prompting.
 *
 * Refuses, in order:
 *  1. empty / whitespace-only — matches nothing meaningful;
 *  2. a comment (`#` …) — `# *` matches `"# note\nrm -rf /"`;
 *  3. an unquoted shell metacharacter — the pattern would be matched against raw
 *     text that `/bin/sh -c` re-interprets;
 *  4. a destructive command (see `command-risk.ts`) — this is what a stored
 *     exact `rm -rf /` defeats;
 *  5. a bare `<interpreter> *` grant.
 *
 * Pure.
 */
export function validateShellPattern(pattern: string): PatternValidation {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty pattern" };
  }
  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  if (firstToken.startsWith("#")) {
    return { ok: false, reason: "a comment is not a command: `# *` matches any text followed by any command" };
  }
  if (hasUnquotedMetacharacter(trimmed)) {
    return {
      ok: false,
      reason:
        "contains an unquoted shell metacharacter (; && || | ` $( < > &, or a newline); such a command can only be approved once, never remembered",
    };
  }
  if (isDestructiveCommand(trimmed)) {
    return { ok: false, reason: "destructive commands always require explicit confirmation and are never remembered" };
  }
  if (touchesAgentCredentials(trimmed)) {
    return {
      ok: false,
      reason:
        "touches the agent's own permission/credential files; remembering it would let one approved command disable the approval gate for every future session",
    };
  }
  const banned = bannedPrefixGrant(trimmed, firstToken);
  if (banned !== undefined) {
    return {
      ok: false,
      reason: `\`${banned} *\` grants arbitrary execution: ${banned} is an interpreter or wrapper, so its first token does not constrain what runs`,
    };
  }
  return { ok: true };
}

/**
 * The banned command word when `pattern` is a bare "everything after this word"
 * grant, else undefined. A pattern that narrows the arguments (`bun test*`) is
 * not a bare grant and is allowed.
 */
function bannedPrefixGrant(pattern: string, firstToken: string): string | undefined {
  const rest = pattern.slice(firstToken.length).trim();
  const wildcardOnly = /^\*+$/.test(rest) || (rest.length === 0 && /\*+$/.test(firstToken));
  if (!wildcardOnly) return undefined;
  const word = (firstToken.replace(/\*+$/, "").split("/").pop() ?? "").toLowerCase();
  return PREFIX_BANNED.has(word) ? word : undefined;
}

/** Empty permissions (prompt everything). */
export function emptyShellPermissions(): ShellPermissions {
  return { allow: [] };
}

/** Absolute path to `permissions.json` next to `auth.json`. */
export function shellPermissionsPath(dir?: string): string {
  return path.join(path.dirname(shellConfigPath(dir)), "permissions.json");
}

/** A load that also reports which stored patterns were refused, and why. */
export interface ShellPermissionsAudit {
  permissions: ShellPermissions;
  rejected: PatternRejection[];
}

/**
 * Load permissions and partition them through {@link validateShellPattern}.
 *
 * Refused patterns are reported, NOT deleted: the file on disk is left untouched
 * so the user can see and edit it, and so a load can never silently destroy a
 * grant the user might still want in a narrower form. The UI surfaces
 * `rejected` before the first auto-approve of a session.
 *
 * Never throws.
 */
export function loadShellPermissionsWithAudit(dir?: string): ShellPermissionsAudit {
  try {
    const file = shellPermissionsPath(dir);
    if (!existsSync(file)) {
      return { permissions: emptyShellPermissions(), rejected: [] };
    }
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object") {
      return { permissions: emptyShellPermissions(), rejected: [] };
    }
    const allowRaw = (raw as { allow?: unknown }).allow;
    const stored = Array.isArray(allowRaw)
      ? allowRaw.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
      : [];

    const allow: string[] = [];
    const rejected: PatternRejection[] = [];
    for (const pattern of stored) {
      const verdict = validateShellPattern(pattern);
      if (verdict.ok) allow.push(pattern);
      else rejected.push({ pattern, reason: verdict.reason });
    }
    return { permissions: { allow }, rejected };
  } catch {
    return { permissions: emptyShellPermissions(), rejected: [] };
  }
}

/**
 * Load the ACTIVE permissions. Patterns that fail validation are excluded — a
 * caller cannot opt out of the migration, only observe it via
 * {@link loadShellPermissionsWithAudit}. Never throws.
 */
export function loadShellPermissions(dir?: string): ShellPermissions {
  return loadShellPermissionsWithAudit(dir).permissions;
}

/** Options for {@link saveShellPermissions}. */
export interface SaveShellPermissionsOptions {
  /**
   * Write patterns verbatim without validating them. ONLY for tests that need to
   * reproduce a file written by an older keryx; never set on a user path.
   */
  skipValidation?: boolean;
}

/** Persist permissions (0600). Invalid patterns are dropped. Never throws. */
export function saveShellPermissions(
  perms: ShellPermissions,
  dir?: string,
  options: SaveShellPermissionsOptions = {},
): void {
  try {
    const file = shellPermissionsPath(dir);
    mkdirSync(path.dirname(file), { recursive: true });
    const cleaned = Array.from(new Set(perms.allow.map((p) => p.trim()).filter((p) => p.length > 0)));
    const body: ShellPermissions = {
      allow: options.skipValidation === true ? cleaned : cleaned.filter((p) => validateShellPattern(p).ok),
    };
    writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // best-effort
  }
}

/**
 * Append one allow pattern (deduped) and save. Best-effort; never throws.
 * Returns the pattern that was stored, or `""` when it was REFUSED — the caller
 * must treat `""` as "this command can be approved once, but not remembered".
 */
export function allowShellPattern(pattern: string, dir?: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (!validateShellPattern(trimmed).ok) {
    return "";
  }
  const current = loadShellPermissions(dir);
  if (!current.allow.includes(trimmed)) {
    current.allow.push(trimmed);
    saveShellPermissions(current, dir);
  }
  return trimmed;
}

/**
 * OpenCode-style glob: `*` = any run of chars **including newlines** (heredoc /
 * multiline shell_exec), `?` = one char (any, including newline), other chars literal.
 * Pure.
 *
 * Note: JS `RegExp` `.` does not match `\n` by default — we map `*` → `[\s\S]*`
 * so remembered prefixes like `cat *` match `cat > file <<'EOF'\n…\nEOF`.
 */
export function matchShellPattern(pattern: string, command: string): boolean {
  const p = pattern.trim();
  const c = command.trim();
  if (p.length === 0) {
    return false;
  }
  // Escape regex specials except our wildcards, then map * / ?.
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      // Dot-all: any run of characters including newlines.
      re += "[\\s\\S]*";
    } else if (ch === "?") {
      re += "[\\s\\S]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  try {
    return new RegExp(`^${re}$`).test(c);
  } catch {
    return p === c;
  }
}

/**
 * True when `command` may be auto-approved from the allowlist.
 *
 * Two barriers apply to the COMMAND before any pattern is consulted, and they
 * are independent of how the pattern was created — that is the point, because a
 * pattern saved by an older keryx (or hand-edited into the file) has not passed
 * {@link validateShellPattern}:
 *
 *  - an unquoted metacharacter means the string will be re-interpreted by
 *    `/bin/sh -c`, so a pattern match says nothing about what will run;
 *  - a destructive command always requires explicit confirmation.
 *
 * Pure.
 */
export function isShellCommandAllowed(command: string, allow: readonly string[]): boolean {
  const cmd = command.trim();
  if (cmd.length === 0) {
    return false;
  }
  if (hasUnquotedMetacharacter(cmd)) {
    return false;
  }
  if (isDestructiveCommand(cmd)) {
    return false;
  }
  if (touchesAgentCredentials(cmd)) {
    return false;
  }
  return allow.some((pat) => matchShellPattern(pat, cmd));
}

/**
 * Content fingerprint of the stored permission file (`""` when it does not
 * exist). A session captures this once and compares before each auto-approve:
 * a change mid-session means the allowlist was rewritten by something other
 * than the approval UI, which is exactly the self-grant path this flow closes.
 *
 * Never throws.
 */
export function shellPermissionsFingerprint(dir?: string): string {
  try {
    const file = shellPermissionsPath(dir);
    if (!existsSync(file)) {
      return "";
    }
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

/** What the approval UI may offer for one command. */
export interface ShellPatternSuggestion {
  exact: string;
  prefix: string;
  /** The UI may offer "always allow this exact command". */
  offerExact: boolean;
  /** The UI may offer "always allow anything starting with this word". */
  offerPrefix: boolean;
}

/**
 * Suggested patterns for the approval UI (OpenCode-style "always" grants), each
 * with a flag saying whether it may be OFFERED at all.
 *
 * - exact: full command (preserves newlines so heredoc matches on re-use)
 * - prefix: first token of the first line + ` *`
 *
 * A destructive command offers neither grant, whatever its shape: "always" on a
 * destructive command is the exact path that put a literal `rm -rf /` into a
 * live allowlist (flow 115).
 */
export function suggestShellPatterns(command: string): ShellPatternSuggestion {
  const trimmed = command.trim();
  // Preserve newlines for heredoc exact-match; collapse spaces on single-line only.
  const multiline = /[\r\n]/.test(trimmed);
  const exact = multiline ? trimmed : trimmed.replace(/\s+/g, " ");
  // First token from the first non-empty line only (ignore heredoc body).
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? trimmed;
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  const first = collapsed.split(" ")[0] ?? collapsed;
  const prefix = first.length > 0 ? `${first} *` : exact;
  const destructive = trimmed.length > 0 && isDestructiveCommand(trimmed);
  return {
    exact,
    prefix,
    offerExact: !destructive && validateShellPattern(exact).ok,
    offerPrefix: !destructive && validateShellPattern(prefix).ok,
  };
}

/** Parse `shell_exec` tool input JSON (or a raw command string) → command text. */
export function parseShellExecCommand(inputJson: string): string {
  try {
    const parsed: unknown = JSON.parse(inputJson);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as { command?: unknown }).command === "string") {
      return (parsed as { command: string }).command.trim();
    }
  } catch {
    // raw string
  }
  return inputJson.trim();
}
