import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubUpdateCommand } from "./hub-update";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function installation(options: { legacy?: boolean; exit?: number; rootName?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "hub-update-cli-")); dirs.push(home);
  const root = join(home, options.rootName ?? "keryx-team-hub");
  mkdirSync(join(root, "releases", "v0.4.3"), { recursive: true });
  symlinkSync("releases/v0.4.3", join(root, "current"));
  const log = join(root, "arguments.json");
  // A local, deliberately synthetic installation tool: never Docker, networking or live state.
  writeFileSync(join(root, "hubctl"), `#!/bin/sh\n${options.legacy ? "# old compose wrapper" : "# keryx-hub-update-protocol: 1"}\nprintf '%s\\n' "$@" > '${log.replaceAll("'", "'\\''")}'\nexit ${options.exit ?? 0}\n`);
  chmodSync(join(root, "hubctl"), 0o700);
  return { home, root, log };
}

test("default update delegates latest to the installed tool, without a shell", async () => {
  const fixture = installation();
  expect(await hubUpdateCommand([], { home: fixture.home })).toBe(0);
  expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual(["upgrade", "latest"]);
});
test("check and dry run use the read-only bridge while explicit apply preserves confirmation", async () => {
  const fixture = installation();
  for (const [args, expected] of [
    [["--check"], ["update-check", "latest"]],
    [["v0.4.4", "--check"], ["update-check", "v0.4.4"]],
    [["0.4.4", "--dry-run"], ["upgrade", "0.4.4", "--dry-run"]],
    [["0.4.4", "--yes"], ["upgrade", "0.4.4", "--yes"]],
  ] satisfies [string[], string[]][]) {
    expect(await hubUpdateCommand(args, { home: fixture.home })).toBe(0);
    expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual(expected);
  }
});
test("explicit install directory is literal, independent of cwd or shell metacharacters", async () => {
  const fixture = installation({ rootName: "a space; $(not-a-command)" });
  expect(await hubUpdateCommand(["--install-dir", fixture.root, "--check"])).toBe(0);
  expect(readFileSync(fixture.log, "utf8").trim().split("\n")).toEqual(["update-check", "latest"]);
});
test("invalid versions, unknown/repeated/conflicting flags fail before executing the tool", async () => {
  const fixture = installation();
  const cases = [
    ["0.4.4;touch /tmp/injection"], ["--version", "0.4.4"], ["v0.4.4\nlatest"],
    ["../latest"], ["https://example.com/update.sh"], ["0.4.4", "0.4.5"],
    ["--check", "--dry-run"], ["--check", "--yes"], ["--dry-run", "--yes"],
    ["--check", "--check"], ["--install-dir"], ["--install-dir", "--yes"],
    ["--token-env", "KERYX_HUB_TOKEN"], ["--url", "https://hub.example"],
    ["--install-dir", "https://example.com"], ["--install-dir", "bad\0path"],
    ["--install-dir", fixture.root, "--install-dir", fixture.root],
  ];
  for (const args of cases) await expect(hubUpdateCommand(args, { home: fixture.home })).rejects.toThrow();
  expect(() => readFileSync(fixture.log)).toThrow();
});
test("legacy wrappers and missing installs fail before any execution", async () => {
  const fixture = installation({ legacy: true });
  await expect(hubUpdateCommand([], { home: fixture.home })).rejects.toThrow("legacy");
  expect(() => readFileSync(fixture.log)).toThrow();
  await expect(hubUpdateCommand(["--install-dir", join(fixture.home, "absent")])).rejects.toThrow("installation");
});
test("a tool outside the selected install or a current link outside releases is refused", async () => {
  const fixture = installation();
  const external = join(fixture.home, "other-tool");
  writeFileSync(external, "#!/bin/sh\n# keryx-hub-update-protocol: 1\nexit 0\n", { mode: 0o700 });
  rmSync(join(fixture.root, "hubctl")); symlinkSync(external, join(fixture.root, "hubctl"));
  await expect(hubUpdateCommand([], { home: fixture.home })).rejects.toThrow("installation");
  const other = installation();
  rmSync(join(other.root, "current")); symlinkSync(other.home, join(other.root, "current"));
  await expect(hubUpdateCommand([], { home: other.home })).rejects.toThrow("installation");
});
test("foreign-owned tool and installation directories are refused before execution", async () => {
  const foreignUid = Math.max(process.getuid?.() ?? 0, 1) + 1;
  for (const target of ["hubctl", "root", "releases", "current"] as const) {
    const fixture = installation();
    const root = realpathSync(fixture.root);
    const unsafePath = target === "root" ? root : target === "current" ? join(root, "releases", "v0.4.3") : join(root, target);
    const originalLstat = fsPromises.lstat;
    const originalStat = fsPromises.stat;
    const toolInfo = await originalLstat(join(root, "hubctl"));
    if (unsafePath === join(root, "hubctl")) Object.defineProperty(toolInfo, "uid", { value: foreignUid });
    const directoryInfo = await Promise.all([root, join(root, "releases"), join(root, "releases", "v0.4.3")].map(async path => {
      const value = await originalStat(path);
      if (path === unsafePath) Object.defineProperty(value, "uid", { value: foreignUid });
      return value;
    }));
    const lstatMock = spyOn(fsPromises, "lstat").mockResolvedValueOnce(toolInfo);
    const statMock = spyOn(fsPromises, "stat");
    for (const info of directoryInfo) statMock.mockResolvedValueOnce(info);
    try {
      await expect(hubUpdateCommand(["--check"], { home: fixture.home })).rejects.toThrow("installation");
      expect(() => readFileSync(fixture.log)).toThrow();
    } finally { lstatMock.mockRestore(); statMock.mockRestore(); }
  }
});
test("root-owned installation metadata remains trusted by an invoking service user", async () => {
  const fixture = installation();
  const root = realpathSync(fixture.root);
  const originalLstat = fsPromises.lstat;
  const originalStat = fsPromises.stat;
  const toolInfo = await originalLstat(join(root, "hubctl")); Object.defineProperty(toolInfo, "uid", { value: 0 });
  const directoryInfo = await Promise.all([root, join(root, "releases"), join(root, "releases", "v0.4.3")].map(async path => {
    const value = await originalStat(path); Object.defineProperty(value, "uid", { value: 0 }); return value;
  }));
  const lstatMock = spyOn(fsPromises, "lstat").mockResolvedValueOnce(toolInfo);
  const statMock = spyOn(fsPromises, "stat");
  for (const info of directoryInfo) statMock.mockResolvedValueOnce(info);
  try { expect(await hubUpdateCommand(["--check"], { home: fixture.home })).toBe(0); }
  finally { lstatMock.mockRestore(); statMock.mockRestore(); }
});
test("installed tool failures retain the exact nonzero status", async () => {
  const fixture = installation({ exit: 42 });
  expect(await hubUpdateCommand(["--check"], { home: fixture.home })).toBe(42);
});
test("Hub routing handles update before binding flags and preserves existing help", async () => {
  const { hubCommand, HUB_HELP } = await import("./hub");
  expect(HUB_HELP).toContain("update [version]");
  expect(HUB_HELP).toContain("machine pair");
  expect(HUB_HELP).toContain("sync [--watch");
  await expect(hubCommand(["update", "--url", "https://hub.example"])).rejects.toThrow("hub update");
});
test("top-level Hub update preserves a failing installation exit status", async () => {
  const { hubCommand } = await import("./hub");
  const fixture = installation({ exit: 42 });
  const previous = process.exitCode;
  try {
    await hubCommand(["update", "--check", "--install-dir", fixture.root]);
    expect(process.exitCode).toBe(42);
  } finally { process.exitCode = previous ?? 0; }
});
test("dedicated help needs no installation and performs no command", async () => {
  const output: string[] = [];
  expect(await hubUpdateCommand(["--help"], { home: "/missing-installation", write: value => output.push(value) })).toBe(0);
  expect(output.join("")).toContain("local server installation");
});
test("CLI help interception prints dedicated update help without invoking an install", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "..", "cli.ts"), "hub", "update", "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0); expect(errors).toBe("");
  expect(output).toContain("local server installation");
  expect(output).toContain("--install-dir");
  expect(output).not.toContain("Cannot use this Hub installation");
}, 15_000);
