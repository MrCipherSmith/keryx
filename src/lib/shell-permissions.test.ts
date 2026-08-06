import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  allowShellPattern,
  emptyShellPermissions,
  isShellCommandAllowed,
  loadShellPermissions,
  matchShellPattern,
  parseShellExecCommand,
  saveShellPermissions,
  suggestShellPatterns,
} from "./shell-permissions";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "keryx-perms-"));
  dirs.push(d);
  return d;
}

test("matchShellPattern: exact, star, and question mark", () => {
  expect(matchShellPattern("keryx wiki index", "keryx wiki index")).toBe(true);
  expect(matchShellPattern("keryx wiki index", "keryx wiki collect")).toBe(false);
  expect(matchShellPattern("keryx *", "keryx wiki index")).toBe(true);
  expect(matchShellPattern("keryx *", "git status")).toBe(false);
  expect(matchShellPattern("git status*", "git status")).toBe(true);
  expect(matchShellPattern("git status*", "git status --short")).toBe(true);
  expect(matchShellPattern("ls ?", "ls a")).toBe(true);
  expect(matchShellPattern("ls ?", "ls ab")).toBe(false);
});

test("matchShellPattern: * matches newlines (heredoc / multiline shell_exec)", () => {
  const heredoc = "cat > /tmp/run.sh << 'SCRIPT'\n#!/bin/bash\nset -euo pipefail\necho ok\nSCRIPT";
  expect(matchShellPattern("cat *", heredoc)).toBe(true);
  expect(matchShellPattern("cat *", "cat /tmp/other.sh")).toBe(true);
  expect(matchShellPattern("bash *", heredoc)).toBe(false);
  // exact full multiline
  expect(matchShellPattern(heredoc, heredoc)).toBe(true);

  // The raw glob still matches — matchShellPattern is only string matching.
  // The GATE no longer accepts it: since flow 115 a command carrying unquoted
  // metacharacters (`>` and `<<` here) is never auto-approved, so a heredoc asks
  // every time. Deliberate fail-closed trade: separating a redirect from a
  // heredoc body needs a shell parser, a worse failure surface than one extra
  // confirmation. See shell-permissions-hardening.test.ts.
  const heredoc2 = "cat > /tmp/run_all_probes.sh << 'SCRIPT'\n#!/bin/bash\necho B-F\nSCRIPT";
  expect(matchShellPattern("cat *", heredoc2)).toBe(true);
  expect(isShellCommandAllowed(heredoc2, ["cat *"])).toBe(false);
});

test("isShellCommandAllowed scans allow list", () => {
  // `keryx wiki*` rather than `keryx *`: since flow 138 the bare grant is refused
  // (`keryx ctx run -- <command>` runs anything), while a narrowing pattern for
  // the same word stays offerable — which is the behaviour being sampled here.
  const allow = ["keryx wiki*", "git status"];
  expect(isShellCommandAllowed("keryx wiki index", allow)).toBe(true);
  expect(isShellCommandAllowed("git status", allow)).toBe(true);
  expect(isShellCommandAllowed("rm -rf /", allow)).toBe(false);
  expect(isShellCommandAllowed("", allow)).toBe(false);
});

test("suggestShellPatterns: exact + first-token prefix", () => {
  // Since flow 115 each suggestion also says whether it may be OFFERED.
  // `keryx *` stopped being offerable in flow 138 — same reason `git *` did, one
  // step closer to home: `keryx ctx run -- <command>` executes an arbitrary
  // program. The exact command is still offerable.
  expect(suggestShellPatterns("keryx wiki index")).toEqual({
    exact: "keryx wiki index",
    prefix: "keryx *",
    offerExact: true,
    offerPrefix: false,
  });
  // `git *` is no longer offerable (git -c/-exec run arbitrary commands), but
  // the exact command still is.
  expect(suggestShellPatterns("  git   status  --short ")).toEqual({
    exact: "git status --short",
    prefix: "git *",
    offerExact: true,
    offerPrefix: false,
  });
  // A heredoc carries metacharacters ⇒ the exact grant is not offerable; and
  // since F4 `cat *` is a banned broad-reader prefix, so neither grant is offered.
  const multi = "cat > /tmp/x.sh << 'EOF'\nline2\nEOF";
  expect(suggestShellPatterns(multi)).toEqual({
    exact: multi,
    prefix: "cat *",
    offerExact: false,
    offerPrefix: false,
  });
});

test("parseShellExecCommand: JSON or raw", () => {
  expect(parseShellExecCommand(JSON.stringify({ command: "keryx wiki index" }))).toBe("keryx wiki index");
  expect(parseShellExecCommand("git status")).toBe("git status");
});

test("load/save/allowShellPattern round-trip", () => {
  const dir = tempDir();
  expect(loadShellPermissions(dir)).toEqual(emptyShellPermissions());
  allowShellPattern("keryx wiki*", dir);
  allowShellPattern("keryx wiki*", dir); // dedupe
  allowShellPattern("git status", dir);
  const loaded = loadShellPermissions(dir);
  expect(loaded.allow).toEqual(["keryx wiki*", "git status"]);
  saveShellPermissions({ allow: ["bun test*"] }, dir);
  expect(loadShellPermissions(dir).allow).toEqual(["bun test*"]);
});
