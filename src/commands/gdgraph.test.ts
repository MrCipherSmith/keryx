// AFC-10 (flow 234, phase 2, frozen AC3): "an unknown target differs from
// indexed/no edges." `gdgraph/service.ts`'s `createGdgraphService().affected()`
// already distinguishes a target the graph never indexed from an indexed
// target that legitimately has zero edges (throws `UnknownGraphTargetError`
// for the former). But `keryx gdgraph affected` — the command line surface —
// calls `computeAffected()` directly (`runAffected` in `./gdgraph.ts`),
// bypassing that facade entirely, so it still answered an unknown target with
// the same byte-identical empty result as a real, edge-less node. These tests
// exercise the command function directly (mirrors `modules.test.ts`'s
// `modulesCommand` pattern: chdir into a fixture, capture console output,
// reset `process.exitCode`).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gdgraphCommand } from "./gdgraph";
import { recordProvenance } from "../sync/provenance";

describe("keryx gdgraph affected — unknown target vs. indexed-with-no-edges", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-affected-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    // A single indexed file node with no edges at all — a legitimate,
    // edge-less target. `src/does-not-exist.ts` is never written to
    // nodes.jsonl, so the graph never indexed it.
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
      "utf8",
    );

    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    // `modulesCommand`'s test file notes: assigning `undefined` does not clear
    // `process.exitCode` in Bun, so a green suite can still report failure.
    // Commands here set the real `process.exitCode`; reset it explicitly.
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("an indexed target with no edges reports an empty-but-valid blast radius, exit 0", async () => {
    await gdgraphCommand(["affected", "src/a.ts", "--json"]);

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(loggedOut.join("\n")) as { target: string; dependencies: string[]; dependents: string[] };
    expect(payload.target).toBe("src/a.ts");
    expect(payload.dependencies).toEqual([]);
    expect(payload.dependents).toEqual([]);
  });

  test("an unknown target is not silently reported as an empty result", async () => {
    await gdgraphCommand(["affected", "src/does-not-exist.ts", "--json"]);

    // The defect: before the fix this printed the same shape as the
    // known-empty case above (`{target: "src/does-not-exist.ts", dependencies:
    // [], dependents: [], ranked: []}`) and exited 0 — a failure rendered as a
    // legitimate, if boring, answer, with NO field marking it as an error.
    // T19 finding 6 (below) deliberately keeps the `dependencies`/`dependents`
    // field names on the error object too (matching `commands/modules.ts`'s
    // own convention of echoing the success shape, empty, alongside an added
    // `error` field) — so the defect signature to guard against is
    // specifically "looks like the success shape AND carries no `error`
    // marker", not merely "has array fields with these names".
    const printedEmptyResultJsonWithNoErrorMarker =
      loggedOut.length === 1 &&
      (() => {
        try {
          const parsed = JSON.parse(loggedOut[0]!) as { dependencies?: unknown; dependents?: unknown; error?: unknown };
          return Array.isArray(parsed.dependencies) && Array.isArray(parsed.dependents) && parsed.error === undefined;
        } catch {
          return false;
        }
      })();
    expect(printedEmptyResultJsonWithNoErrorMarker).toBe(false);

    // An unknown target is a caller error (typo, wrong path, or the file is
    // new and the graph has not been rebuilt), not an empty-but-valid answer —
    // it must exit non-zero, matching this file's own convention for a bad
    // argument (e.g. the missing-argument and unknown-subcommand paths in
    // `gdgraph.ts` both set `process.exitCode = 1`).
    expect(process.exitCode).toBe(1);
  });

  // T19 finding 6 (flow 234 review, MINOR): a caller that asked for `--json`
  // got EMPTY stdout and prose on stderr for this exact error — a JSON
  // consumer parsing stdout saw nothing at all, not even a machine-readable
  // failure. Fixed to match `commands/modules.ts`'s own convention (see
  // `modulesCommand`'s "not-initialized" branch): a structured error object
  // on stdout under `--json`, prose on stderr otherwise — never both.
  test("T19 finding 6 — under --json, the unknown-target error is a structured object on stdout, not stderr prose", async () => {
    await gdgraphCommand(["affected", "src/does-not-exist.ts", "--json"]);

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(loggedOut.join("\n")) as {
      schemaVersion: number;
      error: string;
      target: string;
      dependencies: string[];
      dependents: string[];
    };
    expect(payload.schemaVersion).toBe(1);
    expect(typeof payload.error).toBe("string");
    expect(payload.error.length).toBeGreaterThan(0);
    expect(payload.target).toBe("src/does-not-exist.ts");
    expect(payload.dependencies).toEqual([]);
    expect(payload.dependents).toEqual([]);
    // Matches `modulesCommand`'s either/or convention: JSON mode gets JSON,
    // never JSON-on-stdout-plus-prose-on-stderr for the same failure.
    expect(loggedErr.join("\n")).toBe("");
  });

  test("an unknown target is reported distinctly in the default (non-JSON) renderer too", async () => {
    await gdgraphCommand(["affected", "src/does-not-exist.ts"]);

    expect(process.exitCode).toBe(1);
    // Must not fall through to the normal "## Dependencies / ## Dependents"
    // renderer, which would print the same "- none" shape as a real, indexed,
    // edge-less target.
    expect(loggedOut.join("\n")).not.toContain("## Dependents");
    // Non-JSON mode is unchanged by finding 6 — the message still goes to
    // stderr, matching this file's other bad-argument paths.
    expect(loggedErr.join("\n")).toContain("does-not-exist.ts");
  });
});

// ---------------------------------------------------------------------------
// T19 finding 4 (flow 234 review, MAJOR) — AC5 requires that an EXPLICIT
// demand for symbol-level capability (`keryx gdgraph symbol "<name>"`) produce
// a typed, actionable error when the symbol layer is unavailable. The typed
// error and its requirement helper (`requireSymbols`/`SymbolsUnavailableError`
// in `src/gdgraph/symbols-capability.ts`) already existed and were tested,
// but nothing in production called them: `runSymbol` printed its own ad hoc
// prose and exited 0 (success), with no distinction between "capability never
// enabled" and a grammar problem.
// ---------------------------------------------------------------------------

describe("keryx gdgraph symbol — explicit symbol requirement (AFC-13/AC5, T19 finding 4)", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-symbol-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    // A built file-level graph with NO symbol layer at all (no
    // symbols.jsonl) and no `.metaproject/metaproject.json` at all — i.e.
    // the `gdgraph.treesitter` capability was never enabled. This is the
    // exact case the CLI printed prose and exited 0 for before this fix.
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
      "utf8",
    );

    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("an explicit symbol demand with no symbol layer active exits non-zero with a typed, actionable error on stderr", async () => {
    await gdgraphCommand(["symbol", "clonePipeline"]);

    expect(process.exitCode).toBe(1);
    const stderr = loggedErr.join("\n");
    expect(stderr.length).toBeGreaterThan(0);
    // The typed error's message + remedy both name the capability, so the
    // caller has an actionable next step, not a bare "unavailable".
    expect(stderr).toContain("gdgraph.treesitter");

    // Never again the old silent-success shape: prose on stdout, exit 0.
    expect(loggedOut.join("\n")).not.toContain("Symbol layer not active");
  });

  test("the same failure under --json is a structured error object on stdout, matching commands/modules.ts's convention", async () => {
    await gdgraphCommand(["symbol", "clonePipeline", "--json"]);

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(loggedOut.join("\n")) as {
      schemaVersion: number;
      error: string;
      message: string;
      remedy: string;
    };
    expect(payload.schemaVersion).toBe(1);
    // The typed error's own stable code (AFC-13/AC5 requirement 2/3) — never
    // a generic "unavailable" string.
    expect(payload.error).toBe("no-symbol-layer");
    expect(payload.message.length).toBeGreaterThan(0);
    expect(payload.remedy.length).toBeGreaterThan(0);
    expect(loggedErr.join("\n")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Flow 237 T6 defect 1 (AFC-28/AC-28, "a check that could not run is unknown
// rather than passed"): `checkGraphStaleness` (src/gdgraph/staleness.ts)
// returns a tri-state {fresh, stale, unknown} result with reasons — written
// exactly so a git failure never collapses into the same answer as a
// confirmed stale graph. Before this fix, `printStaleNote` (this file) only
// ever called the boolean wrapper `graphMaybeStale`, which maps BOTH "stale"
// and "unknown" to `true` and then always printed the same
// "repo moved since the last graph build" `STALE_NOTE` — so a git failure
// (graph freshness genuinely unknown) read to the CLI's own reader as a
// confident, specific claim ("repo moved") that was not actually established,
// and the structured reasons were discarded outright.
// ---------------------------------------------------------------------------

describe("keryx gdgraph find/path/symbol — staleness note carries the tri-state result, not a collapsed boolean", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(async () => {
    cwd = process.cwd();
    loggedOut = [];
    originalLog = console.log;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    process.chdir(cwd);
    process.exitCode = 0;
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("a git failure (graph freshness genuinely unknown) is never reported as the confident 'repo moved' claim", async () => {
    // Deliberately NOT a git repository (and not nested inside one via
    // mkdtemp under the OS tmp dir) — `git rev-parse HEAD` fails here, which
    // is exactly the trigger `checkGraphStaleness` maps to `status: "unknown"`
    // (see gdgraph/staleness.ts's own doc comment: "a git failure never
    // becomes fresh" — and, per this task, must never silently become the
    // stale wording either).
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-stale-unknown-"));
    process.chdir(root);
    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
      "utf8",
    );

    await gdgraphCommand(["find", "a.ts"]);

    const output = loggedOut.join("\n");
    // The defect: this exact string is what the pre-fix code printed for
    // EVERY non-fresh result, including a plain git failure.
    expect(output).not.toContain("note: repo moved since the last graph build");
    // The tri-state's own reason must reach this surface instead of being
    // discarded by the boolean collapse.
    expect(output).toContain("git rev-parse HEAD failed");
  });

  test("a real stale trigger (untracked file) surfaces checkGraphStaleness's specific reason, not just a generic note", async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-stale-reason-"));
    process.chdir(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "test"], { cwd: root });
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}\n',
      "utf8",
    );
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "initial build fixture"], { cwd: root });
    await recordProvenance(root, "gdgraph", new Date().toISOString());
    // The trigger: an untracked file added to the working tree after the
    // graph was built — `checkGraphStaleness`'s reason for this is specific
    // ("an untracked or newly added file exists in the working tree"), not
    // just the generic STALE_NOTE wording.
    await writeFile(path.join(root, "src", "untracked.ts"), "export const u = 1;\n");

    await gdgraphCommand(["find", "a.ts"]);

    const output = loggedOut.join("\n");
    expect(output).toContain("an untracked or newly added file exists in the working tree");
  });
});
