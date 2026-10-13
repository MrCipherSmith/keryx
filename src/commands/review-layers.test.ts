import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { createLayersFixture, git, type LayersFixture } from "../review/layers.test-helpers";
import { readLayers } from "../review/layers";
import { reviewCommand } from "./review";

let fixture: LayersFixture;
let previousCwd: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  fixture = await createLayersFixture();
  previousCwd = process.cwd();
  process.chdir(fixture.root);
  logs = [];
  spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logs.push(parts.join(" "));
  });
  errors = [];
  spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    errors.push(parts.join(" "));
  });
  process.exitCode = 0;
});
afterEach(async () => {
  process.chdir(previousCwd);
  process.exitCode = 0;
  (console.log as unknown as { mockRestore(): void }).mockRestore();
  (console.error as unknown as { mockRestore(): void }).mockRestore();
  await fixture.cleanup();
});

describe("keryx review layers", () => {
  test("refresh writes layers.json for the package and prints the lines", async () => {
    await reviewCommand(["layers", "refresh", "--package", fixture.packageDir]);
    const layers = await readLayers(fixture.packageDir);
    expect(layers?.graph.status).toBe("ok");
    expect(layers?.graphCommit).toBe(fixture.second);
    const output = logs.join("\n");
    expect(output).toContain("graph: ok");
    expect(output).toContain("wiki: ok");
    expect(output).toContain("memory: ok");
    expect(existsSync(path.join(fixture.root, ".metaproject", "data", "gdgraph", "storage"))).toBe(false);
  });

  test("status refuses a package with no layers.json", async () => {
    await reviewCommand(["layers", "status", "--package", fixture.packageDir]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("no layers.json");
  });

  test("an unknown flag is refused and nothing is refreshed", async () => {
    await reviewCommand(["layers", "refresh", "--package", fixture.packageDir, "--nope"]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(path.join(fixture.packageDir, "layers.json"))).toBe(false);
  });
});

describe("blast-radius --package reads the package graph", () => {
  test("refreshes a package that has none and computes the radius from its graph", async () => {
    await reviewCommand(["blast-radius", "--package", fixture.packageDir, "--changed", "src/a.ts", "--json", "--no-related-tests"]);
    expect(existsSync(path.join(fixture.packageDir, "layers.json"))).toBe(true);
    const radius = JSON.parse(logs.join("\n")) as { files?: unknown };
    expect(JSON.stringify(radius)).toContain("src/b.ts");
    expect(git(fixture.root, ["rev-parse", "HEAD"])).toBe(fixture.second);
  });

  test("a graph that failed to build is a refusal, not an empty radius", async () => {
    await reviewCommand(["layers", "refresh", "--package", fixture.packageDir, "--head", "0123456789abcdef0123456789abcdef01234567"]);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    logs.length = 0;
    await reviewCommand(["blast-radius", "--package", fixture.packageDir, "--changed", "src/a.ts", "--no-related-tests", "--json"]);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/graph is failed|not computed from a graph/);
    expect(logs.join("\n")).not.toContain("src/b.ts");
  });
});
