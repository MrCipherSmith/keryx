// No reader of the shared config directory can be made to abort the process.
//
// A review pointed one of these files at a 3 GiB sparse file and measured
// `keryx serve status` exiting **134** — SIGABRT — with zero bytes on stdout and
// stderr. Bun aborts inside `readFileSync` rather than throwing, so the
// `try/catch` every one of these readers wraps itself in never runs, and four
// module headers promising "never throws" were wrong.
//
// The first fix bounded `serve.json` alone. The other five readers still
// aborted, on the same two commands — the third time on this branch that a fix
// covered the site a finding named instead of the class. So this file drives
// EVERY reader, and it drives each one in a **real subprocess**: an abort kills
// the process, so an in-process assertion cannot observe it. The exit code is
// read from `proc.exited` directly, never through a pipe.
//
// The files are sparse (`ftruncate`), so the whole suite costs no real disk.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_CONFIG_FILE_BYTES, readConfigFile } from "./config-dir";

let base = "";
let configDir = "";

/**
 * Every file in the shared directory, with the module-level entry point that
 * reads it and an expression that must survive an oversized file.
 *
 * The list is the point. A new file in this directory with a new reader must be
 * added here, and `config-dir.writers.test.ts` is the source-level guard that
 * fails when a new WRITER appears — between them, adding a file to this
 * directory without bounding its read takes deliberate effort.
 */
const READERS: ReadonlyArray<{ file: string; label: string; call: string }> = [
  {
    file: "auth.json",
    label: "loadShellConfig",
    call: `const { loadShellConfig } = await import("SRC/lib/shell-config.ts");
           loadShellConfig(DIR);`,
  },
  {
    file: "projects.json",
    label: "loadProjectRegistry",
    call: `const { loadProjectRegistry } = await import("SRC/lib/project-registry.ts");
           loadProjectRegistry(DIR, () => {});`,
  },
  {
    file: "permissions.json",
    label: "loadShellPermissions",
    call: `const m = await import("SRC/lib/shell-permissions.ts");
           m.loadShellPermissions(DIR);
           m.shellPermissionsFingerprint(DIR);`,
  },
  {
    file: "sandbox.json",
    label: "loadSandboxDefaults",
    call: `const { loadSandboxDefaults } = await import("SRC/lib/sandbox-config.ts");
           loadSandboxDefaults(DIR);`,
  },
  {
    file: "serve.json",
    label: "loadServeConfig / serveConfigState",
    call: `const m = await import("SRC/lib/serve-config.ts");
           m.loadServeConfig(DIR, () => {});
           m.serveConfigState(DIR);`,
  },
  {
    file: "serve-credentials.json",
    label: "readServeCredential",
    call: `const m = await import("SRC/lib/serve-credential.ts");
           m.readServeCredential(DIR);
           m.loadServeCredential(DIR);`,
  },
];

/** A sparse file of `bytes` at `<configDir>/<name>`, mode 0600. */
function plantOversized(name: string, bytes: number): void {
  mkdirSync(configDir, { recursive: true });
  const file = path.join(configDir, name);
  const handle = openSync(file, "w", 0o600);
  try {
    ftruncateSync(handle, bytes);
  } finally {
    closeSync(handle);
  }
}

/** Run one reader in its own process. Returns the exit code and its output. */
async function runReader(call: string): Promise<{ exit: number; out: string }> {
  const source = call
    .replaceAll("SRC", path.join(import.meta.dir, ".."))
    .replaceAll("DIR", JSON.stringify(configDir));
  const script = path.join(base, "probe.ts");
  await Bun.write(script, `${source}\nconsole.log("survived");\n`);
  const proc = Bun.spawn(["bun", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  // Read from the process, never through a pipe: `process.exitCode = undefined`
  // does not reset in Bun and a piped read has produced a false green here.
  const exit = await proc.exited;
  return { exit, out: `${out}${err}` };
}

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "keryx-readers-"));
  configDir = path.join(base, "keryx");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("every reader of the shared config directory survives an oversized file", () => {
  for (const reader of READERS) {
    test(`${reader.label} (${reader.file})`, async () => {
      plantOversized(reader.file, 3 * 1024 * 1024 * 1024);

      const { exit, out } = await runReader(reader.call);

      // 134 is SIGABRT — the exact symptom the review measured. Asserting the
      // code AND the marker: an exit 0 that printed nothing would mean the
      // probe never ran.
      expect({ file: reader.file, exit }).toEqual({ file: reader.file, exit: 0 });
      expect(out).toContain("survived");
    }, 60_000);
  }

  test("the probe harness itself can observe an abort", async () => {
    // Otherwise every assertion above passes because nothing was ever executed.
    // Reads the oversized file with the RAW call these readers used to make.
    plantOversized("auth.json", 3 * 1024 * 1024 * 1024);

    const { exit } = await runReader(
      `const { readFileSync } = await import("node:fs");
       const path = await import("node:path");
       readFileSync(path.join(DIR, "auth.json"), "utf8");`,
    );

    // The raw read aborts. If this ever starts exiting 0, Bun has changed and
    // the bound may no longer be load-bearing — which is worth knowing.
    expect(exit).not.toBe(0);
  }, 60_000);
});

describe("readConfigFile", () => {
  test("reads a file at exactly the limit and refuses one byte more", () => {
    plantOversized("serve.json", MAX_CONFIG_FILE_BYTES);
    expect(readConfigFile(path.join(configDir, "serve.json")).ok).toBe(true);

    plantOversized("serve.json", MAX_CONFIG_FILE_BYTES + 1);
    const refused = readConfigFile(path.join(configDir, "serve.json"));
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe("too-large");
  });

  test("an absent file is `absent`, not `unreadable` — callers branch on the difference", () => {
    const result = readConfigFile(path.join(configDir, "nothing-here.json"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("absent");
  });

  test("an ordinary configuration is read unchanged", () => {
    mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, "small.json");
    // `writeFileSync`, not an unawaited `Bun.write`: the read below is
    // synchronous, so an async write is a race that would surface as a flake.
    writeFileSync(file, '{"hello":"world"}', "utf8");
    const result = readConfigFile(file);
    expect(result.ok).toBe(true);
    expect(result.ok === true && JSON.parse(result.text)).toEqual({ hello: "world" });
  });
});
