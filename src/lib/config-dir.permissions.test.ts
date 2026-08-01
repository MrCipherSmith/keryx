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
// This file drives every writer under a permissive umask, against a directory
// that already exists group-writable — and against a FILE that already exists
// group-readable, which is the same creation-only trap one level down.
//
// It is not the only guard, and deliberately so. Three successive rounds of
// "every writer" turned out to mean "every writer I thought of": the sweep
// missed `createSession`, then `saveShellPermissions` and `saveSandboxDefaults`.
// `config-dir.writers.test.ts` reads the source and fails when a NEW writer
// appears, which is the part a behavioural test cannot do.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir } from "./config-dir";
import { saveApiKey, saveShellConfig } from "./shell-config";
import { defaultServeConfig, saveServeConfig } from "./serve-config";
import { issueServeToken } from "./serve-credential";
import { registerProject } from "./project-registry";
import { createSession } from "../session/store";
import { saveShellPermissions } from "./shell-permissions";
import { saveSandboxDefaults } from "./sandbox-config";

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

describe("every writer tightens a FILE that already exists too wide", () => {
  // The same creation-only trap as the directory mode, on the file path, and it
  // survived two fix rounds. `writeFileSync`'s `mode` does nothing to a file
  // that already exists, so a `serve.json` or `auth.json` left at 0664 by an
  // earlier release, a restore or an editor keeps that mode through every
  // subsequent write — and `keryx serve config set` rewrites on every call.
  //
  // Each case widens the file FIRST, then writes, then asserts 0600. Widening a
  // file the writer is about to create would prove nothing.
  function widenFile(name: string): string {
    const file = path.join(configDir, name);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(file, "{}\n", { mode: 0o664 });
    chmodSync(file, 0o664);
    expect(mode(file)).toBe("664");
    return file;
  }

  test("saveShellConfig, over an auth.json that already exists 0664", () => {
    if (process.platform === "win32") {
      return;
    }
    const file = widenFile("auth.json");

    saveShellConfig({ provider: "openrouter" }, configDir);

    expect(mode(file)).toBe("600");
  });

  test("saveServeConfig, over a serve.json that already exists 0664", () => {
    if (process.platform === "win32") {
      return;
    }
    const file = widenFile("serve.json");

    expect(saveServeConfig(defaultServeConfig("cred-id"), configDir)).toBe(true);

    expect(mode(file)).toBe("600");
  });

  test("the credential store REFUSES a widened file rather than tightening it", () => {
    // Deliberately different from the other three, and stronger. A widened
    // credential store means something outside keryx touched the file that
    // decides who may authenticate, so `readServeCredential` fails closed and
    // `issue` refuses rather than quietly writing a fresh credential over it.
    // Silently re-tightening would erase the only evidence the operator has.
    if (process.getuid?.() === 0 || process.platform === "win32") {
      return;
    }
    const file = widenFile("serve-credentials.json");

    const outcome = issueServeToken(configDir);

    expect(outcome.ok).toBe(false);
    // Untouched: a refusal must not be a write.
    expect(mode(file)).toBe("664");
    expect(readFileSync(file, "utf8")).toBe("{}\n");
  });

  test("a NEW credential store is created owner-only", () => {
    // The positive half, so the refusal above is not the only thing measured.
    if (process.platform === "win32") {
      return;
    }
    expect(issueServeToken(configDir).ok).toBe(true);

    expect(mode(path.join(configDir, "serve-credentials.json"))).toBe("600");
  });

  test("saveShellPermissions, over a permissions.json that already exists 0664", () => {
    if (process.platform === "win32") {
      return;
    }
    const file = widenFile("permissions.json");

    saveShellPermissions({ allow: ["git status"] }, configDir);

    expect(mode(file)).toBe("600");
  });

  test("saveSandboxDefaults, over a sandbox.json that already exists 0664", () => {
    if (process.platform === "win32") {
      return;
    }
    const file = widenFile("sandbox.json");

    saveSandboxDefaults({ maskMode: "auto" }, configDir);

    expect(mode(file)).toBe("600");
  });

  test("the project registry, over a projects.json that already exists 0664", () => {
    if (process.platform === "win32") {
      return;
    }
    const file = widenFile("projects.json");
    const project = path.join(base, "registry-project");
    mkdirSync(path.join(project, ".metaproject"), { recursive: true });

    expect(registerProject(project, { dir: configDir }).ok).toBe(true);

    expect(mode(file)).toBe("600");
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

  test("the session store, which creates the shared directory on `keryx shell`", () => {
    // The writer the first sweep missed. `createSession` used a mode-less
    // recursive `mkdirSync`, and with `KERYX_DATA_DIR` unset its top level IS
    // this directory — so on a fresh install under `umask 002` the first
    // `keryx shell` created `~/.local/share/keryx` at 0775 before any config
    // writer existed to tighten it, and every level of `sessions/` with it.
    if (process.platform === "win32") {
      return;
    }
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = base;
    try {
      const project = path.join(base, "project");
      mkdirSync(project, { recursive: true });

      const handle = createSession({ cwd: project });

      expect(mode(configDir)).toBe("700");
      // Every level between the shared root and the session, not just the leaf:
      // a 0775 `sessions/` lets a group member unlink a whole project's
      // transcripts whatever mode the leaf carries.
      let current = configDir;
      for (const segment of handle.dir.slice(configDir.length + 1).split(path.sep)) {
        current = path.join(current, segment);
        expect({ level: current.slice(base.length), mode: mode(current) }).toEqual({
          level: current.slice(base.length),
          mode: "700",
        });
      }
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
    }
  });

  test("the session store tightens levels that ALREADY exist wide", () => {
    // `mode` on `mkdirSync` is a no-op on an existing directory, so an install
    // upgraded from a release without this fix keeps its 0775 `sessions/`
    // forever unless something walks down and forces each level.
    if (process.platform === "win32") {
      return;
    }
    const previousXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = base;
    try {
      const project = path.join(base, "project");
      mkdirSync(project, { recursive: true });
      mkdirSync(path.join(configDir, "sessions"), { recursive: true });
      chmodSync(configDir, 0o775);
      chmodSync(path.join(configDir, "sessions"), 0o775);

      createSession({ cwd: project });

      expect(mode(configDir)).toBe("700");
      expect(mode(path.join(configDir, "sessions"))).toBe("700");
    } finally {
      if (previousXdg === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousXdg;
      }
    }
  });

  test("the session store tightens sessions/ under KERYX_DATA_DIR too", () => {
    // The first version of this fix skipped the walk entirely when the data
    // root was not the shared config directory — scoped to the call site the
    // finding named, again — so every install that sets `KERYX_DATA_DIR` kept a
    // permanently group-writable `sessions/`, and transcripts anyone in the
    // group could read or unlink.
    if (process.platform === "win32") {
      return;
    }
    const dataDir = path.join(base, "data");
    mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
    chmodSync(dataDir, 0o775);
    chmodSync(path.join(dataDir, "sessions"), 0o775);
    const project = path.join(base, "kdd-project");
    mkdirSync(project, { recursive: true });

    const previous = process.env.KERYX_DATA_DIR;
    process.env.KERYX_DATA_DIR = dataDir;
    let handle;
    try {
      handle = createSession({ cwd: project });
    } finally {
      if (previous === undefined) {
        delete process.env.KERYX_DATA_DIR;
      } else {
        process.env.KERYX_DATA_DIR = previous;
      }
    }

    expect(mode(path.join(dataDir, "sessions"))).toBe("700");
    let current = path.join(dataDir, "sessions");
    for (const segment of handle.dir.slice(current.length + 1).split(path.sep)) {
      current = path.join(current, segment);
      expect({ level: current.slice(base.length), mode: mode(current) }).toEqual({
        level: current.slice(base.length),
        mode: "700",
      });
    }
    // The operator's OWN directory is left alone: it is not keryx's to
    // re-permission, and it may hold other things.
    expect(mode(dataDir)).toBe("775");
  });

  test("a KERYX_DATA_DIR whose OWN path contains `sessions` is not walked from the wrong root", () => {
    // The fixture the previous version of this guard used could not fail:
    // `<tmp>/keryx-configdir-mode-XXXX/data` contains no `sessions` segment, so
    // an implementation that searched the path for the FIRST `/sessions/` gave
    // the right answer by accident. A review used `<base>/sessions/keryx` and
    // watched the walk chmod both `<base>/sessions` — a directory shared with
    // whatever else lives there — and the data root itself, while the comment
    // beside it claimed the data root was left alone.
    if (process.platform === "win32") {
      return;
    }
    const outer = path.join(base, "sessions");
    const dataDir = path.join(outer, "keryx");
    mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
    chmodSync(outer, 0o775);
    chmodSync(dataDir, 0o775);
    chmodSync(path.join(dataDir, "sessions"), 0o775);
    const project = path.join(base, "nested-project");
    mkdirSync(project, { recursive: true });

    const previous = process.env.KERYX_DATA_DIR;
    process.env.KERYX_DATA_DIR = dataDir;
    try {
      createSession({ cwd: project });
    } finally {
      if (previous === undefined) {
        delete process.env.KERYX_DATA_DIR;
      } else {
        process.env.KERYX_DATA_DIR = previous;
      }
    }

    // The tree keryx creates: tightened.
    expect(mode(path.join(dataDir, "sessions"))).toBe("700");
    // Everything above it: untouched. Both of these were 0700 before the fix.
    expect({ level: "data root", mode: mode(dataDir) }).toEqual({ level: "data root", mode: "775" });
    expect({ level: "above it", mode: mode(outer) }).toEqual({ level: "above it", mode: "775" });
  });

  test("saveShellPermissions", () => {
    // Missed by the round-3 sweep. It shares a directory with `auth.json` and,
    // on a host where `KERYX_DATA_DIR` is set so `createSession` never touches
    // the config dir, it is the writer that CREATES it — at 0775. It is also
    // the file that decides which shell commands run without asking.
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();

    saveShellPermissions({ allow: ["git status"] }, configDir);

    expect(mode(configDir)).toBe("700");
    expect(mode(path.join(configDir, "permissions.json"))).toBe("600");
  });

  test("saveSandboxDefaults", () => {
    if (process.platform === "win32") {
      return;
    }
    widenConfigDir();

    saveSandboxDefaults({ maskMode: "auto" }, configDir);

    expect(mode(configDir)).toBe("700");
    expect(mode(path.join(configDir, "sandbox.json"))).toBe("600");
  });

  test("saveShellPermissions and saveSandboxDefaults CREATE the directory owner-only", () => {
    // The sharper case: no other writer has run, so whatever mode these two
    // leave is the mode `auth.json` is later created into.
    if (process.platform === "win32") {
      return;
    }
    saveShellPermissions({ allow: ["git status"] }, configDir);
    expect(mode(configDir)).toBe("700");

    rmSync(configDir, { recursive: true, force: true });
    saveSandboxDefaults({ maskMode: "auto" }, configDir);
    expect(mode(configDir)).toBe("700");
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
