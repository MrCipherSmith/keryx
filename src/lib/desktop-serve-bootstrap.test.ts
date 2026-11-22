import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDesktopServe } from "./desktop-serve-bootstrap";
import { defaultServeConfig, loadServeConfig, saveServeConfig, serveConfigPath } from "./serve-config";
import { issueServeToken, readServeCredential } from "./serve-credential";

const dirs: string[] = [];
function directory(): string { const dir = mkdtempSync(path.join(tmpdir(), "keryx-desktop-serve-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("desktop serve bootstrap", () => {
  test("creates a loopback config and verifier without returning a secret", async () => {
    const dir = directory();
    const result = await bootstrapDesktopServe({ dir, portAvailable: async () => true });
    expect(result).toEqual({ state: "ready" });
    const config = loadServeConfig(dir)!;
    expect(config.bind).toMatchObject({ address: "127.0.0.1", port: 7377 });
    const credential = readServeCredential(dir);
    expect(credential.status).toBe("ok");
    if (credential.status === "ok") expect(config.credentialRef.id).toBe(credential.record.id);
  });
  test("does not write when port is occupied or configuration malformed", async () => {
    const dir = directory();
    expect((await bootstrapDesktopServe({ dir, portAvailable: async () => false })).state).toBe("blocked");
    expect(loadServeConfig(dir)).toBeNull();
    expect(readServeCredential(dir).status).toBe("absent");
    writeFileSync(serveConfigPath(dir), "broken");
    expect((await bootstrapDesktopServe({ dir, portAvailable: async () => true })).state).toBe("blocked");
    expect(readFileSync(serveConfigPath(dir), "utf8")).toBe("broken");
  });
  test("requires explicit completion for existing config without credential", async () => {
    const dir = directory();
    expect(saveServeConfig(defaultServeConfig("old", { port: 8765 }), dir)).toBe(true);
    expect((await bootstrapDesktopServe({ dir, portAvailable: async () => true })).state).toBe("needs_setup");
    expect((await bootstrapDesktopServe({ dir, completeSetup: true, portAvailable: async () => true })).state).toBe("ready");
    expect(loadServeConfig(dir)!.bind.port).toBe(8765);
  });
  test("reuses a credential after a partial setup and refuses a mismatch", async () => {
    const dir = directory();
    const issued = issueServeToken(dir);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect((await bootstrapDesktopServe({ dir, portAvailable: async () => true })).state).toBe("ready");
    expect(loadServeConfig(dir)!.credentialRef.id).toBe(issued.record.id);
    expect(saveServeConfig(defaultServeConfig("different"), dir)).toBe(true);
    const before = readFileSync(serveConfigPath(dir), "utf8");
    expect((await bootstrapDesktopServe({ dir, completeSetup: true, portAvailable: async () => true })).state).toBe("blocked");
    expect(readFileSync(serveConfigPath(dir), "utf8")).toBe(before);
  });
  test("preserves disabled and non-loopback settings", async () => {
    const dir = directory();
    const config = defaultServeConfig("existing", { address: "0.0.0.0" });
    config.enabled = false;
    expect(saveServeConfig(config, dir)).toBe(true);
    const before = readFileSync(serveConfigPath(dir), "utf8");
    expect((await bootstrapDesktopServe({ dir, completeSetup: true, portAvailable: async () => true })).state).toBe("blocked");
    expect(readFileSync(serveConfigPath(dir), "utf8")).toBe(before);
    expect(readServeCredential(dir).status).toBe("absent");
  });
});
