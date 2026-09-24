// `keryx hooks` (flow 306, W6, T8): list/validate/test/enable/disable, over
// temporary project + fake-home directories so no test ever touches a real
// `.metaproject/hooks.json` or `~/.keryx/hooks.json`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hooksCommand } from "./hooks";
import { BUILTIN_HOOK_IDS } from "../harness/hooks";

let project = "";
let home = "";
let logs: string[] = [];
let errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "keryx-hooks-project-"));
  home = await mkdtemp(path.join(tmpdir(), "keryx-hooks-home-"));
  logs = [];
  errors = [];
  console.log = ((...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  console.error = ((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.error;
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.exitCode = 0;
  await rm(project, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function projectHooksPath(): string {
  return path.join(project, ".metaproject", "hooks.json");
}

function userHooksPath(): string {
  return path.join(home, ".keryx", "hooks.json");
}

async function writeProjectHooks(doc: unknown): Promise<void> {
  await mkdir(path.join(project, ".metaproject"), { recursive: true });
  await writeFile(projectHooksPath(), JSON.stringify(doc, null, 2), "utf8");
}

function jsonOutput(): unknown {
  return JSON.parse(logs.join("\n"));
}

describe("keryx hooks list", () => {
  test("AC10: with no config files, lists exactly the five built-ins, all enabled", async () => {
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const result = jsonOutput() as { hooks: Array<{ id: string; enabled: boolean; scope: string }> };
    const ids = result.hooks.map((h) => h.id).sort();
    expect(ids).toEqual([...BUILTIN_HOOK_IDS].sort());
    expect(result.hooks.every((h) => h.enabled === true)).toBe(true);
    expect(result.hooks.every((h) => h.scope === "builtin")).toBe(true);
  });

  test("groups a multi-event built-in (keryx.learning-observer) into one row with an events array", async () => {
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const result = jsonOutput() as { hooks: Array<{ id: string; events: string[] }> };
    const observer = result.hooks.find((h) => h.id === "keryx.learning-observer");
    expect(observer).toBeDefined();
    expect(observer!.events.length).toBe(7);
  });
});

describe("keryx hooks validate", () => {
  test("AC6: rejects a project id colliding with a built-in, non-zero exit", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "keryx.ctx-guard", matcher: "Bash", class: "gate", command: { argv: ["x"] } }],
      },
    });
    await hooksCommand(["validate", "--json"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    const result = jsonOutput() as { ok: false; diagnostics: Array<{ code: string }> };
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "hook-id-collides-with-builtin")).toBe(true);
  });

  test("AC6: rejects a schema-invalid file, non-zero exit under --ci", async () => {
    await writeProjectHooks({ schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: "no-required-fields" }] } });
    await hooksCommand(["validate", "--json", "--ci"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    const result = jsonOutput() as { ok: false; diagnostics: Array<{ code: string }> };
    expect(result.diagnostics.some((d) => d.code === "schema-invalid")).toBe(true);
  });

  test("a clean project (no config files) validates with exit 0", async () => {
    await hooksCommand(["validate", "--json"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const result = jsonOutput() as { ok: true; hookCount: number };
    expect(result.ok).toBe(true);
    expect(result.hookCount).toBeGreaterThanOrEqual(5);
  });

  test("finding 11: resolves .metaproject/hooks.json from a SUBDIRECTORY cwd, same as a live session", async () => {
    // Review finding 11: `keryx hooks` used to resolve `.metaproject/` against
    // the raw `cwd`, unlike a real session (`buildShellHookRuntime`'s
    // callers), which always resolve the PROJECT ROOT first. Invoked from a
    // subdirectory, the CLI must find the SAME project-defined hook a live
    // session would.
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "sub-cwd-hook", matcher: "*", class: "observe", command: { argv: ["true"] } }],
      },
    });
    const sub = path.join(project, "src", "nested");
    await mkdir(sub, { recursive: true });

    await hooksCommand(["list", "--json"], { cwd: sub, homeDir: home });
    expect(process.exitCode).toBe(0);
    const result = jsonOutput() as { hooks: Array<{ id: string }> };
    expect(result.hooks.map((h) => h.id)).toContain("sub-cwd-hook");
  });
});

describe("keryx hooks enable/disable", () => {
  test("AC12: disable/enable round-trip for a built-in maintains _keryxManaged.managedHookIds", async () => {
    await hooksCommand(["disable", "keryx.ctx-guard"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);

    const afterDisable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    expect(afterDisable.hooks.PreToolUse).toContainEqual({ id: "keryx.ctx-guard", enabled: false });
    expect(afterDisable._keryxManaged.managedHookIds).toContain("keryx.ctx-guard");

    logs = [];
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const listed = jsonOutput() as { hooks: Array<{ id: string; enabled: boolean }> };
    const row = listed.hooks.find((h) => h.id === "keryx.ctx-guard");
    expect(row?.enabled).toBe(false);

    await hooksCommand(["enable", "keryx.ctx-guard"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const afterEnable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    expect(afterEnable.hooks.PreToolUse ?? []).not.toContainEqual({ id: "keryx.ctx-guard", enabled: false });
    expect(afterEnable._keryxManaged.managedHookIds).not.toContain("keryx.ctx-guard");
  });

  test("AC12: refuses to enable a hand-authored (not Keryx-managed) disable override, and writes nothing", async () => {
    const doc = { schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: "keryx.ctx-guard", enabled: false }] } };
    await writeProjectHooks(doc);
    await hooksCommand(["enable", "keryx.ctx-guard"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    const stillThere = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    expect(stillThere.hooks.PreToolUse).toContainEqual({ id: "keryx.ctx-guard", enabled: false });
    expect(stillThere._keryxManaged).toBeUndefined();
  });

  test("AC12: disable/enable round-trip for a project-defined hook flips its own `enabled` field", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        Stop: [
          {
            id: "my-observe-hook",
            matcher: "*",
            class: "observe",
            command: { argv: ["true"] },
          },
        ],
      },
    });
    await hooksCommand(["disable", "my-observe-hook"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const afterDisable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    const disabledEntry = afterDisable.hooks.Stop.find((h: { id: string }) => h.id === "my-observe-hook");
    expect(disabledEntry.enabled).toBe(false);
    expect(afterDisable._keryxManaged.managedHookIds).toContain("my-observe-hook");

    await hooksCommand(["enable", "my-observe-hook"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const afterEnable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    const enabledEntry = afterEnable.hooks.Stop.find((h: { id: string }) => h.id === "my-observe-hook");
    expect(enabledEntry.enabled).toBe(true);
    // Untouched otherwise: the entry's other fields survive verbatim.
    expect(enabledEntry.matcher).toBe("*");
    expect(enabledEntry.command.argv).toEqual(["true"]);
  });

  test("AC12: a hand-authored hook registered on several events is flipped on EVERY event, not just the first", async () => {
    // Review finding 12: `setProjectOrUserHookEnabled` used to stop at the
    // FIRST full registration it found for an id and never touch the rest —
    // an id repeated on several events (one full registration entry per
    // event, same shape a real project can hand-author) silently kept its
    // other events at the old `enabled` value.
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "multi-event-hook", matcher: "*", class: "observe", command: { argv: ["true"] } }],
        PostToolUse: [{ id: "multi-event-hook", matcher: "*", class: "observe", command: { argv: ["true"] } }],
        Stop: [
          { id: "other-hook", matcher: "*", class: "observe", command: { argv: ["true"] } },
          { id: "multi-event-hook", matcher: "*", class: "observe", command: { argv: ["true"] } },
        ],
      },
    });
    await hooksCommand(["disable", "multi-event-hook"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const afterDisable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    for (const event of ["PreToolUse", "PostToolUse"] as const) {
      const entry = afterDisable.hooks[event].find((h: { id: string }) => h.id === "multi-event-hook");
      expect(entry.enabled).toBe(false);
    }
    const stopEntries = afterDisable.hooks.Stop as Array<{
      id: string;
      enabled?: boolean;
      matcher?: string;
      class?: string;
      command?: { argv: string[] };
    }>;
    expect(stopEntries.find((h) => h.id === "multi-event-hook")?.enabled).toBe(false);
    // A hand-authored entry under a DIFFERENT id, in the same event array, is
    // never removed, reordered, or edited.
    expect(stopEntries).toContainEqual({ id: "other-hook", matcher: "*", class: "observe", command: { argv: ["true"] } });
    expect(stopEntries.map((h) => h.id)).toEqual(["other-hook", "multi-event-hook"]);
    expect(afterDisable._keryxManaged.managedHookIds).toContain("multi-event-hook");

    await hooksCommand(["enable", "multi-event-hook"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const afterEnable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    for (const event of ["PreToolUse", "PostToolUse", "Stop"] as const) {
      const entry = afterEnable.hooks[event].find((h: { id: string }) => h.id === "multi-event-hook");
      expect(entry.enabled).toBe(true);
    }
  });

  test("--user targets ~/.keryx/hooks.json instead of the project file", async () => {
    await hooksCommand(["disable", "keryx.ctx-guard", "--user"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    expect(existsSync(userHooksPath())).toBe(true);
    expect(existsSync(projectHooksPath())).toBe(false);
    const userDoc = JSON.parse(await readFile(userHooksPath(), "utf8"));
    expect(userDoc.hooks.PreToolUse).toContainEqual({ id: "keryx.ctx-guard", enabled: false });
  });

  test("unknown id is refused, non-zero exit", async () => {
    await hooksCommand(["disable", "nonexistent-hook-id"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    expect(existsSync(projectHooksPath())).toBe(false);
  });

  test("finding 18: readDoc on a malformed project hooks.json reports exactly one 'not valid JSON' error", async () => {
    await mkdir(path.join(project, ".metaproject"), { recursive: true });
    await writeFile(projectHooksPath(), "{ not json", "utf8");
    await hooksCommand(["disable", "keryx.ctx-guard"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    expect(errors.filter((e) => e.includes("is not valid JSON")).length).toBe(1);
    expect(errors.some((e) => e.includes("must contain a JSON object"))).toBe(false);
  });

  test("finding 18: readDoc on a JSON-array project hooks.json reports 'must contain a JSON object', not a bogus 'not valid JSON' error", async () => {
    await mkdir(path.join(project, ".metaproject"), { recursive: true });
    await writeFile(projectHooksPath(), "[1,2,3]", "utf8");
    await hooksCommand(["disable", "keryx.ctx-guard"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("must contain a JSON object"))).toBe(true);
    expect(errors.some((e) => e.includes("is not valid JSON"))).toBe(false);
  });
});

describe("keryx hooks test", () => {
  test("AC12: runs a real tiny hook script through the real runner and reports decision deny for exit 2", async () => {
    const scriptPath = path.join(project, "fixture-deny-hook.js");
    await writeFile(
      scriptPath,
      'process.stderr.write("denied by fixture hook\\n");\nprocess.exit(2);\n',
      "utf8",
    );
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          {
            id: "fixture-deny-hook",
            matcher: "*",
            class: "gate",
            command: { argv: [process.execPath, scriptPath] },
            runsIn: "unsandboxed",
            network: "none",
            timeoutMs: 5000,
          },
        ],
      },
    });

    await hooksCommand(["test", "fixture-deny-hook", "--json"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0); // the hook ran; "test" itself never fails for a hook's own deny.
    const report = jsonOutput() as { decision?: string; exitCode?: number; stderr?: string };
    expect(report.decision).toBe("deny");
    expect(report.exitCode).toBe(2);
    expect(report.stderr).toContain("denied by fixture hook");
  });

  test("unknown id is refused, non-zero exit", async () => {
    await hooksCommand(["test", "nonexistent-hook-id"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
  });

  test("a builtin in-process hook (keryx.learning-observer) reports its port's result", async () => {
    let recorded = 0;
    await hooksCommand(["test", "keryx.learning-observer", "--event", "Stop", "--json"], {
      cwd: project,
      homeDir: home,
      learningSink: {
        record: () => {
          recorded += 1;
        },
      },
    });
    expect(process.exitCode).toBe(0);
    expect(recorded).toBe(1);
    const report = jsonOutput() as { hookId: string; event: string };
    expect(report.hookId).toBe("keryx.learning-observer");
    expect(report.event).toBe("Stop");
  });

  test("finding 18: a --payload-file that is a JSON ARRAY reports 'must contain a JSON object', not a bogus second 'not valid JSON' error", async () => {
    // Review finding 18: the shape check used to live inside the JSON.parse
    // try/catch, so its own `fail()` (which throws) was re-caught and
    // re-reported as "is not valid JSON" — the array IS valid JSON, so that
    // second message was actively wrong, not just redundant.
    const payloadPath = path.join(project, "payload.json");
    await writeFile(payloadPath, "[1,2,3]", "utf8");
    await hooksCommand(["test", "keryx.ctx-guard", "--payload-file", payloadPath], {
      cwd: project,
      homeDir: home,
    });
    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("must contain a JSON object"))).toBe(true);
    expect(errors.some((e) => e.includes("is not valid JSON"))).toBe(false);
  });

  test("finding 18: a --payload-file with malformed JSON reports exactly one 'not valid JSON' error", async () => {
    const payloadPath = path.join(project, "payload.json");
    await writeFile(payloadPath, "{ not json", "utf8");
    await hooksCommand(["test", "keryx.ctx-guard", "--payload-file", payloadPath], {
      cwd: project,
      homeDir: home,
    });
    expect(process.exitCode).toBe(1);
    expect(errors.filter((e) => e.includes("is not valid JSON")).length).toBe(1);
    expect(errors.some((e) => e.includes("must contain a JSON object"))).toBe(false);
  });
});
