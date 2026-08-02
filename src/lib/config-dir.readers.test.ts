// No reader of the shared config directory can be made to abort the process.
//
// A review pointed one of these files at a 3 GiB sparse file and measured
// `keryx serve status` exiting **134** — SIGABRT — with zero bytes on stdout and
// stderr. Bun aborts inside `readFileSync` rather than throwing, so the
// `try/catch` every one of these readers wraps itself in never runs, and four
// module headers promising "never throws" were wrong.
//
// The first fix bounded `serve.json` alone. The other five readers still
// aborted, on the same two commands — the third time on that branch that a fix
// covered the site a finding named instead of the class. So this file drives
// EVERY reader, and it drives each one in a **real subprocess**: an abort kills
// the process, so an in-process assertion cannot observe it. The exit code is
// read from `proc.exited` directly, never through a pipe.
//
// And then the fourth round found that the sweep was a hand-written list of six,
// with two raw reads in `session/store.ts` outside it — the same failure the
// writer side took four rounds to stop making, repeated on the reader side by a
// test that had the writers guard sitting next to it as a worked example. So
// there are now TWO guards in this file and they answer different questions:
//
//   source-level  — does every reader of this directory go through the bounded
//                   helpers? Derived from the tree, so a new reader cannot be
//                   forgotten.
//   behavioural   — does the process actually survive? A source scan cannot
//                   answer that; only a real subprocess can.
//
// Neither subsumes the other. A reader could go through the helper and still
// abort if the helper's bound were wrong, and a reader could survive today and
// be replaced by a raw call tomorrow.
//
// The files are sparse (`ftruncate`), so the whole suite costs no real disk.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { loadsModule, parse } from "./config-dir.ast";
import { sessionDir } from "../session/paths";
import { MAX_CONFIG_FILE_BYTES, MAX_TRANSCRIPT_FILE_BYTES, readConfigFile, readTranscriptFile } from "./config-dir";
import {
  CONFIG_PATH_RESOLVERS,
  code,
  type Exemption,
  type Offence,
  scanFor,
  sourceFiles as scanSourceFiles,
  treeSources as scanTreeSources,
} from "./config-dir.scan";

const SRC = path.join(import.meta.dir, "..");

let base = "";
let configDir = "";

/**
 * Every file in the shared directory, with the module-level entry point that
 * reads it and an expression that must survive an oversized file.
 *
 * This list is BEHAVIOURAL cover, not the guard. An earlier version of this
 * comment called the list "the point" and said that between it and
 * `config-dir.writers.test.ts` — "the source-level guard that fails when a new
 * WRITER appears" — adding a file here without bounding its read took
 * deliberate effort. That was wrong twice over: the writers guard inspects
 * writes and has never looked at a read, and `session/store.ts` read two files
 * under this directory raw from the day the list was written, which took no
 * effort at all. Both are recorded in flow 130.
 *
 * The source-level guard is `describe("every reader …")` at the bottom of this
 * file. It derives the reader set from the tree. This list stays because a
 * source scan proves a call goes through the helper and cannot prove the
 * process survives; only running it in a real subprocess does that.
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

/** A sparse file of `bytes` at `file`, mode 0600, parents created. */
function plantSparse(file: string, bytes: number): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const handle = openSync(file, "w", 0o600);
  try {
    ftruncateSync(handle, bytes);
  } finally {
    closeSync(handle);
  }
}

/** A sparse file of `bytes` at `<configDir>/<name>`, mode 0600. */
function plantOversized(name: string, bytes: number): void {
  plantSparse(path.join(configDir, name), bytes);
}

/**
 * A FIFO at `file`. Returns false where the platform has no `mkfifo`.
 *
 * A FIFO is the shape that made the size bound insufficient: it stats as size
 * 0, so it passes any byte limit, and then the read blocks forever waiting for
 * a writer that never comes.
 */
function plantFifo(file: string): boolean {
  if (process.platform === "win32") {
    return false;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  return Bun.spawnSync(["mkfifo", file]).exitCode === 0;
}

/**
 * Run one reader in its own process. Returns the exit code and its output.
 *
 * `SRC` and `DIR` are substituted as plain substrings, so a probe must not
 * contain either token inside a longer identifier — `KERYX_DATA_DIR` written
 * literally becomes `KERYX_DATA_"/tmp/…"` and the probe fails to parse. Pass
 * environment through `env` instead of writing it into the source.
 */
async function runReader(call: string, env?: Record<string, string>): Promise<{ exit: number; out: string }> {
  const source = call
    .replaceAll("SRC", path.join(import.meta.dir, ".."))
    .replaceAll("DIR", JSON.stringify(configDir));
  const script = path.join(base, "probe.ts");
  await Bun.write(script, `${source}\nconsole.log("survived");\n`);
  const proc = Bun.spawn(["bun", script], {
    stdout: "pipe",
    stderr: "pipe",
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  });
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

describe("the session store, which was outside the list above until flow 130", () => {
  // `session/store.ts` read `summary.json` and `context.jsonl` with a raw
  // `readFileSync` from the day the READERS list was written, and appeared in
  // no entry of it. These two probes are the behavioural half of that finding;
  // the source-level guard at the bottom of this file is the half that stops it
  // recurring.
  //
  // The store resolves its own paths below the shared root, so the probes drive
  // the real entry points with an explicit `dataDir` rather than planting into
  // `configDir` directly.
  const SESSION_ID = "00000000-0000-4000-8000-0000000000aa";

  /** `<dataDir>/sessions/<projectKey>/<sessionId>`, via the real resolver. */
  function sessionFiles(): { project: string; dir: string } {
    const project = path.join(base, "project");
    mkdirSync(path.join(project, ".git"), { recursive: true });
    return { project, dir: sessionDir(project, SESSION_ID, configDir) };
  }

  test("listSessions survives a 3 GiB summary.json", async () => {
    const { project, dir } = sessionFiles();
    plantSparse(path.join(dir, "summary.json"), 3 * 1024 * 1024 * 1024);

    const { exit, out } = await runReader(
      `const { listSessions } = await import("SRC/session/store.ts");
       listSessions(${JSON.stringify(project)}, DIR);`,
    );

    expect({ what: "listSessions", exit }).toEqual({ what: "listSessions", exit: 0 });
    expect(out).toContain("survived");
  }, 60_000);

  test("loadContext refuses a 3 GiB context.jsonl with a stated reason, rather than aborting or reporting no history", async () => {
    const { project, dir } = sessionFiles();
    plantSparse(path.join(dir, "context.jsonl"), 3 * 1024 * 1024 * 1024);

    // The refusal must be VISIBLE. Returning `[]` here would tell the caller
    // this conversation had no messages, about a transcript the process could
    // not open — so the contract is a typed throw and the probe asserts it,
    // not merely that the process lived.
    const { exit, out } = await runReader(
      `const { loadContext, TranscriptUnreadableError } = await import("SRC/session/store.ts");
       try {
         const history = await loadContext(${JSON.stringify(project)}, ${JSON.stringify(SESSION_ID)}, DIR);
         console.log("RETURNED:" + history.length);
       } catch (error) {
         if (error instanceof TranscriptUnreadableError) {
           console.log("REFUSED:" + error.reason);
         } else {
           throw error;
         }
       }`,
    );

    expect({ what: "loadContext", exit }).toEqual({ what: "loadContext", exit: 0 });
    expect(out).toContain("REFUSED:too-large");
    expect(out).not.toContain("RETURNED:0");
  }, 60_000);

  test("a transcript larger than the config bound but within the transcript bound loads intact", async () => {
    // The positive control for the SEPARATE bound. Without it, "the transcript
    // read is bounded" is satisfied by a bound that refuses every real session,
    // which would turn an abort into an unresumable conversation.
    const { project, dir } = sessionFiles();
    const line = JSON.stringify({ role: "user", content: "x".repeat(2_000), ts: "t", kind: "message" });
    const rows = Math.ceil((MAX_CONFIG_FILE_BYTES * 1.5) / (line.length + 1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "context.jsonl"), `${Array.from({ length: rows }, () => line).join("\n")}\n`, "utf8");
    expect(statSync(path.join(dir, "context.jsonl")).size).toBeGreaterThan(MAX_CONFIG_FILE_BYTES);

    const { exit, out } = await runReader(
      `const { loadContext } = await import("SRC/session/store.ts");
       const history = await loadContext(${JSON.stringify(project)}, ${JSON.stringify(SESSION_ID)}, DIR);
       console.log("MESSAGES:" + history.length);`,
    );

    expect({ what: "loadContext", exit }).toEqual({ what: "loadContext", exit: 0 });
    expect(out).toContain(`MESSAGES:${rows}`);
  }, 60_000);

  test("an unreadable ARCHIVE does not abort a resume whose context is readable", async () => {
    // F-014 of the consolidated review. `loadArchive` read `archive.jsonl`
    // before its fallback, so the typed throw added for the silent-empty
    // problem turned into a different silent loss: every caller answers that
    // throw by starting a brand new session, and `archive.jsonl` is the file
    // most likely to reach the bound because it is the one compaction never
    // shortens. The longest conversations became the unresumable ones.
    const { project, dir } = sessionFiles();
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ role: "user", content: "still here", ts: "t", kind: "message" });
    writeFileSync(path.join(dir, "context.jsonl"), `${line}\n${line}\n`, "utf8");
    plantSparse(path.join(dir, "archive.jsonl"), 3 * 1024 * 1024 * 1024);

    const { exit, out } = await runReader(
      `const { loadArchive } = await import("SRC/session/store.ts");
       const reasons = [];
       const messages = loadArchive(${JSON.stringify(project)}, ${JSON.stringify(SESSION_ID)}, DIR, (e) => reasons.push(e.reason));
       console.log("MESSAGES:" + messages.length);
       console.log("DEGRADED:" + reasons.join(","));`,
    );

    expect({ what: "loadArchive", exit }).toEqual({ what: "loadArchive", exit: 0 });
    // The context, not a throw and not an empty list.
    expect(out).toContain("MESSAGES:2");
    // And the caller was TOLD. Falling back silently would make a degraded
    // resume indistinguishable from a session that never had an archive, which
    // is the same lie the typed throw was added to stop.
    expect(out).toContain("DEGRADED:too-large");
  }, 60_000);

  test("openSession resumes such a session and reports the degradation", async () => {
    // The behavioural half at the level a caller actually uses. `loadArchive`
    // returning the context is worth nothing if `openSession` still throws.
    const { project, dir } = sessionFiles();
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ role: "user", content: "still here", ts: "t", kind: "message" });
    writeFileSync(path.join(dir, "context.jsonl"), `${line}\n`, "utf8");
    writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: SESSION_ID,
        projectKey: "k",
        projectPath: project,
        title: "resumable",
        createdAt: "t",
        updatedAt: "t",
        messageCount: 1,
        archiveMessageCount: 1,
        compactCount: 0,
      }),
      "utf8",
    );
    plantSparse(path.join(dir, "archive.jsonl"), 3 * 1024 * 1024 * 1024);

    const { exit, out } = await runReader(
      `const { openSession } = await import("SRC/session/store.ts");
       const opened = openSession({ cwd: ${JSON.stringify(project)}, resumeId: ${JSON.stringify(SESSION_ID)}, dataDir: DIR });
       console.log("RESUMED:" + opened.resumed + ":" + opened.history.length);
       console.log("REPORTED:" + (opened.archiveDegraded ?? "nothing"));`,
    );

    expect({ what: "openSession", exit }).toEqual({ what: "openSession", exit: 0 });
    expect(out).toContain("RESUMED:true:1");
    expect(out).toContain("REPORTED:session transcript");
    expect(out).toContain("too-large");
  }, 60_000);

  test("`keryx sessions export` states the file and the reason instead of a stack trace", async () => {
    // The second of the two unguarded callers. Unguarded, the typed throw
    // reached `main().catch` and printed a stack carrying an absolute
    // home-directory path — for a condition the operator can act on if simply
    // told which file and why.
    const { project, dir } = sessionFiles();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "summary.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: SESSION_ID,
        projectKey: "k",
        projectPath: project,
        title: "unreadable",
        createdAt: "t",
        updatedAt: "t",
        messageCount: 1,
        archiveMessageCount: 1,
        compactCount: 0,
      }),
      "utf8",
    );
    plantSparse(path.join(dir, "context.jsonl"), 3 * 1024 * 1024 * 1024);

    const { exit, out } = await runReader(
      `process.chdir(${JSON.stringify(project)});
       const { sessionsCommand } = await import("SRC/commands/sessions.ts");
       await sessionsCommand(["export", ${JSON.stringify(SESSION_ID)}]);
       console.log("EXITCODE:" + (process.exitCode ?? 0));`,
      { KERYX_DATA_DIR: configDir },
    );

    // Exit 1 through the real process, not merely `process.exitCode` read back
    // in-process — Bun does not reset that between runs and a piped read has
    // produced a false green in this file before.
    expect({ what: "sessions export", exit }).toEqual({ what: "sessions export", exit: 1 });
    expect(out).toContain("EXITCODE:1");
    expect(out).toContain("could not be read (too-large)");
    // A refusal, not a crash: no stack frame, and nothing about this file's
    // real location on the machine that ran it.
    expect(out).not.toContain("at loadContext");
    expect(out).not.toContain("Bun v");
  }, 60_000);

  test("a FIFO in place of a transcript is refused, not blocked on", async () => {
    const { project, dir } = sessionFiles();
    if (!plantFifo(path.join(dir, "context.jsonl"))) {
      return;
    }

    const { exit, out } = await runReader(
      `const { loadContext, TranscriptUnreadableError } = await import("SRC/session/store.ts");
       try {
         await loadContext(${JSON.stringify(project)}, ${JSON.stringify(SESSION_ID)}, DIR);
         console.log("RETURNED");
       } catch (error) {
         if (error instanceof TranscriptUnreadableError) {
           console.log("REFUSED:" + error.reason);
         } else {
           throw error;
         }
       }`,
    );

    expect({ what: "loadContext", exit }).toEqual({ what: "loadContext", exit: 0 });
    expect(out).toContain("REFUSED:not-regular");
  }, 20_000);
});

describe("no reader of the shared config directory can be made to HANG", () => {
  // The size bound alone was not enough. A FIFO stats as size 0, passes the
  // limit, and `readFileSync` then blocks forever — `keryx serve status`
  // produced no output, no refusal and no timeout at all.
  //
  // Every test here carries its own timeout rather than sharing one. A hang
  // must be a RED test: with a single file-level budget, the first hang eats it
  // and the rest report as collateral, which reads as infrastructure noise
  // exactly where it is the finding.
  for (const reader of READERS) {
    test(`${reader.label} refuses a FIFO instead of blocking on it`, async () => {
      if (!plantFifo(path.join(configDir, reader.file))) {
        return; // no mkfifo on this platform; the readers above still cover size
      }

      const { exit, out } = await runReader(reader.call);

      expect({ file: reader.file, exit }).toEqual({ file: reader.file, exit: 0 });
      expect(out).toContain("survived");
    }, 20_000);
  }

  test("the probe harness itself can observe a hang", async () => {
    // Otherwise every assertion above passes because a FIFO never blocked
    // anything in this environment to begin with. Reads the FIFO with the RAW
    // call these readers used to make, under a deadline.
    if (!plantFifo(path.join(configDir, "auth.json"))) {
      return;
    }

    const script = path.join(base, "hang-probe.ts");
    await Bun.write(
      script,
      `import { readFileSync } from "node:fs";\nreadFileSync(${JSON.stringify(path.join(configDir, "auth.json"))}, "utf8");\nconsole.log("returned");\n`,
    );
    const proc = Bun.spawn(["bun", script], { stdout: "ignore", stderr: "ignore" });
    try {
      const settled = await Promise.race([
        proc.exited.then(() => "returned" as const),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5_000)),
      ]);

      // If this ever reports "returned", a FIFO no longer blocks here and the
      // isFile() requirement may not be load-bearing — which is worth knowing.
      expect(settled).toBe("hung");
    } finally {
      // Killed explicitly. A probe that is left blocked on a FIFO outlives the
      // suite, and the `afterEach` rm would then remove the pipe out from under
      // a live process.
      proc.kill();
      await proc.exited;
    }
  }, 20_000);
});

// ── The source-level guard ──────────────────────────────────────────────────
//
// Same construction as `config-dir.writers.test.ts`, over the same scanner, for
// the same reason: derive the denominator from the code, then assert the
// complement is empty. See `config-dir.scan.ts` for what the scan can and
// cannot see — the limits are recorded there rather than assumed here.

/**
 * Raw filesystem calls that read a file's contents.
 *
 * `openSync(` is deliberately NOT here. Both `project-registry.ts` and
 * `serve-credential.ts` open a temp file to WRITE it (openSync + fsync +
 * rename), so including it would have forced a whole-file exemption on the two
 * modules whose reads most need guarding. A genuine read through a descriptor
 * still has to call `readSync`, which IS here — so the read shape is caught
 * without excusing the write shape.
 */
const RAW_READ_CALLS = [
  "readFileSync(",
  "readSync(",
  "createReadStream(",
  "readdirSync(",
  "Bun.file(",
  // The `node:fs/promises` form, matched by CALL name rather than by module
  // specifier — `code()` blanks string literals, so `"node:fs/promises"` is
  // gone before anything is matched. Distinct from `readFileSync(`: the `(`
  // has to follow immediately.
  "readFile(",
] as const;

/**
 * Files excused from the read rule, each with the reason, and each narrowed to
 * the calls it is excused for wherever the file also has calls that are not.
 */
const READ_EXEMPTIONS: ReadonlyArray<Exemption> = [
  {
    file: "lib/config-dir.ts",
    reason:
      "defines the sanctioned bounded readers; it is the one place allowed to call readFileSync directly, and the stat-before-read that makes the bound work lives there",
    calls: ["readFileSync("],
  },
  {
    file: "session/store.ts",
    reason:
      "readdirSync enumerates session directories and reads no file contents, so no bound applies to it; the file reads in this module are NOT excused and go through the bounded helpers",
    calls: ["readdirSync("],
  },
  {
    file: "lib/serve-turn-store.ts",
    reason:
      "listTurnIds' readdirSync enumerates turn directories and reads no file contents, so no bound applies to it; every file read in this module is NOT excused and goes through the bounded helpers",
    calls: ["readdirSync("],
  },
];

/** The seam the mutation test drives. Kept named for the reason in the writers guard. */
function readOffenders(sources: ReadonlyMap<string, string>): Offence[] {
  return scanFor(sources, { calls: RAW_READ_CALLS, exemptions: READ_EXEMPTIONS });
}

describe("every reader of the shared config directory goes through the bounded helpers", () => {
  test("no un-exempt file both resolves a config path and reads raw", () => {
    expect(readOffenders(scanTreeSources(SRC))).toEqual([]);
  });

  test("the scan actually reaches the source tree", () => {
    // Without this the assertion above passes vacuously if the glob root moves.
    const files = scanSourceFiles(SRC);
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("lib/config-dir.ts");
    expect(files).toContain("session/store.ts");
  });

  test("the scan finds files that genuinely resolve a config path", () => {
    // The complement being empty means nothing if the numerator is empty too.
    const resolving = scanSourceFiles(SRC).filter((relative) => {
      const source = code(readFileSync(path.join(SRC, relative), "utf8"));
      return CONFIG_PATH_RESOLVERS.some((resolver) => source.includes(resolver));
    });
    expect(resolving.length).toBeGreaterThanOrEqual(7);
  });

  test("every exemption names a file that exists and states a reason", () => {
    const files = new Set(scanSourceFiles(SRC));
    for (const exemption of READ_EXEMPTIONS) {
      expect({ file: exemption.file, present: files.has(exemption.file) }).toEqual({
        file: exemption.file,
        present: true,
      });
      expect(exemption.reason.trim().length).toBeGreaterThan(20);
    }
  });

  test("the detector reports every reader shape, through readOffenders() itself", () => {
    // Through the seam, not through a re-implementation of the predicate: the
    // writers guard's first self-check re-implemented it inline and stayed green
    // while `offenders()` was replaced with `return []`.
    const shapes: ReadonlyArray<{ label: string; source: string }> = [
      { label: "readFileSync", source: 'const p = serveConfigPath(dir);\nreadFileSync(p, "utf8");' },
      {
        label: "fs/promises readFile",
        source: 'import { readFile } from "node:fs/promises";\nawait readFile(shellConfigPath(dir), "utf8");',
      },
      { label: "Bun.file", source: "await Bun.file(projectRegistryPath(dir)).text();" },
      { label: "createReadStream", source: "createReadStream(sandboxConfigPath(dir)).read();" },
      {
        label: "openSync + readSync",
        source: 'const h = openSync(serveCredentialPath(dir), "r");\nreadSync(h, buf, 0, 10, 0);',
      },
      {
        label: "readdirSync then a per-entry read",
        source: "for (const e of readdirSync(projectSessionsDir(p))) readFileSync(e);",
      },
      {
        label: "a read inside a subdirectory, with the root resolved correctly",
        source: 'readFileSync(path.join(keryxConfigDir(dir), "cache", "x.json"), "utf8");',
      },
      {
        label: "a raw call with a trailing comment naming the resolver",
        source: 'const p = shellPermissionsPath(dir);\nreadFileSync(p); // not through readConfigFile',
      },
      {
        label: "a glob in a string literal, which used to swallow the read",
        source: 'const g = "**/*.json";\nreadFileSync(sandboxConfigPath(dir), "utf8");',
      },
      {
        label: "the session-store shape this guard was built for",
        source: "const f = path.join(sessionDir(p, id), 'context.jsonl');\nreadFileSync(f, 'utf8');",
      },
    ];

    const missed = shapes
      .filter((shape) => readOffenders(new Map([[`probe/${shape.label}.ts`, shape.source]])).length === 0)
      .map((shape) => shape.label);

    expect(missed).toEqual([]);
  });

  test("the detector does NOT report a file that goes through the helpers", () => {
    // The other half. Without it the assertion above is satisfied by a detector
    // that reports everything, which would be just as useless.
    const clean = new Map([
      ["probe/clean.ts", "const r = readConfigFile(serveConfigPath(dir));"],
      ["probe/transcript.ts", "const r = readTranscriptFile(sessionDir(p, id));"],
      ["probe/unrelated.ts", 'readFileSync("/tmp/somewhere-else.txt", "utf8");'],
    ]);
    expect(readOffenders(clean)).toEqual([]);
  });

  /**
   * Files importing `config-dir.scan`.
   *
   * NOT through `code()`, and that is the interesting part. The shared stripper
   * blanks string literals before anything is matched, so `from
   * "./config-dir.scan"` is `from ""` by the time it sees it — an import
   * specifier IS a string literal, so the one helper every other guard here uses
   * is the one thing that cannot see an import. Comments are stripped locally
   * instead, which is all this predicate needs: a module path cannot be spelled
   * without the string.
   */
  function scannerImporters(sources: ReadonlyMap<string, string>): string[] {
    // Through the AST, after three rounds of losing to spellings.
    //
    // This predicate was a regex. It knew `from "…"`; a round added
    // `require("…")` and dynamic `import("…")`; and then a reviewer defeated the
    // widened version with a FILE EXTENSION — `from "./config-dir.scan.ts"` —
    // by planting a real production module that imported the scanner and
    // watching the whole suite stay green. `.ts` is not exotic here: this very
    // file writes `await import("…/shell-config.ts")` in four places. The guard
    // could not see its own idiom.
    //
    // `loadsModule` asks the parser instead. An import specifier is a specifier
    // whatever punctuation surrounds it, and the basename comparison ignores the
    // extension, so the class is closed by construction rather than enumerated.
    // See `config-dir.ast.ts` for what that does and does not buy — no module
    // resolution, so an alias through an intermediate re-export is still
    // invisible, and that limit is stated there rather than left to be found.
    return [...sources]
      .filter(([file, raw]) => loadsModule(parse(file, raw), "config-dir.scan"))
      .map(([file]) => file);
  }

  test("the importer predicate sees every loading position and spelling", () => {
    // The self-check, planting what the PREVIOUS version could not see rather
    // than what the current one already matches. That inversion is the recorded
    // lesson, and all four guards rewritten last round violated it — each
    // planted only the shapes its new regex had just learned.
    const planted = new Map([
      ["probe/static.ts", 'import { code } from "./config-dir.scan";'],
      ["probe/re-export.ts", 'export { code } from "../lib/config-dir.scan";'],
      ["probe/require.ts", 'const { code } = require("./config-dir.scan");'],
      ["probe/dynamic.ts", 'const m = await import("./config-dir.scan");'],
      // The four that defeated the regex.
      ["probe/extension.ts", 'import { code } from "./config-dir.scan.ts";'],
      ["probe/js-extension.ts", 'const m = require("./config-dir.scan.js");'],
      ["probe/side-effect.ts", 'import "./config-dir.scan";'],
      ["probe/template.ts", "const m = await import(`../lib/config-dir.scan`);"],
      // Neither of these loads it.
      ["probe/comment.ts", "// see ./config-dir.scan for what the scan can do"],
      ["probe/unrelated.ts", 'import { readConfigFile } from "./config-dir";'],
    ]);
    expect(scannerImporters(planted).sort()).toEqual([
      "probe/dynamic.ts",
      "probe/extension.ts",
      "probe/js-extension.ts",
      "probe/re-export.ts",
      "probe/require.ts",
      "probe/side-effect.ts",
      "probe/static.ts",
      "probe/template.ts",
    ]);
  });

  test("only test files import the scanner this guard is built on", () => {
    // `config-dir.scan.ts` is test-support code in the production source tree.
    // Its own header argues, correctly, that it must NOT be a `.test.` file:
    // `sourceFiles()` filters those out, and a scanner that cannot see itself
    // has a blind spot by construction. That argument is sound and the file
    // stays where it is.
    //
    // What was missing is the pin. It is an ordinary export from `src/lib/`, so
    // nothing stopped a production module importing it, and it ships in whatever
    // the build emits from that directory. This round took it from three
    // importers to five and across a package boundary for the first time —
    // `harness/policy/profiles.test.ts` is the first `src/harness` -> `src/lib`
    // edge that takes test scaffolding rather than a runtime utility, into the
    // most protected module in the tree.
    //
    // Its header says it must not be exempt from the rules it implements. This
    // is the rule it was one short of.
    expect(scannerImporters(scanTreeSources(SRC))).toEqual([]);
  });

  test("the importer scan sees the test files that DO import it", () => {
    // The numerator. `treeSources` filters `.test.` files out, so the assertion
    // above is over production files only — and would pass just as well if the
    // predicate matched nothing at all. This drives the same predicate over the
    // whole tree including tests, and names what it finds.
    const everything = new Map(
      [...new Glob("**/*.ts").scanSync(SRC)]
        .map((relative) => relative.split(path.sep).join("/"))
        .map((relative) => [relative, readFileSync(path.join(SRC, relative), "utf8")] as const),
    );
    const importers = scannerImporters(everything).sort();

    expect(importers).toEqual([
      "harness/policy/profiles.test.ts",
      "lib/config-dir.readers.test.ts",
      "lib/config-dir.writers.test.ts",
      "lib/serve-server.test.ts",
      "session/store.callers.test.ts",
    ]);
    // Every one a test file, which is the property the guard above asserts the
    // complement of.
    for (const importer of importers) {
      expect({ importer, isTest: importer.includes(".test.") }).toEqual({ importer, isTest: true });
    }
  });

  test("a per-call exemption excuses only that call, not the file", () => {
    // The whole reason `Exemption.calls` exists. `session/store.ts` is excused
    // for `readdirSync` and must still be reported for a raw file read — if a
    // file-level exemption were used instead, the finding this guard was built
    // for would be excused by the guard.
    const both = new Map([["session/store.ts", "readdirSync(projectSessionsDir(p));\nreadFileSync(f, 'utf8');"]]);
    expect(readOffenders(both)).toEqual([{ file: "session/store.ts", raw: "readFileSync(" }]);
  });
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

  test("a non-regular file is `not-regular`, distinct from every other failure", () => {
    // Distinct rather than folded into `unreadable`, so a caller — and an
    // operator reading a message — can tell "there is no configuration" from
    // "something that is not a file is sitting where the configuration goes".
    if (!plantFifo(path.join(configDir, "serve.json"))) {
      return;
    }
    const result = readConfigFile(path.join(configDir, "serve.json"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("not-regular");
  });

  test("a directory in place of a config file is refused, not read", () => {
    // The same class as the FIFO, reached without mkfifo — so this half holds
    // on a platform where the FIFO tests skip.
    mkdirSync(path.join(configDir, "serve.json"), { recursive: true });
    const result = readConfigFile(path.join(configDir, "serve.json"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("not-regular");
  });

  test("the transcript bound is larger than the config bound and enforced on its own terms", () => {
    // Both halves. A transcript between the two bounds must READ — that is the
    // whole reason the second constant exists — and one beyond the transcript
    // bound must still be refused.
    expect(MAX_TRANSCRIPT_FILE_BYTES).toBeGreaterThan(MAX_CONFIG_FILE_BYTES);

    plantOversized("context.jsonl", MAX_CONFIG_FILE_BYTES + 1);
    const file = path.join(configDir, "context.jsonl");
    expect(readConfigFile(file).ok).toBe(false);
    expect(readTranscriptFile(file).ok).toBe(true);

    plantOversized("context.jsonl", MAX_TRANSCRIPT_FILE_BYTES + 1);
    const refused = readTranscriptFile(file);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toBe("too-large");
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
