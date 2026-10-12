// Test support for the flow-origin tests (flow 390): a temp project root, a flow
// service with fake dependencies, and a `flowCommand` runner that captures the
// console and the exit code, so each test reads as one scenario.

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import type { FlowService, FlowServiceDeps, FlowState } from "./types";

export function originDeps(): FlowServiceDeps {
  return {
    tracker: null,
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-10-02T10:00:00Z"),
  };
}

export interface OriginRoot {
  root: string;
  service: FlowService;
  cleanup(): Promise<void>;
}

/** A temp project root with a `.metaproject` directory and a flow service over it. */
export async function originRoot(): Promise<OriginRoot> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-origin-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return {
    root,
    service: createFlowService(originDeps()),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function readRawFlow(root: string, dir: string): Promise<FlowState> {
  return JSON.parse(await readFile(path.join(root, dir, "flow.json"), "utf8")) as FlowState;
}

export async function readJournal(root: string, dir: string): Promise<string> {
  return readFile(path.join(root, dir, "journal.md"), "utf8");
}

export async function flowDirNames(root: string): Promise<string[]> {
  try {
    return await readdir(path.join(root, ".metaproject", "flows"));
  } catch {
    return [];
  }
}

export interface CliRun {
  out: string;
  err: string;
  exitCode: number;
}

/**
 * Run `keryx flow ...` in `root`, capturing stdout, stderr and the exit code. The
 * command is passed in by the test: this helper is not a test file, so it must
 * not import the command layer itself.
 */
export async function runFlowCli(flowCommand: (args: string[]) => Promise<void>, root: string, args: string[]): Promise<CliRun> {
  const originalCwd = process.cwd();
  const realLog = console.log;
  const realError = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  };
  try {
    process.chdir(root);
    process.exitCode = 0;
    await flowCommand(args);
    return { out: out.join("\n"), err: err.join("\n"), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
}

/** Remove ANSI colour codes, so an assertion reads the text a person sees. */
export function plain(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}
