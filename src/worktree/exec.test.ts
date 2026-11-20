import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { allocatePorts } from "./ports";
import { addWorktree, createFixture, type Fixture } from "./test-support";
import { execInWorktree, formatExports } from "./worktree-env";

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe("formatExports", () => {
  test("plain values stay bare, others are single-quoted", () => {
    expect(formatExports({ PORT: "5201", URL: "http://127.0.0.1:5201" })).toBe("export PORT=5201\nexport URL=http://127.0.0.1:5201\n");
    expect(formatExports({ A: "it's $HOME; `x`", B: "" })).toBe("export A='it'\\''s $HOME; `x`'\nexport B=''\n");
  });

  test("rejects a name that is not a valid variable", () => {
    expect(() => formatExports({ "BAD NAME": "1" })).toThrow(/not a valid environment variable name/);
  });
});

describe("execInWorktree", () => {
  test("the child sees the allocated port in its environment, in the worktree cwd", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    const { ports } = await allocatePorts({
      cwd: worktree,
      config: { ports: { web: { env: "PORT", range: [47500, 47510] } } },
      isPortFree: () => true,
    });
    const out = path.join(fixture.base, "out.txt");
    const script = "require('node:fs').writeFileSync(process.argv[1], process.env.PORT + '|' + process.cwd())";
    const code = await execInWorktree({ cwd: worktree, argv: [process.execPath, "-e", script, out] });
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(`${ports.web}|${worktree}`);
  });

  test("returns the exit code and lets explicit env win", async () => {
    fixture = createFixture();
    const worktree = addWorktree(fixture, "wt-a");
    const code = await execInWorktree({
      cwd: worktree,
      argv: [process.execPath, "-e", "process.exit(process.env.PORT === 'x' ? 7 : 1)"],
      env: { PORT: "x" },
    });
    expect(code).toBe(7);
  });

  test("an empty argv is an error", async () => {
    await expect(execInWorktree({ cwd: process.cwd(), argv: [] })).rejects.toThrow(/no command/);
  });
});
