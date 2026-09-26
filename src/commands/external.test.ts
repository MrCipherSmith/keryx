// Flow 346 — `keryx external on|off|status|list`, driven through the real
// CLI dispatcher. Hermetic: `XDG_DATA_HOME` is pointed at a fresh temp dir
// for the whole file (the same env-based seam `keryxConfigDir` already
// honours — no code change needed to make this test not touch the real
// `~/.local/share/keryx`), and `OPENROUTER_API_KEY` stays unset throughout.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { externalCommand } from "./external";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_XDG_DATA_HOME = process.env.XDG_DATA_HOME;
const ORIGINAL_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let CONFIG_HOME = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-external-cli-cwd-"));
}

beforeEach(async () => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  CONFIG_HOME = await mkdtemp(path.join(tmpdir(), "keryx-external-cli-xdg-"));
  process.env.XDG_DATA_HOME = CONFIG_HOME;
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ORIGINAL_XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = ORIGINAL_XDG_DATA_HOME;
  if (ORIGINAL_OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_API_KEY;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
  await rm(CONFIG_HOME, { recursive: true, force: true });
});

describe("keryx external status", () => {
  test("nothing configured -> on, source default, jev credential not available", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await externalCommand(["status", "--json"]);
    const parsed = JSON.parse(output()) as { external: string; source: string; jevCredentialAvailable: boolean; jevBlocked: boolean };
    expect(parsed.external).toBe("on");
    expect(parsed.source).toBe("default");
    expect(parsed.jevCredentialAvailable).toBe(false);
    expect(parsed.jevBlocked).toBe(false);
  });

  test("a credential in the environment is reported as available", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test-fake";
    await externalCommand(["status", "--json"]);
    const parsed = JSON.parse(output()) as { jevCredentialAvailable: boolean };
    expect(parsed.jevCredentialAvailable).toBe(true);
  });
});

describe("keryx external on|off", () => {
  test("off (per-user, default) persists to auth.json and status reflects it", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await externalCommand(["off"]);
    expect(output()).toContain("external: off");

    logs = [];
    await externalCommand(["status", "--json"]);
    const parsed = JSON.parse(output()) as { external: string; source: string; jevBlocked: boolean; providersBlocked: string[] };
    expect(parsed.external).toBe("off");
    expect(parsed.source).toBe("user");
    expect(parsed.jevBlocked).toBe(true);
    expect(parsed.providersBlocked).toContain("jev");

    const authOnDisk = JSON.parse(await readFile(path.join(CONFIG_HOME, "keryx", "auth.json"), "utf8")) as { external: string };
    expect(authOnDisk.external).toBe("off");
  });

  test("off --project writes .metaproject/tasks.config.json instead, and wins over a per-user \"on\"", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await externalCommand(["on"]); // per-user: on
    logs = [];
    await externalCommand(["off", "--project"]);
    expect(output()).toContain("this project");

    logs = [];
    await externalCommand(["status", "--json"]);
    const parsed = JSON.parse(output()) as { external: string; source: string };
    expect(parsed.external).toBe("off");
    expect(parsed.source).toBe("project");

    const projectOnDisk = JSON.parse(await readFile(path.join(ROOT, ".metaproject", "tasks.config.json"), "utf8")) as { external: string };
    expect(projectOnDisk.external).toBe("off");
  });

  test("on reverses off", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await externalCommand(["off"]);
    await externalCommand(["on"]);
    logs = [];
    await externalCommand(["status", "--json"]);
    const parsed = JSON.parse(output()) as { external: string };
    expect(parsed.external).toBe("on");
  });

  test("rejects an unknown flag", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await expect(externalCommand(["on", "--bogus"])).rejects.toThrow(/Unknown option/);
  });
});

describe("keryx external list", () => {
  test("creates external-providers.json with the built-in defaults on first use and prints it", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    await externalCommand(["list", "--json"]);
    const parsed = JSON.parse(output()) as { origin: string; config: { providers: { id: string }[]; modelPatterns: unknown[] } };
    expect(parsed.origin).toBe("default-created");
    expect(parsed.config.providers.map((p) => p.id)).toContain("jev");
    expect(parsed.config.modelPatterns.length).toBeGreaterThan(0);

    const onDisk = await readFile(path.join(CONFIG_HOME, "keryx", "external-providers.json"), "utf8");
    expect(JSON.parse(onDisk).providers.map((p: { id: string }) => p.id)).toContain("jev");
  });

  test("an operator-edited file (e.g. an emptied list) is read back, not silently reverted", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    const providersFile = path.join(CONFIG_HOME, "keryx", "external-providers.json");
    await mkdir(path.dirname(providersFile), { recursive: true });
    await writeFile(providersFile, JSON.stringify({ version: 1, providers: [], modelPatterns: [], notes: "cleared by operator" }), "utf8");

    await externalCommand(["list", "--json"]);
    const parsed = JSON.parse(output()) as { origin: string; config: { providers: unknown[]; notes: string } };
    expect(parsed.origin).toBe("user-file");
    expect(parsed.config.providers).toEqual([]);
    expect(parsed.config.notes).toBe("cleared by operator");
  });

  test("malformed JSON falls back to the built-in defaults, with a warning, and leaves the broken file untouched", async () => {
    ROOT = await projectRoot();
    process.chdir(ROOT);
    const providersFile = path.join(CONFIG_HOME, "keryx", "external-providers.json");
    await mkdir(path.dirname(providersFile), { recursive: true });
    await writeFile(providersFile, "{not json at all", "utf8");

    await externalCommand(["list"]);
    expect(output()).toContain("not valid JSON");
    expect(output()).toContain("jev");
    expect(await readFile(providersFile, "utf8")).toBe("{not json at all");
  });
});
