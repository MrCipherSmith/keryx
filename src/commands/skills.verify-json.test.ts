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
  const proc = Bun.spawn(["bun", CLI, ...args], { env, ...(cwd === undefined ? {} : { cwd }), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
}

/** A project with one registered project skill, `review/review-house`, that `skills verify <target>` can verify. */
function oneSkillProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-verify-json-one-"));
  const packageRoot = path.join(dir, ".metaproject", "project-skills", "review", "review-house");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(dir, ".metaproject", "metaproject.json"),
    JSON.stringify({
      modules: {
        gdskills: {
          projectSkillRegistry: [
            { module: "review", name: "review-house", target: "review-house", path: ".metaproject/project-skills/review/review-house", version: "0.1.0", status: "active", updatedAt: "2026-09-09T00:00:00.000Z" },
          ],
        },
      },
    }),
    "utf8",
  );
  writeFileSync(path.join(packageRoot, "SKILL.md"), '---\nname: review-house\nmetadata:\n  version: "2.0.0"\n---\n\n# House\n', "utf8");
  writeFileSync(path.join(packageRoot, "skill-changelog.md"), "# changelog\n", "utf8");
  return dir;
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

  test("a single target --json carries schemaVersion first, then the report", async () => {
    const result = await runCli(["skills", "verify", "review/review-house", "--json", "--dry-run"], oneSkillProject());
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe("schemaVersion");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.module).toBe("review");
    expect(parsed.name).toBe("review-house");
  }, 60_000);

  test("--json-legacy-array is refused unless used with --all --json", async () => {
    for (const args of [
      ["skills", "verify", "review/review-house", "--json", "--json-legacy-array"],
      ["skills", "verify", "--all", "--json-legacy-array"],
      ["skills", "verify", "--bundled", "--json", "--json-legacy-array"],
    ]) {
      const result = await runCli(args, oneSkillProject());
      expect(result.code).toBe(1);
      expect(result.err).toContain("--json-legacy-array only applies to `--all --json`");
      expect(result.out).toBe("");
    }
  }, 60_000);
});
