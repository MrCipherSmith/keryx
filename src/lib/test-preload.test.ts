// The preload is actually in effect: no test run resolves the real config dir.
//
// This asserts the PROPERTY rather than scanning test sources for a call. The
// polluting path was `keryx modules enable` → `initCommand` → registry write,
// which no source-level scan of `modules.test.ts` would ever have found: that
// file does not mention `init`. What can be checked directly is whether the
// resolver, right now, inside the suite, points anywhere near the developer's
// home — and that is what this does.
//
// It fails if `bunfig.toml` loses the `[test].preload` entry, if the preload
// stops setting either variable, or if the resolver stops honouring them.
//
// This file deliberately does NOT import `./test-preload`. An earlier version
// did, to read the root as a module export — which EXECUTED the preload, set
// the variables, and passed with the `bunfig.toml` wiring deleted. Removing that
// wiring was mutation-checked and produced zero failures. The root is read from
// the environment instead, so it is present only if something ran the preload
// before this file loaded.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { keryxConfigDir } from "./config-dir";
import { projectRegistryPath } from "./project-registry";
import { shellConfigPath } from "./shell-config";

/** Where the config directory would resolve with no redirection at all. */
function realConfigDir(): string {
  const home = homedir();
  return process.platform === "win32"
    ? path.join(home, "AppData", "Roaming", "keryx")
    : path.join(home, ".local", "share", "keryx");
}

/** The root the preload published, or "" when the preload never ran. */
const TEST_CONFIG_ROOT = process.env.KERYX_TEST_CONFIG_ROOT ?? "";

describe("the test preload isolates the user-global config directory", () => {
  test("the preload ran at all", () => {
    // The first thing to fail when `bunfig.toml` loses its `[test].preload`
    // entry, which is the change every other assertion here must not survive.
    expect(TEST_CONFIG_ROOT).not.toBe("");
  });

  test("the resolver does not point at the developer's real directory", () => {
    expect(keryxConfigDir()).not.toBe(realConfigDir());
  });

  test("it points at this run's temp root, so the redirect is the reason and not an accident", () => {
    // Without this the assertion above would also pass if the resolver had been
    // broken into returning something arbitrary.
    expect(keryxConfigDir()).toBe(path.join(TEST_CONFIG_ROOT, "keryx"));
  });

  test("nothing under the real home is reachable through the user-global paths", () => {
    // The two files a test run actually wrote into: the registry that
    // accumulated 1006 fixture entries, and the credential file beside it.
    const home = homedir();
    expect(projectRegistryPath().startsWith(home)).toBe(false);
    expect(shellConfigPath().startsWith(home)).toBe(false);
  });

  test("the temp directory is canonical, so tmpdir()-built paths equal what the product resolves", () => {
    // macOS `$TMPDIR` is a symlink (/var → /private/var); without the preload's
    // realpath, this differs there.
    expect(tmpdir()).toBe(realpathSync(tmpdir()));
    expect(process.env.TMPDIR).toBe(realpathSync(process.env.TMPDIR ?? tmpdir()));
  });

  test("a symlinked TMPDIR is canonicalised by the preload (portable: builds its own symlink)", () => {
    // The assertion above only bites where the host's temp dir is already a
    // symlink (macOS). Here the symlink is created, so Linux CI exercises it too.
    const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-preload-symlink-")));
    try {
      const realDir = path.join(base, "real");
      const linkDir = path.join(base, "link");
      mkdirSync(realDir);
      symlinkSync(realDir, linkDir, "dir");
      const preload = path.join(import.meta.dir, "test-preload.ts");
      const script = `await import(${JSON.stringify(preload)}); console.log(JSON.stringify({ tmpdir: require("node:os").tmpdir(), env: process.env.TMPDIR }));`;
      const proc = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: base,
        env: { ...process.env, TMPDIR: linkDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.stderr.toString()).toBe("");
      expect(proc.exitCode).toBe(0);
      const out = JSON.parse(proc.stdout.toString().trim()) as { tmpdir: string; env: string };
      expect(out.env).toBe(realDir);
      expect(out.tmpdir).toBe(realDir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("both platform variables are set, not just the one this host reads", () => {
    // A preload that set only `XDG_DATA_HOME` would leave Windows CI writing to
    // the real directory while every assertion above still passed on Linux.
    expect(process.env.XDG_DATA_HOME).toBe(TEST_CONFIG_ROOT);
    expect(process.env.APPDATA).toBe(TEST_CONFIG_ROOT);
  });
});
