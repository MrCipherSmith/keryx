// `keryx shell --unattended` through the real entrypoint (flow 137, AC6 / AC11).
//
// The rest of the posture's evidence drives `runAgentTurn` directly, which is the
// right level for the corpus. This file exists because two of the guarantees are
// about the SHELL and not the driver — what the header says, and what lands in
// the run record — and both live in `runAgentRepl`, which the shell's own tests
// have always treated as untested TTY wiring.
//
// It found a real defect. `save()` runs after a turn completes, so a run that
// answered nothing left a session directory with no posture on it at all: the
// stamp was present exactly when the run had gone well, which is not evidence.
// A `bun test` over the modules would not have seen it; spawning the binary did.
//
// Offline by construction: the `fake` provider opens no socket, the fixture is a
// temp directory, and `KERYX_DATA_DIR` keeps sessions out of the real one.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

const CLI = path.join(import.meta.dir, "..", "cli.ts");

interface ShellRun {
  stdout: string;
  summary: Record<string, unknown> | undefined;
}

/** Run `keryx shell` in a throwaway project, feeding it `input`, and read back the record. */
async function runShellCli(args: string[], input: string): Promise<ShellRun> {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-posture-cli-"));
  const project = path.join(base, "proj");
  const data = path.join(base, "data");
  mkdirSync(project, { recursive: true });
  // A tiny project, so orientation has nothing expensive to do.
  writeFileSync(path.join(project, "package.json"), '{"name":"cli-fixture"}\n', "utf8");
  try {
    const proc = Bun.spawn(["bun", CLI, "shell", ...args], {
      cwd: project,
      env: { ...process.env, KERYX_DATA_DIR: data, NO_COLOR: "1" },
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return { stdout, summary: readOnlySummary(data) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** The single session summary the run wrote, if it wrote one. */
function readOnlySummary(dataDir: string): Record<string, unknown> | undefined {
  const root = path.join(dataDir, "sessions");
  for (const project of safeList(root)) {
    for (const session of safeList(path.join(root, project))) {
      const file = path.join(root, project, session, "summary.json");
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        // not a session directory
      }
    }
  }
  return undefined;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

test("AC11: an unattended run announces its posture and stamps it into the record", async () => {
  const run = await runShellCli(["--unattended", "--provider", "fake", "--model", "fake-echo"], "/help\n/exit\n");

  // The header carries it, between the mode and the directory.
  expect(run.stdout).toContain("· agent · unattended:read-only ·");

  // The advertised surface is the read-only one. These three are the whole
  // mutating capability of the shell, and the model is not told about any of them.
  for (const excluded of ["shell_exec", "ask_user", "spawn_subagent"]) {
    expect(run.stdout, `${excluded} was advertised under the posture`).not.toContain(excluded);
  }
  expect(run.stdout).toContain("read_file");
  expect(run.stdout).toContain("search_code");

  // The record says so too — on a run that took no turn at all, which is the
  // case that used to write nothing.
  expect(run.summary?.posture).toBe("unattended:read-only");
  expect(run.summary?.humanInterventions).toBe(0);
}, 180_000);

test("AC6: the unflagged default is unchanged — same header, same tools, no stamp", async () => {
  const run = await runShellCli(["--no-tui", "--provider", "fake", "--model", "fake-echo"], "/help\n/exit\n");

  // No posture segment anywhere in the output.
  expect(run.stdout).toContain("fake/fake-echo · agent ·");
  expect(run.stdout).not.toContain("unattended:");

  // Still the full surface, including the default-deny shell.
  for (const advertised of ["shell_exec", "ask_user", "spawn_subagent", "read_file"]) {
    expect(run.stdout, `${advertised} disappeared from the supervised default`).toContain(advertised);
  }

  // And the record gains neither field.
  expect(run.summary).toBeDefined();
  expect("posture" in (run.summary ?? {})).toBe(false);
  expect("humanInterventions" in (run.summary ?? {})).toBe(false);
}, 180_000);

test("the launch refusals happen before anything starts, and exit non-zero", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-posture-refuse-"));
  const project = path.join(base, "proj");
  mkdirSync(project, { recursive: true });
  try {
    const attempt = async (args: string[]): Promise<{ code: number; err: string; wroteSession: boolean }> => {
      const data = path.join(base, `data-${args.join("_").replace(/\W+/g, "")}`);
      const proc = Bun.spawn(["bun", CLI, "shell", ...args], {
        cwd: project,
        env: { ...process.env, KERYX_DATA_DIR: data, NO_COLOR: "1" },
        stdin: new TextEncoder().encode(""),
        stdout: "pipe",
        stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      return { code, err, wroteSession: safeList(path.join(data, "sessions")).length > 0 };
    };

    const unknownProfile = await attempt(["--unattended=full", "--provider", "fake", "--model", "f"]);
    expect(unknownProfile.code).toBe(2);
    expect(unknownProfile.err).toContain('unknown unattended profile "full"');
    expect(unknownProfile.wroteSession, "a refused launch still opened a session").toBe(false);

    const withChat = await attempt(["--unattended", "--chat", "--provider", "fake", "--model", "f"]);
    expect(withChat.code).toBe(2);
    expect(withChat.err).toContain("cannot be combined with --chat");
    expect(withChat.wroteSession).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 180_000);
