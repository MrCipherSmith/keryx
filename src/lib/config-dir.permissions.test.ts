// Every writer of the shared user-global config directory leaves it owner-only.
//
// A security review of PR #216 demonstrated the consequence end to end. The
// directory is usually created first by `saveShellConfig`, which passed no mode
// at all, so under the common `umask 002` it exists as 0775 by the time anything
// else runs — and `mkdirSync`'s `mode` is a no-op on a directory that already
// exists. Group write on the DIRECTORY is enough on its own: an attacker does
// not need to write through the files, they unlink and replace them, and the
// per-file 0600 they then set defeats a fail-closed check that only inspects the
// file. The reviewer swapped the serve credential store for one holding the salt
// and hash of a token they chose and authenticated as the operator; the same
// handle replaces `auth.json` and its plaintext provider API keys.
//
// The first fix tightened the one writer the finding named (`writeStore` in
// `serve-credential.ts`) and left `saveShellConfig`, `saveServeConfig` and
// `saveProjectRegistry` alone — the failure the flow-127 lesson file calls "the
// fix was applied where the finding pointed, not everywhere the class lived".
// This file IS the class: it drives all five writers, under a permissive umask,
// against a directory that already exists group-writable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir } from "./config-dir";
import { saveApiKey, saveShellConfig } from "./shell-config";
import { defaultServeConfig, saveServeConfig } from "./serve-config";
import { issueServeToken } from "./serve-credential";
import { registerProject } from "./project-registry";

let base = "";
let configDir = "";
let originalUmask = 0;

/** The permission bits as an octal string: `"700"`, `"775"`, … */
function mode(target: string): string {
  return (statSync(target).mode & 0o777).toString(8);
}

/** Put the shared directory into the state the attack needs: group-writable. */
function widenConfigDir(): void {
  mkdirSync(configDir, { recursive: true });
  chmodSync(configDir, 0o775);
  // Not decoration: if this ever stopped holding, every assertion below would
  // pass against a directory that was never wide in the first place.
  expect(mode(configDir)).toBe("775");
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-configdir-mode-"));
  configDir = path.join(base, "keryx");
  // The umask most enterprise Linux images ship with, and the one that turns a
  // mode-less `mkdirSync(..., { recursive: true })` into a 0775 directory.
  originalUmask = process.umask(0o002);
});

afterEach(() => {
  process.umask(originalUmask);
  rmSync(base, { recursive: true, force: true });
});

describe("ensureKeryxConfigDir", () => {
  test("creates the directory owner-only under a permissive umask", () => {
    if (process.platform === "win32") {
      return;
    }
    const created = ensureKeryxConfigDir(configDir);

    expect(created).toBe(configDir);
    expect(mode(configDir)).toBe("700");
  });

  test("tightens a directory that already exists group-writable", () => {
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();

    ensureKeryxConfigDir(configDir);

    expect(mode(configDir)).toBe("700");
  });

  test("resolves the same location as keryxConfigDir", () => {
    // Otherwise a writer could tighten one directory and write into another.
    expect(ensureKeryxConfigDir(configDir)).toBe(keryxConfigDir(configDir));
  });

  test("never throws when the directory cannot be created", () => {
    // Best-effort by contract: every caller treats a persistence failure as
    // "the operator re-enters it next time", not as a crash.
    if (process.platform === "win32") {
      return;
    }
    const locked = path.join(base, "locked");
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o500);
    try {
      expect(() => ensureKeryxConfigDir(path.join(locked, "keryx"))).not.toThrow();
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});

describe("every writer of the shared config directory tightens it", () => {
  test("saveShellConfig", () => {
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();

    saveShellConfig({ provider: "openrouter" }, configDir);

    expect(mode(configDir)).toBe("700");
    expect(mode(path.join(configDir, "auth.json"))).toBe("600");
  });

  test("saveApiKey", () => {
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();

    saveApiKey("OPENROUTER_API_KEY", "not-a-real-key", configDir);

    expect(mode(configDir)).toBe("700");
    expect(mode(path.join(configDir, "auth.json"))).toBe("600");
  });

  test("saveServeConfig", () => {
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();

    expect(saveServeConfig(defaultServeConfig("cred-id"), configDir)).toBe(true);

    expect(mode(configDir)).toBe("700");
    expect(mode(path.join(configDir, "serve.json"))).toBe("600");
  });

  test("saveProjectRegistry, through registerProject", () => {
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();
    const project = path.join(base, "project");
    mkdirSync(path.join(project, ".metaproject"), { recursive: true });

    expect(registerProject(project, { dir: configDir }).ok).toBe(true);

    expect(mode(configDir)).toBe("700");
    expect(mode(path.join(configDir, "projects.json"))).toBe("600");
  });

  test("issueServeToken", () => {
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();

    expect(issueServeToken(configDir).ok).toBe(true);

    expect(mode(configDir)).toBe("700");
    expect(mode(path.join(configDir, "serve-credentials.json"))).toBe("600");
  });

  test("a later writer does not re-loosen what an earlier one tightened", () => {
    // The realistic ordering: serve tightens, then the operator opens the shell
    // and switches model. A mode-less `mkdirSync` there is harmless on an
    // existing directory, but any writer that re-created or re-chmodded it wide
    // would silently reopen the hole this file exists to close.
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();
    expect(issueServeToken(configDir).ok).toBe(true);
    expect(mode(configDir)).toBe("700");

    saveShellConfig({ model: "some-model" }, configDir);
    saveServeConfig(defaultServeConfig("cred-id"), configDir);

    expect(mode(configDir)).toBe("700");
  });
});
