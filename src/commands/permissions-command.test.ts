// Flow 396 (AC7): the saved shell rules can be listed and taken back, from the CLI, the readline and
// TUI `/permissions`, and a removal reaches a shell that is already running.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI_ROUTES } from "../cli";
import { groupUsage } from "../cli-registry";
import { GROUP_SUBCOMMANDS } from "../lib/group-subcommands";
import {
  allowShellPattern,
  loadShellPermissions,
  loadShellPermissionsWithAudit,
  removeShellPattern,
  saveShellPermissions,
  shellPermissionsFingerprint,
  shellPermissionsPath,
} from "../lib/shell-permissions";
import { evaluateShellApproval, rememberExactShellGrant } from "./shell-approval";
import {
  loadPermissionsView,
  patternOnOneLine,
  permissionsCommand,
  permissionsLines,
  permissionsSlashText,
  removePermission,
} from "./permissions-command";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-permissions-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The approver's view of the saved list in `dir`, the way the shells wire it. */
const ioFor = (where: string) => ({
  loadAudit: () => loadShellPermissionsWithAudit(where),
  fingerprint: () => shellPermissionsFingerprint(where),
});

function judge(command: string, sessionAllow: Set<string>) {
  return evaluateShellApproval({
    inputJson: JSON.stringify({ command }),
    sessionAllow,
    fingerprintAtStart: shellPermissionsFingerprint(dir),
    io: ioFor(dir),
  });
}

describe("removeShellPattern", () => {
  test("removes exactly that pattern and keeps the file owner-only", () => {
    saveShellPermissions({ allow: ["bun test src/a.test.ts", "bun test src/b.test.ts"] }, dir);
    expect(removeShellPattern("bun test src/a.test.ts", dir)).toBe(true);
    expect(loadShellPermissions(dir).allow).toEqual(["bun test src/b.test.ts"]);
    expect(statSync(shellPermissionsPath(dir)).mode & 0o777).toBe(0o600);
  });

  test("a pattern that is not there changes nothing and says so", () => {
    saveShellPermissions({ allow: ["ls -la"] }, dir);
    const before = readFileSync(shellPermissionsPath(dir), "utf8");
    expect(removeShellPattern("ls", dir)).toBe(false);
    expect(readFileSync(shellPermissionsPath(dir), "utf8")).toBe(before);
  });

  test("a missing or unreadable file is left alone", () => {
    expect(removeShellPattern("ls", dir)).toBe(false);
    expect(existsSync(shellPermissionsPath(dir))).toBe(false);
    writeFileSync(shellPermissionsPath(dir), "{not json", "utf8");
    expect(removeShellPattern("ls", dir)).toBe(false);
    expect(readFileSync(shellPermissionsPath(dir), "utf8")).toBe("{not json");
  });

  test("removing one rule never deletes a rule the validators no longer honour", () => {
    saveShellPermissions({ allow: ["ls -la", "bash *", "bun test src/a.test.ts"] }, dir, { skipValidation: true });
    expect(removeShellPattern("ls -la", dir)).toBe(true);
    const raw = JSON.parse(readFileSync(shellPermissionsPath(dir), "utf8")) as { allow: string[] };
    expect(raw.allow).toEqual(["bash *", "bun test src/a.test.ts"]);
  });
});

describe("the rules list", () => {
  test("honoured first, then the ones not honoured with the reason, then session-only grants", () => {
    saveShellPermissions({ allow: ["ls -la", "bash *"] }, dir, { skipValidation: true });
    const view = loadPermissionsView({ dir, sessionAllow: new Set(["ls -la", "git status"]) });
    expect(view.rows.map((row) => [row.n, row.kind, row.pattern])).toEqual([
      [1, "active", "ls -la"],
      [2, "inactive", "bash *"],
      [3, "session", "git status"],
    ]);
    expect(view.rows[1]?.reason).toContain("arbitrary execution");
    const text = permissionsLines(view).join("\n");
    expect(text).toContain("Saved shell rules (1)");
    expect(text).toContain("Not honoured (1)");
    expect(text).toContain("Granted for this session only (1)");
    expect(text).toContain(shellPermissionsPath(dir));
  });

  test("an empty list says every non-read-only command asks", () => {
    expect(permissionsLines(loadPermissionsView({ dir })).join("\n")).toContain("every command that is not read-only asks first");
  });

  test("a multi-line pattern is shown on one line", () => {
    expect(patternOnOneLine("cat > f <<'EOF'\nbody\nEOF")).toBe("cat > f <<'EOF'\\nbody\\nEOF");
  });
});

describe("removePermission", () => {
  test("by number, as the list prints it", () => {
    saveShellPermissions({ allow: ["ls -la", "pwd"] }, dir);
    const result = removePermission("2", { dir });
    expect(result.ok).toBe(true);
    expect(result.pattern).toBe("pwd");
    expect(loadShellPermissions(dir).allow).toEqual(["ls -la"]);
  });

  test("by the exact pattern text, spaces and all", () => {
    saveShellPermissions({ allow: ["bun test src/a.test.ts"] }, dir);
    expect(removePermission("bun test src/a.test.ts", { dir }).ok).toBe(true);
    expect(loadShellPermissions(dir).allow).toEqual([]);
  });

  test("an unknown number or pattern is refused and nothing changes", () => {
    saveShellPermissions({ allow: ["ls -la"] }, dir);
    expect(removePermission("7", { dir }).ok).toBe(false);
    expect(removePermission("rm -rf /", { dir }).ok).toBe(false);
    expect(loadShellPermissions(dir).allow).toEqual(["ls -la"]);
  });

  test("a rule that is not honoured can still be removed", () => {
    saveShellPermissions({ allow: ["bash *"] }, dir, { skipValidation: true });
    expect(removePermission("bash *", { dir }).ok).toBe(true);
    expect(loadShellPermissionsWithAudit(dir).rejected).toEqual([]);
  });

  test("a session-only grant leaves the session set and touches no file", () => {
    const session = new Set(["git status"]);
    const result = removePermission("git status", { dir, sessionAllow: session });
    expect(result.ok).toBe(true);
    expect(session.has("git status")).toBe(false);
    expect(existsSync(shellPermissionsPath(dir))).toBe(false);
  });

  test("onChanged runs after a removal from the file and not after a refusal", () => {
    saveShellPermissions({ allow: ["ls -la"] }, dir);
    let changed = 0;
    removePermission("9", { dir, onChanged: () => (changed += 1) });
    expect(changed).toBe(0);
    removePermission("1", { dir, onChanged: () => (changed += 1) });
    expect(changed).toBe(1);
  });
});

describe("a removal reaches a shell that is already running (AC7)", () => {
  test("the rule approves, is removed, and the next call in the same session asks", () => {
    const session = new Set<string>();
    expect(rememberExactShellGrant("bun test src/foo.test.ts", session, { dir })).toBe("bun test src/foo.test.ts");
    expect(judge("bun test src/foo.test.ts", session).autoApprove).toBe(true);

    removePermission("bun test src/foo.test.ts", { dir });
    const after = judge("bun test src/foo.test.ts", session);
    expect(after.autoApprove).toBe(false);
    expect(session.has("bun test src/foo.test.ts")).toBe(false);
  });

  test("removed from the file by another process (the CLI), the running session stops approving it too", () => {
    const session = new Set<string>();
    allowShellPattern("pwd", dir);
    expect(judge("pwd", session).autoApprove).toBe(true);
    const fingerprintAtStart = shellPermissionsFingerprint(dir);
    removeShellPattern("pwd", dir);
    const after = evaluateShellApproval({
      inputJson: JSON.stringify({ command: "pwd" }),
      sessionAllow: session,
      fingerprintAtStart,
      io: ioFor(dir),
    });
    expect(after.autoApprove).toBe(false);
    // the file changed under the running shell: the existing tamper warning is how it learns that
    expect(after.tampered).toBe(true);
  });

  test("a grant made for this session only survives a removal of a different rule", () => {
    const session = new Set<string>(["ls -la"]);
    allowShellPattern("pwd", dir);
    expect(judge("pwd", session).autoApprove).toBe(true);
    removeShellPattern("pwd", dir);
    expect(judge("ls -la", session).autoApprove).toBe(true);
    expect(judge("pwd", session).autoApprove).toBe(false);
  });

  test("the shell refreshing its fingerprint after its own removal does not warn", () => {
    const session = new Set<string>();
    allowShellPattern("pwd", dir);
    judge("pwd", session);
    removePermission("pwd", { dir, sessionAllow: session });
    const evaluation = evaluateShellApproval({
      inputJson: JSON.stringify({ command: "pwd" }),
      sessionAllow: session,
      fingerprintAtStart: shellPermissionsFingerprint(dir),
      io: ioFor(dir),
    });
    expect(evaluation.tampered).toBe(false);
    expect(evaluation.autoApprove).toBe(false);
  });
});

describe("the /permissions text (readline and the TUI transcript)", () => {
  test("bare and list show the rules", () => {
    saveShellPermissions({ allow: ["ls -la"] }, dir);
    expect(permissionsSlashText("", { dir })).toContain("1. ls -la");
    expect(permissionsSlashText("list", { dir })).toContain("1. ls -la");
  });

  test("remove takes a number or a pattern with spaces, and empties the running session's copy", () => {
    saveShellPermissions({ allow: ["bun test src/a.test.ts", "pwd"] }, dir);
    const session = new Set(["bun test src/a.test.ts", "pwd"]);
    expect(permissionsSlashText("remove bun test src/a.test.ts", { dir, sessionAllow: session })).toContain("Removed:");
    expect(session.has("bun test src/a.test.ts")).toBe(false);
    expect(permissionsSlashText("remove 1", { dir, sessionAllow: session })).toContain("Removed: pwd");
  });

  test("a mistake prints usage", () => {
    expect(permissionsSlashText("remove", { dir })).toContain("Usage: /permissions remove");
    expect(permissionsSlashText("add ls", { dir })).toContain("Usage: /permissions [list | remove");
  });

  test("nothing in /permissions can add a rule", () => {
    expect(permissionsSlashText("allow ls", { dir })).toContain("Usage:");
    expect(loadShellPermissions(dir).allow).toEqual([]);
  });
});

describe("keryx permissions (CLI)", () => {
  let captured: string[] = [];
  let originalLog: typeof console.log;
  let originalXdg: string | undefined;
  beforeEach(() => {
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    captured = [];
    originalLog = console.log;
    console.log = ((...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
    }) as typeof console.log;
  });
  afterEach(() => {
    console.log = originalLog;
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
  });

  test("list --json carries the pattern, whether it is honoured and why not", async () => {
    saveShellPermissions({ allow: ["ls -la", "bash *"] }, path.join(dir, "keryx"), { skipValidation: true });
    await permissionsCommand(["list", "--json"]);
    const parsed = JSON.parse(captured.join("\n")) as { rules: Array<{ n: number; pattern: string; honoured: boolean; reason?: string }> };
    expect(parsed.rules.map((rule) => [rule.pattern, rule.honoured])).toEqual([
      ["ls -la", true],
      ["bash *", false],
    ]);
    expect(parsed.rules[1]?.reason).toContain("arbitrary execution");
  });

  test("remove prints what it removed and an unknown rule is an error", async () => {
    saveShellPermissions({ allow: ["ls -la"] }, path.join(dir, "keryx"));
    await permissionsCommand(["remove", "1"]);
    expect(captured.join("\n")).toContain("Removed: ls -la");
    await expect(permissionsCommand(["remove", "1"])).rejects.toThrow(/No saved rule/);
    await expect(permissionsCommand(["remove"])).rejects.toThrow(/Usage: keryx permissions remove/);
    await expect(permissionsCommand(["add", "ls"])).rejects.toThrow(/Unknown permissions subcommand/);
  });

  test("the verb is routed and its group has the subcommand vocabulary", () => {
    expect(CLI_ROUTES.permissions).toBeDefined();
    expect(GROUP_SUBCOMMANDS.get("permissions")).toEqual(["list", "remove"]);
    expect(groupUsage("permissions")).toContain("keryx permissions list");
  });

  test("a real process lists and removes against the config directory", () => {
    saveShellPermissions({ allow: ["ls -la"] }, path.join(dir, "keryx"));
    const env = { ...process.env, XDG_DATA_HOME: dir };
    const listed = Bun.spawnSync(["bun", "src/cli.ts", "permissions", "list"], { cwd: REPO_ROOT, env });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString()).toContain("1. ls -la");
    const removed = Bun.spawnSync(["bun", "src/cli.ts", "permissions", "remove", "1"], { cwd: REPO_ROOT, env });
    expect(removed.exitCode).toBe(0);
    expect(loadShellPermissions(path.join(dir, "keryx")).allow).toEqual([]);
  });
});
