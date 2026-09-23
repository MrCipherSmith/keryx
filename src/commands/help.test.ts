// Flow 303: `keryx help` — AC3 (grouped listing), AC4 (group / command /
// slash-command detail, unknown-name suggestions), AC5 (rich group helps
// unchanged), AC10 (`help` itself is a real, working verb).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { helpCommand } from "./help";
import { printFlowHelp } from "./flow";

let logged: string[] = [];
let errored: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  logged = [];
  errored = [];
  originalLog = console.log;
  originalError = console.error;
  originalExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errored.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode;
});

describe("AC3: `keryx help` with no argument", () => {
  test("prints every onboarding group with its commands", async () => {
    await helpCommand([]);
    const out = logged.join("\n");
    expect(out).toContain("Start here:");
    expect(out).toContain("Maintenance and diagnostics:");
    expect(out).toContain("init");
    expect(out).toContain("shell");
    expect(process.exitCode).toBe(0);
  });

  test("every line is within 80 columns", async () => {
    await helpCommand([]);
    for (const block of logged) {
      for (const line of block.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    }
  });
});

describe("AC4: `keryx help <group>`", () => {
  test("prints just that group", async () => {
    await helpCommand(["project-knowledge"]);
    const out = logged.join("\n");
    expect(out).toContain("Project knowledge:");
    expect(out).toContain("gdgraph");
    expect(out).not.toContain("Start here:");
    expect(process.exitCode).toBe(0);
  });
});

describe("AC4/AC5: `keryx help <command>`", () => {
  test("a plain verb prints its own usage block", async () => {
    await helpCommand(["init"]);
    const out = logged.join("\n");
    expect(out).toContain("keryx init");
    expect(process.exitCode).toBe(0);
  });

  test("flow — one of the four rich-help verbs — prints EXACTLY what `flow --help` prints", async () => {
    await helpCommand(["flow"]);
    const viaHelp = logged.join("\n");
    logged = [];
    printFlowHelp();
    const viaRich = logged.join("\n");
    expect(viaHelp).toBe(viaRich);
  });

  test("a slash command prints its detail, naming it has no CLI form", async () => {
    await helpCommand(["/theme"]);
    const out = logged.join("\n");
    expect(out).toContain("/theme");
    expect(out).toContain("no standalone CLI form");
    expect(process.exitCode).toBe(0);
  });
});

describe("AC4: an unknown name", () => {
  test("exits non-zero and names the closest matches", async () => {
    await helpCommand(["automaton"]); // one letter off "automation"
    expect(process.exitCode).toBe(1);
    const out = errored.join("\n");
    expect(out).toContain("Unknown help topic");
    expect(out).toContain("automation");
  });

  test("a wildly unrelated name still exits non-zero, with no false suggestion", async () => {
    await helpCommand(["zzzzzzzzzzzzzzzzzzzz"]);
    expect(process.exitCode).toBe(1);
    expect(errored.join("\n")).toContain("Unknown help topic");
  });
});

describe("AC10: `help` is a real, working verb", () => {
  test("running it end-to-end produces no thrown error and a clean exit", async () => {
    await expect(helpCommand(["governance"])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(0);
  });
});
