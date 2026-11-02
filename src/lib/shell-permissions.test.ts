import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("allowShellPattern reports a grant it could not store as not remembered", () => {
  // The config dir is a regular file, so nothing can be written under it.
  const blocker = path.join(tempDir(), "not-a-dir");
  writeFileSync(blocker, "x");
  expect(allowShellPattern("git status", blocker)).toBe("");
  expect(allowShellPattern("git status", tempDir())).toBe("git status");
});

test("matchShellPattern: exact, and a trailing star", () => {
  expect(matchShellPattern("keryx wiki index", "keryx wiki index")).toBe(true);
  expect(matchShellPattern("keryx wiki index", "keryx wiki collect")).toBe(false);
  expect(matchShellPattern("keryx *", "keryx wiki index")).toBe(true);
  expect(matchShellPattern("keryx *", "git status")).toBe(false);
  expect(matchShellPattern("git status*", "git status")).toBe(true);
  expect(matchShellPattern("git status*", "git status --short")).toBe(true);
  // `?` and a non-trailing `*` are no longer wildcards: such a pattern is invalid and matches nothing.
  expect(matchShellPattern("ls ?", "ls a")).toBe(false);
  expect(matchShellPattern("ls ?", "ls ?")).toBe(false);
  // Escaped, they are literal.
  expect(matchShellPattern("ls \\?", "ls ?")).toBe(true);
  expect(matchShellPattern("ls \\?", "ls a")).toBe(false);
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
  const allow = ["keryx *", "git status"];
  expect(isShellCommandAllowed("keryx wiki index", allow)).toBe(true);
  expect(isShellCommandAllowed("git status", allow)).toBe(true);
  expect(isShellCommandAllowed("rm -rf /", allow)).toBe(false);
  expect(isShellCommandAllowed("", allow)).toBe(false);
});

test("suggestShellPatterns: exact + first-token prefix", () => {
  // Since flow 115 each suggestion also says whether it may be OFFERED.
  // keryx is now treated like git/bash — its prefix grant is not offerable.
  expect(suggestShellPatterns("keryx wiki index")).toEqual({
    exact: "keryx wiki index",
    prefix: "keryx *",
    offerExact: true,
    offerPrefix: false,
  });
  // `git *` is no longer offerable (git -c/-exec run arbitrary commands), but
  // the exact command still is.
  // The exact grant is the command verbatim (trimmed only): collapsing spaces would store a
  // pattern that never matches the command again.
  expect(suggestShellPatterns("  git   status  --short ")).toEqual({
    exact: "git   status  --short",
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
  // "keryx *" is now rejected as a bare wildcard grant (like "git *")
  expect(allowShellPattern("keryx *", dir)).toBe("");
  // But a specific keryx command is allowed.
  expect(allowShellPattern("keryx wiki index", dir)).toBe("keryx wiki index");
  const loaded = loadShellPermissions(dir);
  expect(loaded.allow).toEqual(["keryx wiki index"]);
  saveShellPermissions({ allow: ["bun test*"] }, dir);
  expect(loadShellPermissions(dir).allow).toEqual(["bun test*"]);
});
