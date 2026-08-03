// The one user-global config directory resolver (flow 128 / roadmap R4b).
//
// A review pointed out that the "there is only one resolver" guard in the serve
// suites compared `path.dirname()` of three paths all built from an explicit
// `dir` argument — and `keryxConfigDir(dir)` returns `dir` unchanged, so the
// comparison was true by construction. A FOURTH divergent copy would have
// passed it, which is precisely the failure the extraction exists to prevent.
//
// So this file exercises the resolver with NO argument, which is the only form
// that actually resolves anything, and pins every consumer against it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import path from "node:path";
import { keryxConfigDir } from "./config-dir";
import { shellConfigPath } from "./shell-config";
import { projectRegistryPath } from "./project-registry";
import { serveConfigPath } from "./serve-config";
import { serveCredentialPath } from "./serve-credential";

let originalXdg: string | undefined;
let originalAppData: string | undefined;

beforeEach(() => {
  originalXdg = process.env.XDG_DATA_HOME;
  originalAppData = process.env.APPDATA;
});

afterEach(() => {
  if (originalXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdg;
  }
  if (originalAppData === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppData;
  }
});

describe("resolution", () => {
  test("an explicit dir is returned unchanged — it is the test seam, not a resolution", () => {
    expect(keryxConfigDir("/somewhere/else")).toBe("/somewhere/else");
  });

  test("XDG_DATA_HOME wins on non-Windows", () => {
    if (process.platform === "win32") {
      return;
    }
    process.env.XDG_DATA_HOME = "/tmp/keryx-xdg-fixture";
    expect(keryxConfigDir()).toBe(path.join("/tmp/keryx-xdg-fixture", "keryx"));
  });

  test("an empty XDG_DATA_HOME falls back to ~/.local/share, it does not resolve to /keryx", () => {
    if (process.platform === "win32") {
      return;
    }
    process.env.XDG_DATA_HOME = "";
    expect(keryxConfigDir()).toBe(path.join(homedir(), ".local", "share", "keryx"));
  });

  test("no XDG_DATA_HOME falls back to ~/.local/share", () => {
    if (process.platform === "win32") {
      return;
    }
    delete process.env.XDG_DATA_HOME;
    expect(keryxConfigDir()).toBe(path.join(homedir(), ".local", "share", "keryx"));
  });

  test("APPDATA wins on Windows, with a documented fallback", () => {
    if (process.platform !== "win32") {
      // The branch is unreachable here. Stating that is better than a test that
      // silently exercises nothing and counts as coverage.
      expect(process.platform).not.toBe("win32");
      return;
    }
    process.env.APPDATA = "C:\\Users\\fixture\\AppData\\Roaming";
    expect(keryxConfigDir()).toBe(path.join("C:\\Users\\fixture\\AppData\\Roaming", "keryx"));
    process.env.APPDATA = "";
    expect(keryxConfigDir()).toBe(path.join(homedir(), "AppData", "Roaming", "keryx"));
  });
});

describe("one directory, resolved once", () => {
  test("every user-global file resolves under the SAME resolved directory, with no argument", () => {
    // The load-bearing form: no `dir` is passed, so each consumer must be
    // reaching the shared resolver rather than carrying its own copy that
    // merely honours the seam.
    const base = keryxConfigDir();
    expect(shellConfigPath()).toBe(path.join(base, "auth.json"));
    expect(projectRegistryPath()).toBe(path.join(base, "projects.json"));
    expect(serveConfigPath()).toBe(path.join(base, "serve.json"));
    expect(serveCredentialPath()).toBe(path.join(base, "serve-credentials.json"));
  });

  test("moving XDG_DATA_HOME moves all four together", () => {
    // A private copy that read the environment at module load, or that resolved
    // differently, would be caught here and not by a same-argument comparison.
    if (process.platform === "win32") {
      return;
    }
    process.env.XDG_DATA_HOME = "/tmp/keryx-moved-fixture";
    const moved = path.join("/tmp/keryx-moved-fixture", "keryx");
    expect(shellConfigPath()).toBe(path.join(moved, "auth.json"));
    expect(projectRegistryPath()).toBe(path.join(moved, "projects.json"));
    expect(serveConfigPath()).toBe(path.join(moved, "serve.json"));
    expect(serveCredentialPath()).toBe(path.join(moved, "serve-credentials.json"));
  });

  test("the four filenames are distinct — no consumer collides with another", () => {
    const names = [shellConfigPath(), projectRegistryPath(), serveConfigPath(), serveCredentialPath()].map((file) =>
      path.basename(file),
    );
    expect(new Set(names).size).toBe(names.length);
  });
});
