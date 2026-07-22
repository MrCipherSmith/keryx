// Flow 115 / finding 2: an agent must not be able to grant itself permissions.
//
// `permissions.json` lives in `~/.local/share/keryx/`, which the sandbox's
// read-deny list did not cover (it listed `~/.config/keryx`, a different path),
// and the TUI re-reads that file before EVERY approval. So a single approved
// command that wrote to it would disable the approval gate for every future
// session — silently, because nothing checked the file for external change.
//
// Measured context: `KERYX_SANDBOX_SHELL=off` is the default and one host has no
// sandbox launcher at all, so a fix that only hardens the sandbox profile fixes
// nothing in the configuration people actually run. The primary barrier must be
// independent of containment.

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { touchesAgentCredentials } from "./command-risk";
import {
  isShellCommandAllowed,
  shellPermissionsFingerprint,
  validateShellPattern,
  saveShellPermissions,
} from "./shell-permissions";
import { defaultReadDenyList } from "../harness/process/sandbox/profile";

// --- the independent, sandbox-agnostic barrier ------------------------------

test("touchesAgentCredentials recognises writes to the agent's own permission files", () => {
  for (const cmd of [
    "echo '{\"allow\":[\"* *\"]}' > ~/.local/share/keryx/permissions.json",
    "cp /tmp/evil.json ~/.local/share/keryx/permissions.json",
    "mv /tmp/x ~/.local/share/keryx/auth.json",
    "sed -i '' 's/a/b/' permissions.json",
    "tee ~/.local/share/keryx/permissions.json",
    "python3 -c \"open('auth.json','w')\"",
    "cat ~/.config/keryx/auth.json",
    "cat ~/.local/share/keryx/auth.json",
  ]) {
    expect(`${cmd} => ${touchesAgentCredentials(cmd)}`).toBe(`${cmd} => true`);
  }
});

test("touchesAgentCredentials leaves ordinary commands alone", () => {
  for (const cmd of [
    "ls",
    "git status",
    "keryx wiki index",
    "ls ~/.local/share",
    "cat package.json",
    "bun test",
  ]) {
    expect(`${cmd} => ${touchesAgentCredentials(cmd)}`).toBe(`${cmd} => false`);
  }
});

test("a command touching the permission files is never auto-approved", () => {
  // Even under a pattern the user legitimately granted.
  expect(isShellCommandAllowed("cat ~/.local/share/keryx/auth.json", ["cat *"])).toBe(false);
  expect(isShellCommandAllowed("cat package.json", ["cat *"])).toBe(true);
});

test("a command touching the permission files can never be remembered", () => {
  const v = validateShellPattern("cat ~/.local/share/keryx/auth.json");
  expect(v.ok).toBe(false);
  expect(v.ok === false && v.reason).toMatch(/credential|permission/i);
});

// --- defence in depth: sandbox masking --------------------------------------

test("the sandbox read-deny list covers the keryx data dir, not just the config dir", () => {
  const deny = defaultReadDenyList("/home/tester");
  expect(deny).toContain("/home/tester/.config/keryx");
  expect(deny).toContain("/home/tester/.local/share/keryx");
});

test("masking applies to the contained child only — the CLI still reads its own auth", () => {
  // `defaultReadDenyList` is data handed to the launcher for the CHILD process.
  // It must never be consulted by keryx itself, so the CLI can still load
  // auth.json in-process. Pinning the shape here: the function is pure and
  // returns paths, it does not touch the filesystem or the current process.
  const deny = defaultReadDenyList(homedir());
  expect(Array.isArray(deny)).toBe(true);
  expect(deny.every((p) => path.isAbsolute(p))).toBe(true);
  // No home ⇒ nothing to deny (never an accidental "/" entry).
  expect(defaultReadDenyList(undefined)).toEqual([]);
});

// --- external-modification detection ----------------------------------------

test("shellPermissionsFingerprint changes when the file changes, and is stable otherwise", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-fp-"));
  try {
    const missing = shellPermissionsFingerprint(dir);
    saveShellPermissions({ allow: ["keryx *"] }, dir);
    const first = shellPermissionsFingerprint(dir);
    const again = shellPermissionsFingerprint(dir);
    expect(first).not.toBe(missing);
    expect(again).toBe(first);

    saveShellPermissions({ allow: ["keryx *", "ls *"] }, dir);
    expect(shellPermissionsFingerprint(dir)).not.toBe(first);

    // A hand-edit outside keryx is detected the same way.
    writeFileSync(path.join(dir, "permissions.json"), '{"allow":["ls *"]}\n');
    const edited = shellPermissionsFingerprint(dir);
    expect(edited).not.toBe(first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
