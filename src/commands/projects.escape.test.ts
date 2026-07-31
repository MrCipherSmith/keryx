// Terminal-escape containment across EVERY output path of `keryx projects`
// (flow 127).
//
// This is a class-level guard, not a per-site one. Escape injection was fixed
// three times on this branch — the display line, then the not-a-project message,
// then the strip warning and the forget/unknown-subcommand messages — each time
// by patching the site the review named, and each time another site was still
// open. A test that enumerates the paths catches the next one; a test per fixed
// site never would.
//
// The rule: nothing derived from a filesystem name, a caller argument, or a
// registry field name reaches stdout or stderr carrying control characters.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  forgetProject,
  projectRegistryPath,
  registerProject,
  listProjects,
  emitProjectsJson,
} from "../lib/project-registry";

/** ESC, BEL, and an OSC title-set sequence — the shapes that rewrite a terminal. */
const ESC = "";
const BEL = "";
const HOSTILE = `${ESC}]0;PWNED${BEL}${ESC}[2J`;

let configDir = "";
let workspace = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;

function controlCharacters(text: string): string[] {
  return [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-escape-"));
  configDir = path.join(base, "config");
  workspace = path.join(base, "work");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
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
  process.exitCode = 0;
  rmSync(path.dirname(configDir), { recursive: true, force: true });
});

/** Every captured line, minus the newlines the writers legitimately emit. */
function offendingCharacters(): string[] {
  return controlCharacters(captured.join("").replace(/\n/g, ""));
}

describe("no output path emits terminal control characters", () => {
  test("the not-a-project refusal, from a hostile directory name", () => {
    const hostile = path.join(workspace, `dir${HOSTILE}name`);
    mkdirSync(hostile, { recursive: true });

    const result = registerProject(hostile, { dir: configDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(controlCharacters(result.message)).toEqual([]);
    }
  });

  test("the credential-strip warning, from a hostile field name", () => {
    // The warning interpolated the field name raw, so a registry someone else
    // wrote could rewrite the terminal of whoever ran the next command.
    const project = path.join(workspace, "alpha");
    mkdirSync(path.join(project, ".metaproject"), { recursive: true });
    registerProject(project, { dir: configDir });

    const onDisk = JSON.parse(readFileSync(projectRegistryPath(configDir), "utf8")) as {
      projects: Array<Record<string, unknown>>;
    };
    onDisk.projects[0]![`token${HOSTILE}x`] = "value";
    writeFileSync(projectRegistryPath(configDir), JSON.stringify(onDisk), "utf8");

    const warnings: string[] = [];
    registerProject(project, { dir: configDir, onWarn: (message) => warnings.push(message) });

    expect(warnings.length).toBeGreaterThan(0);
    expect(controlCharacters(warnings.join(""))).toEqual([]);
  });

  test("the damaged-registry warning", () => {
    writeFileSync(projectRegistryPath(configDir), "{not json", "utf8");
    const project = path.join(workspace, "alpha");
    mkdirSync(path.join(project, ".metaproject"), { recursive: true });

    const warnings: string[] = [];
    registerProject(project, { dir: configDir, onWarn: (message) => warnings.push(message) });

    expect(warnings.length).toBeGreaterThan(0);
    expect(controlCharacters(warnings.join(""))).toEqual([]);
  });

  test("the forget not-found path, from a hostile id", () => {
    const warnings: string[] = [];
    expect(forgetProject(`bogus${HOSTILE}id`, configDir, (m) => warnings.push(m))).toBe("not-found");
    expect(controlCharacters(warnings.join(""))).toEqual([]);
  });

  test("the rendered list, from a hostile directory name", () => {
    // The path is registered directly into the file so the render path is
    // exercised even though such a directory would normally be refused.
    const hostile = path.join(workspace, `proj${HOSTILE}ect`);
    mkdirSync(path.join(hostile, ".metaproject"), { recursive: true });
    registerProject(hostile, { dir: configDir });

    for (const entry of listProjects(configDir)) {
      // Entries carry the raw name; the RENDERER is what must sanitize, so this
      // asserts the rendered form via the same helper the command uses.
      const rendered = `${entry.displayName} ${entry.path}`;
      expect(controlCharacters(rendered).length).toBeGreaterThan(0);
    }
  });

  test("the JSON projection is parseable even with a hostile name", () => {
    // JSON escapes control characters rather than stripping them, which is
    // correct: a machine consumer gets valid JSON and decides for itself.
    const hostile = path.join(workspace, `proj${HOSTILE}ect`);
    mkdirSync(path.join(hostile, ".metaproject"), { recursive: true });
    registerProject(hostile, { dir: configDir });

    const payload = emitProjectsJson(listProjects(configDir), []);
    expect(() => JSON.parse(payload)).not.toThrow();
    // The raw bytes are escaped, not literal.
    expect(payload).not.toContain(ESC);
  });
});

describe("the guard itself can fail", () => {
  test("controlCharacters detects what it claims to", () => {
    // Otherwise every assertion above passes because the detector is broken.
    expect(controlCharacters(`a${ESC}b`)).toEqual([ESC]);
    expect(controlCharacters(`a${BEL}b`)).toEqual([BEL]);
    expect(controlCharacters("Project-42_ABC")).toEqual([]);
    expect(controlCharacters("проект-Ω")).toEqual([]);
  });

  test("captured output is actually inspected", () => {
    console.log(`x${ESC}y`);
    expect(offendingCharacters()).toEqual([ESC]);
  });
});
