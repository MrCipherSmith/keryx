// `keryx skills verify --all --json` and `--bundled --json` are versioned
// objects (rules/core/cli-interface-design.mdc, decision 3). This pins the
// version and the required keys, plus the one-release legacy-array opt-in.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function runCli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const home = mkdtempSync(path.join(tmpdir(), "keryx-verify-json-home-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.XDG_DATA_HOME = home;
  const proc = Bun.spawn(["bun", CLI, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** A project whose manifest registers no project skills. */
function emptyRegistryProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-verify-json-proj-"));
  mkdirSync(path.join(dir, ".metaproject"), { recursive: true });
  writeFileSync(
    path.join(dir, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { gdskills: { projectSkillRegistry: [] } } }),
    "utf8",
  );
  return dir;
}

describe("keryx skills verify --json envelopes", () => {
  test("--bundled --json carries a numeric schemaVersion and the evaluation keys", async () => {
    const result = await runCli(["skills", "verify", "--bundled", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as Record<string, unknown>;
    expect(typeof parsed.schemaVersion).toBe("number");
    expect(parsed.schemaVersion).toBe(1);
    for (const key of ["skills", "documents", "findings", "skillNames"]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(Object.keys(parsed)[0]).toBe("schemaVersion");
  }, 60_000);

  test("--all --json is an object with schemaVersion and results", async () => {
    const result = await runCli(["skills", "verify", "--all", "--json"], emptyRegistryProject());
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as Record<string, unknown>;
    expect(Array.isArray(parsed)).toBe(false);
    expect(typeof parsed.schemaVersion).toBe("number");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.results).toEqual([]);
    expect(result.err).not.toContain("deprecated");
  }, 60_000);

  test("--json-legacy-array restores the bare array and prints one deprecation notice", async () => {
    const result = await runCli(
      ["skills", "verify", "--all", "--json", "--json-legacy-array"],
      emptyRegistryProject(),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([]);
    expect(result.err.match(/deprecated/g)?.length).toBe(1);
  }, 60_000);
});
