// Terminal-escape containment across every output path of `keryx projects`
// (flow 127).
//
// The first version of this file was advertised as a class-level guard and was
// not one: it only exercised library functions, so mutation-checking showed it
// caught 2 of 4 sanitizer sites and would not have caught three of the four
// escape holes the commit that introduced it had just fixed. It also carried a
// `toBeGreaterThan(0)` assertion on a raw entry — a tautology in a branch whose
// first review round was rejected for exactly that.
//
// So this drives the COMMANDS, with stdout and stderr captured, and asserts the
// combined output carries no control characters. That is the only formulation
// that fails when a sanitizer is removed from a command-layer call site.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectsCommand } from "./projects";
import {
  emitProjectsJson,
  listProjects,
  projectRegistryPath,
  registerProject,
} from "../lib/project-registry";

const ESC = "";
const BEL = "";
/** An OSC title-set plus a screen clear — the shapes that rewrite a terminal. */
const HOSTILE = `${ESC}]0;PWNED${BEL}${ESC}[2J`;

let configDir = "";
let workspace = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalXdg: string | undefined;

function controlCharacters(text: string): string[] {
  return [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

/** Everything written to stdout+stderr, minus the newlines writers legitimately emit. */
function offendingCharacters(): string[] {
  return controlCharacters(captured.join("\n").replace(/\n/g, ""));
}

function makeProject(name: string): string {
  const root = path.join(workspace, name);
  mkdirSync(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-escape-"));
  configDir = path.join(base, "config");
  workspace = path.join(base, "work");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  // The commands resolve the registry through the user-global config dir, so
  // point that at the fixture rather than the developer's real registry.
  originalXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = configDir;

  captured = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  if (originalXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdg;
  }
  process.exitCode = 0;
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

/** Where the registry lives once XDG_DATA_HOME points at the fixture. */
function fixtureRegistryPath(): string {
  return projectRegistryPath(path.join(configDir, "keryx"));
}

describe("no command output carries terminal control characters", () => {
  test("register, refusing a hostile directory name", async () => {
    const hostile = path.join(workspace, `dir${HOSTILE}name`);
    mkdirSync(hostile, { recursive: true });

    await projectsCommand(["register", hostile]);

    expect(captured.length).toBeGreaterThan(0);
    expect(offendingCharacters()).toEqual([]);
  });

  test("register, succeeding on a hostile directory name", async () => {
    const hostile = path.join(workspace, `ok${HOSTILE}dir`);
    mkdirSync(path.join(hostile, ".metaproject"), { recursive: true });

    await projectsCommand(["register", hostile]);

    expect(captured.length).toBeGreaterThan(0);
    expect(offendingCharacters()).toEqual([]);
  });

  test("list, rendering a hostile directory name", async () => {
    const hostile = path.join(workspace, `proj${HOSTILE}ect`);
    mkdirSync(path.join(hostile, ".metaproject"), { recursive: true });
    await projectsCommand(["register", hostile]);
    captured = [];

    await projectsCommand(["list"]);

    // Not vacuous: the entry must actually be rendered.
    expect(captured.join("")).toContain("project");
    expect(offendingCharacters()).toEqual([]);
  });

  test("forget, on a hostile id that does not exist", async () => {
    await projectsCommand(["forget", `bogus${HOSTILE}id`]);

    expect(captured.length).toBeGreaterThan(0);
    expect(offendingCharacters()).toEqual([]);
  });

  test("forget, SUCCEEDING on a hostile id", async () => {
    // The success branch echoed the id raw while the two failure branches beside
    // it were sanitized — a fifth site inside the function the previous round
    // claimed to have fixed.
    const project = makeProject("alpha");
    await projectsCommand(["register", project]);

    const onDisk = JSON.parse(readFileSync(fixtureRegistryPath(), "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    const hostileId = `id${HOSTILE}x`;
    onDisk.projects[0]!.projectId = hostileId;
    writeFileSync(fixtureRegistryPath(), JSON.stringify(onDisk), "utf8");
    captured = [];

    await projectsCommand(["forget", hostileId]);

    expect(captured.join("")).toContain("Forgotten");
    expect(offendingCharacters()).toEqual([]);
  });

  test("an unknown subcommand echoing hostile argv", async () => {
    await projectsCommand([`sub${HOSTILE}cmd`]);

    expect(captured.length).toBeGreaterThan(0);
    expect(offendingCharacters()).toEqual([]);
  });

  test("an unknown option echoing hostile argv", async () => {
    await projectsCommand(["list", `--opt${HOSTILE}x`]);

    expect(captured.length).toBeGreaterThan(0);
    expect(offendingCharacters()).toEqual([]);
  });

  test("the credential-strip warning, from a hostile field name", async () => {
    const project = makeProject("beta");
    await projectsCommand(["register", project]);

    const onDisk = JSON.parse(readFileSync(fixtureRegistryPath(), "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    onDisk.projects[0]![`token${HOSTILE}x`] = "value";
    writeFileSync(fixtureRegistryPath(), JSON.stringify(onDisk), "utf8");
    captured = [];

    await projectsCommand(["register", project]);

    expect(captured.join("")).toContain("credential-shaped");
    expect(offendingCharacters()).toEqual([]);
  });

  test("the damaged-registry warning", async () => {
    // The config subdirectory only exists after a first write, so create it
    // before planting the damaged file.
    mkdirSync(path.dirname(fixtureRegistryPath()), { recursive: true });
    writeFileSync(fixtureRegistryPath(), "{not json", "utf8");
    const project = makeProject("gamma");

    await projectsCommand(["register", project]);

    expect(captured.join("")).toContain("damaged");
    expect(offendingCharacters()).toEqual([]);
  });
});

describe("the JSON projection stays machine-readable", () => {
  test("a hostile name is escaped, not emitted raw", () => {
    const hostile = path.join(workspace, `proj${HOSTILE}ect`);
    mkdirSync(path.join(hostile, ".metaproject"), { recursive: true });
    registerProject(hostile, { dir: configDir });

    const entries = listProjects(configDir);
    expect(entries.length).toBeGreaterThan(0);

    const payload = emitProjectsJson(entries, []);
    expect(() => JSON.parse(payload)).not.toThrow();
    // JSON escapes control characters rather than stripping them, which is the
    // right behaviour here: the consumer gets valid JSON and decides for itself.
    expect(payload).not.toContain(ESC);
  });
});

describe("the guard itself can fail", () => {
  test("controlCharacters detects what it claims to", () => {
    expect(controlCharacters(`a${ESC}b`)).toEqual([ESC]);
    expect(controlCharacters(`a${BEL}b`)).toEqual([BEL]);
    expect(controlCharacters("Project-42_ABC")).toEqual([]);
    expect(controlCharacters("проект-Ω")).toEqual([]);
  });

  test("captured command output is actually inspected", () => {
    console.log(`x${ESC}y`);
    expect(offendingCharacters()).toEqual([ESC]);
  });
});
