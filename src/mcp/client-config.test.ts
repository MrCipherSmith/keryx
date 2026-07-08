import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  CLAUDE_RUNTIME,
  CURSOR_RUNTIME,
  MCP_MANAGED_KEY,
  MCP_MANAGED_SENTINEL,
  MCP_SDK_HINT,
  MCP_SERVER_NAME,
  enableMcpModule,
  installMcpClient,
  probeMcpSdk,
  renderMcpClientSnippet,
  resolveMcpRuntimes,
  uninstallMcpClient,
} from "./client-config";

// Flow 012: MCP client-config installer. Mirrors the E5 agent-hooks tests —
// merge-safety, idempotency, targeted uninstall — plus manifest-enable, generic
// snippet, dry-run, SDK-absent hint, and a no-network assertion.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gd-metapro-mcp-client-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Config = {
  mcpServers?: Record<string, { command?: string; args?: string[]; [k: string]: unknown }>;
  [key: string]: unknown;
};

async function readConfig(file: string): Promise<Config> {
  return JSON.parse(await readFile(file, "utf8")) as Config;
}

async function writeManifest(mcpEnabled: boolean | undefined): Promise<void> {
  await mkdir(path.join(root, ".metaproject", "modules"), { recursive: true });
  const modules: Record<string, unknown> = { gdgraph: { enabled: true } };
  if (mcpEnabled !== undefined) {
    modules.mcp = { enabled: mcpEnabled };
  }
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        standardVersion: "0.1.0",
        name: "fixture",
        createdBy: "gd-metapro",
        paths: { root: ".metaproject" },
        modules,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

test("AC1: install writes .cursor/mcp.json with a sentinel-marked gd-metapro server", async () => {
  const report = await installMcpClient(root, ["cursor"]);
  const file = CURSOR_RUNTIME.settingsPath(root) as string;
  expect(file.endsWith(path.join(".cursor", "mcp.json"))).toBe(true);

  const config = await readConfig(file);
  const entry = config.mcpServers?.[MCP_SERVER_NAME];
  expect(entry?.command).toBe("gd-metapro");
  expect(entry?.args).toEqual(["mcp", "serve"]);
  expect((entry as Record<string, unknown>)?.[MCP_MANAGED_KEY]).toBe(MCP_MANAGED_SENTINEL);
  expect(report.outcomes[0]?.errors).toEqual([]);
});

test("AC1: --runtime claude writes .mcp.json at the project root", async () => {
  await installMcpClient(root, ["claude"]);
  const file = CLAUDE_RUNTIME.settingsPath(root) as string;
  expect(file).toBe(path.join(root, ".mcp.json"));
  const config = await readConfig(file);
  expect(config.mcpServers?.[MCP_SERVER_NAME]?.command).toBe("gd-metapro");
});

test("AC1: resolveMcpRuntimes('all') targets cursor + claude only", () => {
  const { runtimes, unknown } = resolveMcpRuntimes(["all"]);
  expect(runtimes.map((r) => r.id)).toEqual(["cursor", "claude"]);
  expect(unknown).toEqual([]);
});

test("AC1: unknown runtime is reported", () => {
  const { runtimes, unknown } = resolveMcpRuntimes(["windsurf"]);
  expect(runtimes).toEqual([]);
  expect(unknown).toEqual(["windsurf"]);
});

test("AC1: generic prints a ready snippet and writes no file", async () => {
  const report = await installMcpClient(root, ["generic"]);
  const outcome = report.outcomes[0];
  expect(outcome?.filePath).toBeNull();
  expect(outcome?.wrote).toBe(false);
  expect(outcome?.snippet).toBe(renderMcpClientSnippet());
  // The snippet has no managed sentinel (it is user-authored).
  expect(outcome?.snippet).not.toContain(MCP_MANAGED_SENTINEL);
  // No .cursor/mcp.json or .mcp.json created.
  await expect(readFile(path.join(root, ".mcp.json"), "utf8")).rejects.toThrow();
});

test("AC2: merge preserves pre-existing servers and unrelated top-level keys", async () => {
  const file = CURSOR_RUNTIME.settingsPath(root) as string;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      {
        $schema: "https://example.com/mcp.json",
        mcpServers: {
          other: { command: "other-server", args: ["--stdio"] },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await installMcpClient(root, ["cursor"]);
  const config = await readConfig(file);

  // Pre-existing server and top-level key survive.
  expect(config.mcpServers?.other?.command).toBe("other-server");
  expect(config.$schema).toBe("https://example.com/mcp.json");
  // Managed server added alongside.
  expect(config.mcpServers?.[MCP_SERVER_NAME]?.command).toBe("gd-metapro");
});

test("AC2: re-install is idempotent (no duplicate, byte-identical second run)", async () => {
  const file = CURSOR_RUNTIME.settingsPath(root) as string;
  await installMcpClient(root, ["cursor"]);
  const first = await readFile(file, "utf8");
  await installMcpClient(root, ["cursor"]);
  await installMcpClient(root, ["cursor"]);
  const third = await readFile(file, "utf8");
  expect(third).toBe(first);

  const config = await readConfig(file);
  expect(Object.keys(config.mcpServers ?? {}).filter((k) => k === MCP_SERVER_NAME)).toEqual([
    MCP_SERVER_NAME,
  ]);
});

test("AC3: uninstall removes ONLY the managed entry, preserving other servers", async () => {
  const file = CURSOR_RUNTIME.settingsPath(root) as string;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      { mcpServers: { other: { command: "other-server" } }, userKey: 1 },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await installMcpClient(root, ["cursor"]);
  const report = await uninstallMcpClient(root, ["cursor"]);
  expect(report.outcomes[0]?.removed).toBe(true);

  const config = await readConfig(file);
  expect(config.mcpServers?.[MCP_SERVER_NAME]).toBeUndefined();
  expect(config.mcpServers?.other?.command).toBe("other-server");
  expect(config.userKey).toBe(1);
});

test("AC3: uninstall when nothing installed is a no-op", async () => {
  const report = await uninstallMcpClient(root, ["cursor"]);
  expect(report.outcomes[0]?.removed).toBe(false);
});

test("AC3: uninstall does not remove an unmanaged user gd-metapro entry", async () => {
  const file = CLAUDE_RUNTIME.settingsPath(root) as string;
  await writeFile(
    file,
    `${JSON.stringify(
      { mcpServers: { [MCP_SERVER_NAME]: { command: "custom", args: ["x"] } } },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const report = await uninstallMcpClient(root, ["claude"]);
  expect(report.outcomes[0]?.removed).toBe(false);
  const config = await readConfig(file);
  expect(config.mcpServers?.[MCP_SERVER_NAME]?.command).toBe("custom");
});

test("AC4: install flips modules.mcp.enabled=true, preserving the manifest", async () => {
  await writeManifest(undefined);
  await installMcpClient(root, ["cursor"]);

  const manifest = JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as { modules: Record<string, { enabled?: boolean }>; name: string };
  expect(manifest.modules.mcp?.enabled).toBe(true);
  // Other modules preserved.
  expect(manifest.modules.gdgraph?.enabled).toBe(true);
  expect(manifest.name).toBe("fixture");
});

test("AC4: enableMcpModule is a no-op with a message when the manifest is absent", async () => {
  const result = await enableMcpModule(root);
  expect(result.changed).toBe(false);
  expect(result.message).toContain("run `gd-metapro init`");
});

test("AC4: enableMcpModule never throws on a malformed manifest", async () => {
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{ not json", "utf8");
  const result = await enableMcpModule(root);
  expect(result.changed).toBe(false);
  expect(result.message).toContain("not valid JSON");
});

test("AC4: --dry-run writes no client file and no manifest change", async () => {
  await writeManifest(undefined);
  const report = await installMcpClient(root, ["cursor"], { dryRun: true });

  expect(report.dryRun).toBe(true);
  expect(report.outcomes[0]?.wrote).toBe(false);
  expect(report.outcomes[0]?.snippet).toContain(MCP_SERVER_NAME);
  // No file written.
  await expect(
    readFile(CURSOR_RUNTIME.settingsPath(root) as string, "utf8"),
  ).rejects.toThrow();
  // Manifest untouched (mcp module still absent).
  const manifest = JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as { modules: Record<string, unknown> };
  expect(manifest.modules.mcp).toBeUndefined();
});

test("AC5: probeMcpSdk returns an actionable hint when the SDK is absent", async () => {
  const absent = await probeMcpSdk(() => Promise.reject(new Error("ERR_MODULE_NOT_FOUND")));
  expect(absent.available).toBe(false);
  expect(absent.hint).toBe(MCP_SDK_HINT);

  const present = await probeMcpSdk(() => Promise.resolve({}));
  expect(present.available).toBe(true);
  expect(present.hint).toBeUndefined();
});

test("AC5/no-network: install opens no socket and makes no network call", async () => {
  await writeManifest(undefined);
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  let networkAttempts = 0;

  globalThis.fetch = (async () => {
    networkAttempts += 1;
    throw new Error("network blocked by mcp client-config sandbox");
  }) as unknown as typeof fetch;
  net.Socket.prototype.connect = function connect(this: net.Socket): net.Socket {
    networkAttempts += 1;
    throw new Error("socket blocked by mcp client-config sandbox");
  } as typeof net.Socket.prototype.connect;

  try {
    await installMcpClient(root, ["cursor", "claude", "generic"]);
    await uninstallMcpClient(root, ["all"]);
  } finally {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
  }

  expect(networkAttempts).toBe(0);
});
