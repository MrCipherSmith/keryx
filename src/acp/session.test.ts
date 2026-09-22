import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AcpSessionRegistry } from "./session";

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("AcpSessionRegistry", () => {
  test("F-6: a subdirectory cwd resolves to the git root, and both are kept on the session state", () => {
    const root = tempDir("keryx-acp-session-");
    Bun.spawnSync(["git", "init", "-q", "."], { cwd: root });
    const sub = path.join(root, "packages", "web");
    mkdirSync(sub, { recursive: true });

    const dataDir = tempDir("keryx-acp-session-data-");
    const registry = new AcpSessionRegistry({ providerId: "fake", modelId: "fake-model", dataDir });
    const state = registry.create(sub, undefined);

    expect(state.requestedCwd).toBe(sub);
    expect(state.resolvedRoot).toBe(root);
    expect(state.handle.summary.projectPath).toBe(root);
    expect(state.sessionId).toBe(state.handle.summary.id);
    expect(state.history).toEqual([]);
    expect(state.clientCapabilities).toBeUndefined();
  });

  test("a session not previously created is not found", () => {
    const dataDir = tempDir("keryx-acp-session-data-");
    const registry = new AcpSessionRegistry({ providerId: "fake", modelId: "fake-model", dataDir });
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  test("get() returns a created session by its id, and updateHandle() replaces the stored handle", () => {
    const root = tempDir("keryx-acp-session-");
    Bun.spawnSync(["git", "init", "-q", "."], { cwd: root });
    const dataDir = tempDir("keryx-acp-session-data-");
    const registry = new AcpSessionRegistry({ providerId: "fake", modelId: "fake-model", dataDir });
    const clientCapabilities = { fs: { readTextFile: true, writeTextFile: false } };
    const state = registry.create(root, clientCapabilities);

    const found = registry.get(state.sessionId);
    expect(found).toBeDefined();
    expect(found?.clientCapabilities).toEqual(clientCapabilities);

    const updated = { ...state.handle, summary: { ...state.handle.summary, title: "renamed" } };
    registry.updateHandle(state.sessionId, updated);
    expect(registry.get(state.sessionId)?.handle.summary.title).toBe("renamed");

    // updateHandle() on an unknown id is a no-op, not a throw.
    registry.updateHandle("unknown-id", updated);
  });
});
