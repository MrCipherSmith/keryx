// Round-3 lost-update class (review-architecture-w4:F-001 and its minor
// siblings): a writer that reads a nested block, edits it and saves the WHOLE
// block back put a stale snapshot over whatever another keryx process wrote in
// between (`disable` reverted by a consent write, `enabled` reverted by a
// toggle, a category or an MCP approval vanishing).
//
// The seam is `readConfigFile`: right after the FIRST read of the store under
// test, a "second process" changes the file on disk. A writer that applies its
// change to the content it read loses that change; one that applies it to the
// content on disk at write time (`updateConfigFile` re-reads before renaming)
// keeps both. The mock is switched off and removed after each test.

import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as realConfigDir from "../lib/config-dir";

const CONFIG_DIR_MODULE = path.resolve(import.meta.dir, "../lib/config-dir.ts");
const realSnapshot = { ...realConfigDir };

let armed: { file: string; change: () => void } | undefined;

beforeAll(() => {
  mock.module(CONFIG_DIR_MODULE, () => ({
    ...realSnapshot,
    readConfigFile: (file: string, ...rest: unknown[]) => {
      const result = (realSnapshot.readConfigFile as (f: string, ...r: unknown[]) => unknown)(file, ...rest);
      if (armed !== undefined && file === armed.file) {
        const { change } = armed;
        armed = undefined; // once
        change();
      }
      return result;
    },
  }));
});

afterAll(() => {
  armed = undefined;
  mock.module(CONFIG_DIR_MODULE, () => realSnapshot);
});

afterEach(() => {
  armed = undefined;
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-stale-writers-"));
  roots.push(dir);
  return dir;
}

const readJson = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

test("recordExternalAgentConsent does not put back an `enabled` flag another process just cleared", async () => {
  const { saveShellConfig, shellConfigPath } = await import("../lib/shell-config");
  const { recordExternalAgentConsent } = await import("./external-agents");
  const dir = tempDir();
  saveShellConfig({ externalAgents: { enabled: true } }, dir);
  const file = shellConfigPath(dir);
  armed = {
    file,
    // `keryx agents external disable` in another process, right after our read.
    change: () => writeFileSync(file, `${JSON.stringify({ externalAgents: { enabled: false } }, null, 2)}\n`),
  };
  recordExternalAgentConsent("claude-code", "0.0.0-test", dir);
  const after = readJson(file);
  expect(after.externalAgents.enabled).toBe(false);
  expect(after.externalAgents.consent["claude-code"].keryxVersion).toBe("0.0.0-test");
});

test("enableExternalAgents keeps a consent record another process wrote between its read and its write", async () => {
  const { saveShellConfig, shellConfigPath } = await import("../lib/shell-config");
  const { enableExternalAgents } = await import("./external-agents");
  const dir = tempDir();
  saveShellConfig({ externalAgents: { enabled: false } }, dir);
  const file = shellConfigPath(dir);
  armed = {
    file,
    change: () =>
      writeFileSync(
        file,
        `${JSON.stringify({ externalAgents: { enabled: false, consent: { codex: { acceptedAt: "t", keryxVersion: "1" } } } }, null, 2)}\n`,
      ),
  };
  const cwd = tempDir();
  const result = await enableExternalAgents(cwd, dir);
  expect(result.user).toBe("changed");
  const after = readJson(file);
  expect(after.externalAgents.enabled).toBe(true);
  expect(after.externalAgents.consent.codex.keryxVersion).toBe("1");
});

test("setRoutingCategory (user layer) keeps a category another process set between its read and its write", async () => {
  const { saveShellConfig, shellConfigPath } = await import("../lib/shell-config");
  const { setRoutingCategory } = await import("../harness/routing/settings");
  const userConfigDir = tempDir();
  const cwd = tempDir();
  const review = { mode: "model", target: { providerId: "anthropic", modelId: "a" } };
  saveShellConfig({ modelRouting: { schemaVersion: 2, categories: { review } } } as never, userConfigDir);
  const file = shellConfigPath(userConfigDir);
  armed = {
    file,
    change: () =>
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            modelRouting: {
              schemaVersion: 2,
              categories: { review, docs: { mode: "class", modelClass: "light" } },
            },
          },
          null,
          2,
        )}\n`,
      ),
  };
  await setRoutingCategory("user", { cwd, configDir: userConfigDir }, "quick", { mode: "baseline" });
  const routing = readJson(file).modelRouting.categories;
  expect(Object.keys(routing).sort()).toEqual(["docs", "quick", "review"]);
});

test("approveServer keeps an approval another process recorded between its read and its write", async () => {
  const { approveServer, trustFile } = await import("../mcp-servers/trust");
  const configDir = tempDir();
  mkdirSync(configDir, { recursive: true });
  const file = trustFile(configDir);
  writeFileSync(file, `${JSON.stringify({ approvals: {} })}\n`);
  const server = (name: string) =>
    ({ name, file: "/repo/.keryx/mcp-servers.json", command: "echo", args: [name], projectLocal: true, raw: {} }) as never;
  armed = {
    file,
    change: () => writeFileSync(file, `${JSON.stringify({ approvals: { "/repo/.keryx/mcp-servers.json::other": "abc" } })}\n`),
  };
  expect(approveServer(server("docs"), configDir).ok).toBe(true);
  const approvals = readJson(file).approvals;
  expect(approvals["/repo/.keryx/mcp-servers.json::other"]).toBe("abc");
  expect(typeof approvals["/repo/.keryx/mcp-servers.json::docs"]).toBe("string");
});

// The window in the old approve/revoke (load the map, edit, rename) is not
// reachable through the read seam above, so pin that they now take the store
// lock: with it held by another process, the write waits out the bounded lock
// timeout before it proceeds (it used to write immediately, unserialised).
test("approveServer and revokeServer go through the store lock", async () => {
  const { approveServer, revokeServer, trustFile, loadTrustStore } = await import("../mcp-servers/trust");
  const { CONFIG_UPDATE_LOCK_TIMEOUT_MS } = await import("../lib/config-update");
  const configDir = tempDir();
  const file = trustFile(configDir);
  const server = { name: "docs", file: "/repo/.keryx/mcp-servers.json", command: "echo", args: ["x"], projectLocal: true, raw: {} } as never;
  writeFileSync(`${file}.lock`, "someone-else", { mode: 0o600 });
  let started = Date.now();
  expect(approveServer(server, configDir).ok).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(CONFIG_UPDATE_LOCK_TIMEOUT_MS - 50);
  expect(Object.keys(loadTrustStore(configDir))).toHaveLength(1);
  started = Date.now();
  expect(revokeServer(server, configDir).ok).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(CONFIG_UPDATE_LOCK_TIMEOUT_MS - 50);
  expect(Object.keys(loadTrustStore(configDir))).toHaveLength(0);
});
