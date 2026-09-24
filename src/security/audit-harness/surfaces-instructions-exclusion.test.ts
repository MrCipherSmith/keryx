// Flow 313 (W4 portability) T15 — surfaces.ts NON_JSON_HOOK_SURFACE_PATHS
// exclusion now includes SUBSYSTEM_INSTRUCTIONS, so instruction-only projects
// do not wrongly report the hooks surface as "scanned" when they contain only
// instruction files like GEMINI.md, .kiro/steering/keryx.md, and
// .github/copilot-instructions.md.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { discoverHookSurfaceFiles, discoverInstructions } from "./surfaces";
import { runHarnessAudit } from "./index";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "keryx-surfaces-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

test("surfaces with only SUBSYSTEM_INSTRUCTIONS files do not report as hook artifacts", async () => {
  // Create the instruction files that gemini-cli, kiro, and github-copilot-agent surfaces write
  await writeFile(path.join(tmp, "GEMINI.md"), "# Gemini Instructions\n");

  const kiroDir = path.join(tmp, ".kiro", "steering");
  await mkdir(kiroDir, { recursive: true });
  await writeFile(path.join(kiroDir, "keryx.md"), "# Kiro Instructions\n");

  const githubDir = path.join(tmp, ".github");
  await mkdir(githubDir, { recursive: true });
  await writeFile(path.join(githubDir, "copilot-instructions.md"), "# GitHub Copilot Instructions\n");

  // Verify discoverHookSurfaceFiles does not list these instruction files
  const hookFiles = await discoverHookSurfaceFiles(tmp);
  expect(hookFiles).not.toContain("GEMINI.md");
  expect(hookFiles).not.toContain(".kiro/steering/keryx.md");
  expect(hookFiles).not.toContain(".github/copilot-instructions.md");

  // Verify discoverInstructions finds them as instruction files
  const instructionFiles = await discoverInstructions(tmp);
  expect(instructionFiles).toContain("GEMINI.md");
  expect(instructionFiles).toContain(".kiro/steering/keryx.md");
  expect(instructionFiles).toContain(".github/copilot-instructions.md");

  // Verify runHarnessAudit reports hooks as not-applicable and instructions as scanned
  const report = await runHarnessAudit(tmp);

  const hooksSurface = report.surfaces.find((s) => s.surface === "hooks");
  expect(hooksSurface).toBeDefined();
  expect(hooksSurface?.status).toBe("not-applicable");

  const instructionsSurface = report.surfaces.find((s) => s.surface === "instructions");
  expect(instructionsSurface).toBeDefined();
  expect(instructionsSurface?.status).toBe("scanned");
  expect(instructionsSurface?.pathsScanned).toEqual([
    ".github/copilot-instructions.md",
    ".kiro/steering/keryx.md",
    "GEMINI.md",
  ]);
});
