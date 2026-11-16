import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rejectUnknownFlags, unknownFlags } from "../lib/args";

// One refusal for every command (cli-interface-design.mdc, decision 4): an
// unknown flag exits 1 and prints one stderr line that names the flag.

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function runCli(...argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  // A throwaway HOME: a guard that fails to refuse must not write the real user layer (routing set).
  const home = mkdtempSync(path.join(tmpdir(), "keryx-unknown-flags-home-"));
  const run = Bun.spawnSync(["bun", "src/cli.ts", ...argv], { cwd: REPO_ROOT, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home } });
  return { exitCode: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

describe("the shared unknown-flag helper", () => {
  test("names every unknown flag once, in argv order, in both spellings", () => {
    expect(unknownFlags(["--a", "--b=1", "--a", "--ok", "word"], ["--ok"])).toEqual(["--a", "--b"]);
  });

  test("a bare word and an accepted flag are never refused", () => {
    expect(unknownFlags(["word", "--json", "--limit=3"], ["--json", "--limit"])).toEqual([]);
  });

  test("single-dash tokens are flags only when asked for", () => {
    expect(unknownFlags(["-x"], [])).toEqual([]);
    expect(unknownFlags(["-x", "-5", "-"], [], { shortFlags: true })).toEqual(["-x", "-5", "-"]);
  });

  test("--name=value is refused unless the caller reads that spelling for that flag", () => {
    expect(() => rejectUnknownFlags(["--project=1"], ["--user", "--project"], "routing")).toThrow(
      "`keryx routing` does not take a value with --project (got --project=1). Give the bare flag.",
    );
    expect(() => rejectUnknownFlags(["--limit=3", "--json"], ["--limit", "--json"], "demo", { valueFlags: ["--limit"] })).not.toThrow();
    expect(() => rejectUnknownFlags(["--json=1"], ["--limit", "--json"], "demo", { valueFlags: ["--limit"] })).toThrow("--json");
  });

  test("the refusal is one line that names the flag and lists what is accepted", () => {
    let message = "";
    try {
      rejectUnknownFlags(["--bogus"], ["--json"], "demo run");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("Unknown option for `keryx demo run`: --bogus. Accepted: --json.");
    expect(message).not.toContain("\n");
  });

  test("a command with no flags says so", () => {
    expect(() => rejectUnknownFlags(["--x", "--y"], [], "demo")).toThrow("Unknown options for `keryx demo`: --x, --y. Accepted: (none).");
  });
});

describe("AC1: a bogus flag is refused by name, exit 1, one stderr line", () => {
  const cases: Array<{ label: string; argv: string[] }> = [
    { label: "keryx modules status --bogus", argv: ["modules", "status", "--bogus"] },
    { label: "keryx skills verify --bundled --bogus", argv: ["skills", "verify", "--bundled", "--bogus"] },
    { label: "keryx memory search --bogus x", argv: ["memory", "search", "--bogus", "x"] },
    { label: "keryx modules list --bogus", argv: ["modules", "list", "--bogus"] },
    { label: "keryx modules --bogus", argv: ["modules", "--bogus"] },
    { label: "keryx governance report --bogus", argv: ["governance", "report", "--bogus"] },
    { label: "keryx product index --bogus", argv: ["product", "index", "--bogus"] },
    { label: "keryx product open --bogus", argv: ["product", "open", "--bogus"] },
    { label: "keryx routing list --bogus", argv: ["routing", "list", "--bogus"] },
    { label: "keryx routing set review x --bogus", argv: ["routing", "set", "review", "x", "--bogus"] },
    { label: "keryx workspace list --bogus", argv: ["workspace", "list", "--bogus"] },
  ];

  for (const { label, argv } of cases) {
    test(label, () => {
      const run = runCli(...argv);
      expect(run.exitCode).toBe(1);
      const lines = run.stderr.split("\n").filter((line) => line.trim() !== "");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("--bogus");
      expect(run.stdout).not.toContain("--bogus");
    });
  }
});

describe("a --name=value token is refused where the handler reads the bare flag", () => {
  const cases: Array<{ label: string; argv: string[]; flag: string }> = [
    { label: "routing set ... --project=1 (must not write the user layer)", argv: ["routing", "set", "review", "x", "--project=1"], flag: "--project" },
    { label: "routing unset ... --project=1", argv: ["routing", "unset", "review", "--project=1"], flag: "--project" },
    { label: "routing list --json=1", argv: ["routing", "list", "--json=1"], flag: "--json" },
    { label: "product index --json=1", argv: ["product", "index", "--json=1"], flag: "--json" },
    { label: "product open --json=1", argv: ["product", "open", "--json=1"], flag: "--json" },
    { label: "modules list --json=1", argv: ["modules", "list", "--json=1"], flag: "--json" },
    { label: "modules status --json=1", argv: ["modules", "status", "--json=1"], flag: "--json" },
    { label: "modules --json=1", argv: ["modules", "--json=1"], flag: "--json" },
    { label: "governance report --json=1", argv: ["governance", "report", "--json=1"], flag: "--json" },
    { label: "memory search x --json=1", argv: ["memory", "search", "x", "--json=1"], flag: "--json" },
  ];

  for (const { label, argv, flag } of cases) {
    test(label, () => {
      const run = runCli(...argv);
      expect(run.exitCode).toBe(1);
      const lines = run.stderr.split("\n").filter((line) => line.trim() !== "");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(flag);
      expect(lines[0]).toContain(`${flag}=1`);
    });
  }

  test("a value flag keeps its --name=value spelling (governance report --flow=x)", () => {
    const run = runCli("governance", "report", "--flow=does-not-exist");
    expect(run.stderr).not.toContain("does not take a value");
  });
});

describe("product refuses a stray dash token", () => {
  for (const token of ["-", "-5", "-x"]) {
    test(`keryx product index ${token}`, () => {
      const run = runCli("product", "index", token);
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(`\`keryx product index\``);
      expect(run.stderr).toContain(token);
    });
  }
});

describe("memory search --help", () => {
  test("prints usage on stdout and exits 0", () => {
    for (const flag of ["--help", "-h"]) {
      const run = runCli("memory", "search", flag);
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("keryx memory search");
      expect(run.stderr).toBe("");
    }
  });
});
