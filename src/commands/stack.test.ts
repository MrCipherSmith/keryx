// Flow 309 (W1, Lane A): `keryx stack detect` CLI. In-process command tests
// plus a real spawn of `bun ./src/cli.ts stack detect` for the Wave-2 exit
// evidence — determinism and offline-ness.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { stackCommand } from "./stack";
import { stackJsonPath } from "../stack/service";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

const tempDirs: string[] = [];

async function makeTempRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-stack-cmd-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

let captured: string[] = [];
let capturedOut: string[] = [];
let capturedErr: string[] = [];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalStdoutWrite: typeof process.stdout.write;

function install(): void {
  captured = [];
  capturedOut = [];
  capturedErr = [];
  originalLog = console.log;
  originalErr = console.error;
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => capturedErr.push(parts.map(String).join(" "));
  process.stdout.write = ((chunk: unknown) => {
    capturedOut.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.exitCode = 0;
}

function restore(): void {
  console.log = originalLog;
  console.error = originalErr;
  process.stdout.write = originalStdoutWrite;
}

describe("keryx stack detect — basic behavior", () => {
  test("writes stack.json under .metaproject/data/stack/ and prints a human summary", async () => {
    install();
    try {
      const root = await makeTempRepo();
      await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }));

      await stackCommand(["detect"], root);
      expect(process.exitCode).toBe(0);
      expect(capturedErr).toEqual([]);
      expect(captured.join("\n")).toContain("react");

      const onDisk = await readFile(stackJsonPath(root), "utf8");
      const parsed = JSON.parse(onDisk) as { tags: Record<string, boolean> };
      expect(parsed.tags.react).toBe(true);
    } finally {
      restore();
    }
  });

  test("--json prints exactly the persisted document", async () => {
    install();
    try {
      const root = await makeTempRepo();
      await writeFile(path.join(root, "go.mod"), "module example.com/app\n");

      await stackCommand(["detect", "--json"], root);
      expect(process.exitCode).toBe(0);
      const printed = capturedOut.join("");
      const onDisk = await readFile(stackJsonPath(root), "utf8");
      expect(printed).toBe(onDisk);
      const parsed = JSON.parse(printed) as { tags: Record<string, boolean> };
      expect(parsed.tags.go).toBe(true);
    } finally {
      restore();
    }
  });

  test("--no-write detects without writing stack.json", async () => {
    install();
    try {
      const root = await makeTempRepo();
      await writeFile(path.join(root, "Cargo.toml"), "[package]\nname = \"app\"\n");

      await stackCommand(["detect", "--no-write"], root);
      expect(process.exitCode).toBe(0);

      let existsErr: unknown;
      try {
        await readFile(stackJsonPath(root), "utf8");
      } catch (error) {
        existsErr = error;
      }
      expect(existsErr).toBeDefined();
    } finally {
      restore();
    }
  });

  test("F13: --cwd pointing at a nonexistent directory exits 1 with a clear error, no dirs created", async () => {
    install();
    try {
      const base = await makeTempRepo();
      const missing = path.join(base, "does-not-exist");

      await stackCommand(["detect", "--cwd", "does-not-exist"], base);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("does not exist");

      let created = true;
      try {
        await statSync(missing);
      } catch {
        created = false;
      }
      expect(created).toBe(false);
    } finally {
      restore();
    }
  });

  test("F13: --cwd pointing at a file (not a directory) exits 1", async () => {
    install();
    try {
      const base = await makeTempRepo();
      const filePath = path.join(base, "not-a-dir");
      await writeFile(filePath, "hello");

      await stackCommand(["detect", "--cwd", "not-a-dir"], base);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("not a directory");
    } finally {
      restore();
    }
  });

  test("F13: --cwd with no value exits 1 instead of silently using the process cwd", async () => {
    install();
    try {
      const base = await makeTempRepo();

      await stackCommand(["detect", "--cwd"], base);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("--cwd requires a directory argument");

      let existsErr: unknown;
      try {
        await readFile(stackJsonPath(base), "utf8");
      } catch (error) {
        existsErr = error;
      }
      expect(existsErr).toBeDefined();
    } finally {
      restore();
    }
  });

  test("F13: --cwd followed immediately by another flag exits 1 (flag consumed as a directory would be wrong)", async () => {
    install();
    try {
      const base = await makeTempRepo();

      await stackCommand(["detect", "--cwd", "--json"], base);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("--cwd requires a directory argument");
    } finally {
      restore();
    }
  });

  test("--cwd points detection at another directory", async () => {
    install();
    try {
      const base = await makeTempRepo();
      const target = path.join(base, "target");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "Dockerfile"), "FROM node:20\n");

      await stackCommand(["detect", "--cwd", "target"], base);
      expect(process.exitCode).toBe(0);

      const onDisk = await readFile(stackJsonPath(target), "utf8");
      const parsed = JSON.parse(onDisk) as { tags: Record<string, boolean> };
      expect(parsed.tags.docker).toBe(true);
    } finally {
      restore();
    }
  });

  test("keryx stack --help prints usage", async () => {
    install();
    try {
      await stackCommand(["--help"], REPO_ROOT);
      expect(process.exitCode).toBe(0);
      expect(captured.join("\n")).toContain("stack detect");
    } finally {
      restore();
    }
  });

  test("unknown subcommand exits 1 with usage", async () => {
    install();
    try {
      await stackCommand(["bogus"], REPO_ROOT);
      expect(process.exitCode).toBe(1);
      expect(capturedErr.join("\n")).toContain("Unknown stack command");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Wave-2 exit evidence: deterministic and offline.
// ---------------------------------------------------------------------------

function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "src", "cli.ts"), ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // No signal source in this module ever needs the network, and this
        // proves it rather than assuming it: any outbound call would hit a
        // proxy nothing is listening on and fail loudly instead of silently
        // succeeding against the real internet.
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: "",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("stack detect — Wave-2 exit: deterministic and offline", () => {
  test("two runs of `bun ./src/cli.ts stack detect --json` on the same fixture repo produce byte-identical stdout and stack.json bytes", async () => {
    const root = await makeTempRepo();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } }),
    );
    await writeFile(path.join(root, "go.mod"), "module example.com/app\n\ngo 1.22\n");

    const first = await runCli(["stack", "detect", "--json"], root);
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const firstStackBytes = await readFile(stackJsonPath(root), "utf8");

    const second = await runCli(["stack", "detect", "--json"], root);
    expect(second.code).toBe(0);
    expect(second.stderr).toBe("");
    const secondStackBytes = await readFile(stackJsonPath(root), "utf8");

    expect(second.stdout).toBe(first.stdout);
    expect(secondStackBytes).toBe(firstStackBytes);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Wave-2 defect fix: reasons are repo-relative, output is portable across
// checkout locations, and `matched` carries marker/manifest evidence too.
// ---------------------------------------------------------------------------

async function writeFixture(root: string): Promise<void> {
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { react: "^18.0.0", "react-dom": "^18.0.0", mobx: "^6.0.0" } }),
  );
  await writeFile(path.join(root, "Dockerfile"), "FROM node:20\n");
  await writeFile(path.join(root, "go.mod"), "module example.com/app\n\ngo 1.22\n");
}

describe("stack detect — no absolute paths in reasons", () => {
  test("reason and every perSignal[].reason are repo-relative, not the fixture's absolute dir", async () => {
    const root = await makeTempRepo();
    await writeFixture(root);

    const result = await runCli(["stack", "detect", "--json"], root);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as { reason: string; perSignal: { reason: string }[] };

    expect(parsed.reason).not.toContain(root);
    expect(parsed.reason).not.toContain(tmpdir());
    for (const signal of parsed.perSignal) {
      expect(signal.reason).not.toContain(root);
      expect(signal.reason).not.toContain(tmpdir());
    }
  }, 30_000);
});

describe("stack detect — portable across checkout locations", () => {
  test("the same fixture copied into two different temp directories yields byte-identical stack.json and inputsSha256", async () => {
    const rootA = await makeTempRepo();
    const rootB = await makeTempRepo();
    await writeFixture(rootA);
    await writeFixture(rootB);

    const resultA = await runCli(["stack", "detect", "--json"], rootA);
    const resultB = await runCli(["stack", "detect", "--json"], rootB);
    expect(resultA.code).toBe(0);
    expect(resultB.code).toBe(0);

    const parsedA = JSON.parse(resultA.stdout) as { inputsSha256: string; detectedAt: string };
    const parsedB = JSON.parse(resultB.stdout) as { inputsSha256: string; detectedAt: string };
    expect(parsedA.inputsSha256).toBe(parsedB.inputsSha256);

    // Bytes are identical modulo the `detectedAt` timestamp, which each run
    // stamps independently (no shared prior stack.json to inherit it from).
    const bytesA = resultA.stdout.replace(parsedA.detectedAt, "<detectedAt>");
    const bytesB = resultB.stdout.replace(parsedB.detectedAt, "<detectedAt>");
    expect(bytesA).toBe(bytesB);
  }, 30_000);
});

describe("stack detect — matched includes marker evidence", () => {
  test("matched contains dependency names AND marker/manifest hits like Dockerfile and go.mod", async () => {
    const root = await makeTempRepo();
    await writeFixture(root);

    const result = await runCli(["stack", "detect", "--json"], root);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { matched: string[] };

    expect(parsed.matched).toContain("react");
    expect(parsed.matched).toContain("Dockerfile");
    expect(parsed.matched).toContain("go.mod");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Static: nothing under src/stack/*.ts (non-test) is network-capable.
// ---------------------------------------------------------------------------

describe("src/stack/*.ts is offline by construction", () => {
  test("no network- or provider-capable import or call appears in non-test stack sources", () => {
    const dir = path.join(REPO_ROOT, "src", "stack");
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) {
        continue;
      }
      const full = path.join(dir, name);
      if (!statSync(full).isFile()) {
        continue;
      }
      const source = readFileSync(full, "utf8");
      expect(source).not.toMatch(/fetch\(/);
      expect(source).not.toMatch(/["']node:http["']/);
      expect(source).not.toMatch(/["']node:https["']/);
      expect(source).not.toMatch(/["']node:net["']/);
    }
  });
});
