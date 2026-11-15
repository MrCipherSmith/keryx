import { describe, expect, test } from "bun:test";
import path from "node:path";
import { rejectUnknownFlags, unknownFlags } from "../lib/args";

// One refusal for every command (cli-interface-design.mdc, decision 4): an
// unknown flag exits 1 and prints one stderr line that names the flag.

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function runCli(...argv: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["bun", "src/cli.ts", ...argv], { cwd: REPO_ROOT, env: process.env });
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
    expect(unknownFlags(["-x", "-5"], [], { shortFlags: true })).toEqual(["-x"]);
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
