import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpServers } from "./config";
import {
  addServer,
  overlayFile,
  projectConfigFile,
  removeServer,
  setServerEnabled,
  userConfigFile,
} from "./store";

function workspace(): { configDir: string; projectRoot: string } {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-mcp-store-"));
  const configDir = path.join(base, "config");
  const projectRoot = path.join(base, "project");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  return { configDir, projectRoot };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("add", () => {
  test("writes a stdio server into the user file and it loads back", () => {
    const { configDir, projectRoot } = workspace();
    const result = addServer({
      name: "fs",
      entry: { command: "npx", args: ["-y", "server-filesystem"] },
      scope: "user",
      configDir,
    });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.created).toBe(true);

    // Round-tripped through the READER, not just re-read as JSON: a write the
    // loader cannot see is a write that did not happen as far as anything
    // else in this package is concerned.
    const loaded = loadMcpServers({ cwd: projectRoot, gitRoot: projectRoot, configDir });
    expect(loaded.servers.map((s) => s.name)).toEqual(["fs"]);
    expect(loaded.servers[0]?.command).toBe("npx");
  });

  test("refuses an existing name unless --force", () => {
    const { configDir } = workspace();
    addServer({ name: "fs", entry: { command: "a" }, scope: "user", configDir });

    const again = addServer({ name: "fs", entry: { command: "b" }, scope: "user", configDir });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toContain("already exists");
    // And the original survived — a refused write must not be a partial one.
    expect(readJson(userConfigFile(configDir)).servers).toEqual({ fs: { command: "a" } });

    const forced = addServer({ name: "fs", entry: { command: "b" }, scope: "user", configDir, force: true });
    expect(forced.ok).toBe(true);
    expect(readJson(userConfigFile(configDir)).servers).toEqual({ fs: { command: "b" } });
  });

  test("refuses a malformed existing file instead of overwriting it", () => {
    // The one moment `add` could silently destroy hand-written config,
    // including the servers it could not parse.
    const { configDir } = workspace();
    const file = userConfigFile(configDir);
    writeFileSync(file, "{ this is not json");

    const result = addServer({ name: "fs", entry: { command: "a" }, scope: "user", configDir });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("nothing was written");
    expect(readFileSync(file, "utf8")).toBe("{ this is not json");
  });

  test("keeps top-level keys it does not know about", () => {
    const { configDir } = workspace();
    const file = userConfigFile(configDir);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, $comment: "keep me", servers: {} }));

    addServer({ name: "fs", entry: { command: "a" }, scope: "user", configDir });
    expect(readJson(file).$comment).toBe("keep me");
  });

  test("rejects a name the schema does not allow", () => {
    const { configDir } = workspace();
    const result = addServer({ name: "bad name!", entry: { command: "a" }, scope: "user", configDir });
    expect(result.ok).toBe(false);
  });

  test("the user file is owner-only; the project file is not forced to 0600", () => {
    // Different files with different jobs: one sits next to credentials, the
    // other is committed and read by whoever checks the repo out.
    if (process.platform === "win32") return;
    const { configDir, projectRoot } = workspace();
    addServer({ name: "a", entry: { command: "x" }, scope: "user", configDir });
    addServer({ name: "b", entry: { command: "x" }, scope: "project", configDir, projectRoot });

    // The user file is forced, so this is an absolute claim.
    expect(statSync(userConfigFile(configDir)).mode & 0o777).toBe(0o600);

    // The project file is NOT forced, so its mode is whatever the umask
    // gives — asserting `!== 0o600` would fail under `umask 077` for an
    // environmental reason that says nothing about this code. What is
    // actually being claimed is that the project path does not go through
    // the owner-only writer, so claim that: it is at least as permissive as
    // the umask allows, group/other bits included.
    const projectMode = statSync(projectConfigFile(projectRoot)).mode & 0o777;
    const umask = process.umask();
    expect(projectMode).toBe(0o666 & ~umask);
  });
});

describe("remove", () => {
  test("deletes the entry and says which file", () => {
    const { configDir } = workspace();
    addServer({ name: "fs", entry: { command: "a" }, scope: "user", configDir });

    const result = removeServer({ name: "fs", scope: "user", configDir });
    expect(result.ok).toBe(true);
    expect(readJson(userConfigFile(configDir)).servers).toEqual({});
  });

  test("a name that is not there is an error, not a silent success", () => {
    const { configDir } = workspace();
    const result = removeServer({ name: "ghost", scope: "user", configDir });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("not defined");
  });
});

describe("enable/disable", () => {
  test("disable writes the overlay and the loader honours it", () => {
    const { configDir, projectRoot } = workspace();
    addServer({ name: "fs", entry: { command: "a" }, scope: "user", configDir });

    setServerEnabled({ name: "fs", enabled: false, source: "user", configDir });

    const loaded = loadMcpServers({ cwd: projectRoot, gitRoot: projectRoot, configDir });
    expect(loaded.servers[0]?.enabled).toBe(false);
  });

  test("enable lifts an `enabled: false` a COMMITTED project file set, without editing it", () => {
    // The reason the overlay is a map and not a list of disabled names.
    const { configDir, projectRoot } = workspace();
    const projectFile = projectConfigFile(projectRoot);
    mkdirSync(path.dirname(projectFile), { recursive: true });
    const original = JSON.stringify({ servers: { fs: { command: "a", enabled: false } } }, null, 2);
    writeFileSync(projectFile, original);

    setServerEnabled({ name: "fs", enabled: true, source: "project", configDir });

    const loaded = loadMcpServers({ cwd: projectRoot, gitRoot: projectRoot, configDir });
    expect(loaded.servers[0]?.enabled).toBe(true);
    // And the committed file is byte-identical: toggling a server for
    // yourself must not produce a diff for everyone.
    expect(readFileSync(projectFile, "utf8")).toBe(original);
  });

  test("a sticky `enabled` in the USER file is cleared when the USER layer is the one toggled", () => {
    const { configDir } = workspace();
    addServer({ name: "fs", entry: { command: "a", enabled: false }, scope: "user", configDir });

    setServerEnabled({ name: "fs", enabled: true, source: "user", configDir });

    const servers = readJson(userConfigFile(configDir)).servers as Record<string, { enabled?: boolean }>;
    expect(servers.fs?.enabled).toBeUndefined();
  });

  test("a PROJECT-scope toggle does not touch a same-named user preference", () => {
    // The hole the first fix left open. It narrowed WHICH VALUES were
    // cleared and not WHOSE: an `enable` aimed at the project-scope server
    // still deleted `enabled: false` from a user entry the operator had
    // hand-written. The overlay masks the loss until the overlay is lost —
    // and `setServerEnabled` resets a corrupt overlay to `{}`, so there is
    // a two-step path from that to a server silently coming back on.
    const { configDir, projectRoot } = workspace();
    addServer({ name: "shared", entry: { command: "user-cmd", enabled: false }, scope: "user", configDir });
    addServer({ name: "shared", entry: { command: "project-cmd" }, scope: "project", configDir, projectRoot });

    // The project layer wins the merge, so this toggle is about the project
    // server.
    setServerEnabled({ name: "shared", enabled: true, source: "project", configDir });

    const servers = readJson(userConfigFile(configDir)).servers as Record<string, { enabled?: boolean }>;
    expect(servers.shared?.enabled).toBe(false);
  });

  test("a value that AGREES with the toggle is left alone", () => {
    const { configDir } = workspace();
    addServer({ name: "fs", entry: { command: "a", enabled: false }, scope: "user", configDir });

    setServerEnabled({ name: "fs", enabled: false, source: "user", configDir });

    const servers = readJson(userConfigFile(configDir)).servers as Record<string, { enabled?: boolean }>;
    expect(servers.fs?.enabled).toBe(false);
  });

  test("a broken overlay is replaced rather than making disable permanently unusable", () => {
    const { configDir, projectRoot } = workspace();
    addServer({ name: "fs", entry: { command: "a" }, scope: "user", configDir });
    writeFileSync(overlayFile(configDir), "not json");

    const result = setServerEnabled({ name: "fs", enabled: false, source: "user", configDir });
    expect(result.ok).toBe(true);

    const loaded = loadMcpServers({ cwd: projectRoot, gitRoot: projectRoot, configDir });
    expect(loaded.servers[0]?.enabled).toBe(false);
  });

  test("the overlay keeps earlier toggles instead of replacing the map", () => {
    const { configDir } = workspace();
    setServerEnabled({ name: "a", enabled: false, source: "user", configDir });
    setServerEnabled({ name: "b", enabled: false, source: "user", configDir });

    const overrides = readJson(overlayFile(configDir)).overrides as Record<string, boolean>;
    expect(overrides).toEqual({ a: false, b: false });
  });
});
