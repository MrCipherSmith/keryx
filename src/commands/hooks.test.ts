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

  // Flow 306 fix round 2 (finding F): `list` used to report `runsIn:
  // "unsandboxed"` for a project hook with nothing saying the runner would
  // actually REFUSE it under a profile requiring fail-closed isolation — the
  // same `isolationRequired` check `runtime.ts` (and, since this fix, `hooks
  // test`) applies.
  test("finding F: a runsIn:unsandboxed project hook is reported refused under --profile unattended-untrusted", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          {
            id: "unsandboxed-project-hook",
            matcher: "*",
            class: "observe",
            command: { argv: ["true"] },
            runsIn: "unsandboxed",
            network: "none",
            timeoutMs: 5000,
          },
        ],
      },
    });

    await hooksCommand(["list", "--json", "--profile", "unattended-untrusted"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const result = jsonOutput() as { hooks: Array<{ id: string; runsIn: string; refused: boolean }> };
    const row = result.hooks.find((h) => h.id === "unsandboxed-project-hook");
    expect(row).toBeDefined();
    expect(row!.runsIn).toBe("unsandboxed");
    expect(row!.refused).toBe(true);
  });

  test("finding F: the SAME project hook is NOT refused under a profile that does not require isolation", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          {
            id: "unsandboxed-project-hook",
            matcher: "*",
            class: "observe",
            command: { argv: ["true"] },
            runsIn: "unsandboxed",
            network: "none",
            timeoutMs: 5000,
          },
        ],
      },
    });

    await hooksCommand(["list", "--json", "--profile", "monitored-trusted-local"], { cwd: project, homeDir: home });
    const result = jsonOutput() as { hooks: Array<{ id: string; runsIn: string; refused: boolean }> };
    const row = result.hooks.find((h) => h.id === "unsandboxed-project-hook");
    expect(row).toBeDefined();
    expect(row!.refused).toBe(false);
  });

  // R2-06 (flow 319 review round 2): `hooks trust` already printed a
  // "contains control or invisible characters" warning when it escaped
  // something; `list` escaped the same values but said nothing.
  test("R2-06: prints an escaped-characters warning when a hook's argv needed escaping, none when clean", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "csi-hook", matcher: "*", class: "observe", command: { argv: ["echo", "a\u001b[2Kb"] } }],
      },
    });
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    logs = [];
    errors = [];
    await hooksCommand(["list"], { cwd: project, homeDir: home });
    const printed = logs.join("\n");
    expect(printed).not.toContain("\u001b");
    expect(printed).toContain("\\x1b[2Kb");
    expect(errors.some((e) => e.includes("contain control or invisible characters"))).toBe(true);
  });

  test("R2-06: no escaped-characters warning when nothing needed escaping", async () => {
    errors = [];
    await hooksCommand(["list"], { cwd: project, homeDir: home });
    expect(errors.some((e) => e.includes("contain control or invisible characters"))).toBe(false);
  });

  // R2-03 (flow 319 review round 2): a schema-invalid diagnostic quotes the
  // offending JSON path verbatim, including an attacker-chosen property
  // name under `hooks` — this used to reach the plain-text listing raw.
  test("R2-03: a schema diagnostic quoting an attacker property name is escaped", async () => {
    await writeProjectHooks({ schemaVersion: "1.0.0", hooks: { "Bad\u001b[1Aevent": [] } });
    errors = [];
    await hooksCommand(["list"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    const combined = errors.join("\n");
    expect(combined).not.toContain("\u001b");
    expect(combined).toContain("\\x1b[1A");
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

  // R2-03 (flow 319 review round 2): same class as the `list` case above —
  // `hooks validate`'s plain-text diagnostics must escape an attacker
  // property name too, not just the JSON output (already safe on its own).
  test("R2-03: a schema diagnostic quoting an attacker property name is escaped", async () => {
    await writeProjectHooks({ schemaVersion: "1.0.0", hooks: { "Bad\u001b[1Aevent": [] } });
    await hooksCommand(["validate"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    const combined = errors.join("\n");
    expect(combined).not.toContain("\u001b");
    expect(combined).toContain("\\x1b[1A");
  });
});

describe("keryx hooks enable/disable", () => {
  test("AC12: disable/enable round-trip for a built-in maintains _keryxManaged.managedHookIds", async () => {
    // R700-02: keryx.ctx-guard is a protected built-in GATE — a project-scope
    // disable of it is now refused outright (D12), so this round-trip test
    // uses keryx.learning-observer (class observe, unaffected by the
    // tighten-only rule) instead.
    await hooksCommand(["disable", "keryx.learning-observer"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);

    const afterDisable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    expect(afterDisable.hooks.SessionStart).toContainEqual({ id: "keryx.learning-observer", enabled: false });
    expect(afterDisable._keryxManaged.managedHookIds).toContain("keryx.learning-observer");

    logs = [];
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const listed = jsonOutput() as { hooks: Array<{ id: string; enabled: boolean }> };
    const row = listed.hooks.find((h) => h.id === "keryx.learning-observer");
    expect(row?.enabled).toBe(false);

    await hooksCommand(["enable", "keryx.learning-observer"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const afterEnable = JSON.parse(await readFile(projectHooksPath(), "utf8"));
    expect(afterEnable.hooks.SessionStart ?? []).not.toContainEqual({ id: "keryx.learning-observer", enabled: false });
    expect(afterEnable._keryxManaged.managedHookIds).not.toContain("keryx.learning-observer");
  });

  test("R700-02: disable of a gate at project scope refuses and writes nothing", async () => {
    await hooksCommand(["disable", "keryx.ctx-guard"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    expect(existsSync(projectHooksPath())).toBe(false);
  });

  test("R700-02: disable of a gate --user without --acknowledge-gate-risk refuses", async () => {
    await hooksCommand(["disable", "keryx.ctx-guard", "--user"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    expect(existsSync(userHooksPath())).toBe(false);
  });

  test("R700-02: disable --user --acknowledge-gate-risk writes the acknowledged override and enable --user removes it", async () => {
    await hooksCommand(["disable", "keryx.ctx-guard", "--user", "--acknowledge-gate-risk"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const userDoc = JSON.parse(await readFile(userHooksPath(), "utf8"));
    expect(userDoc.hooks.PreToolUse).toContainEqual({ id: "keryx.ctx-guard", enabled: false, acknowledge: "disable-builtin-gate" });

    await hooksCommand(["enable", "keryx.ctx-guard", "--user"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const afterEnable = JSON.parse(await readFile(userHooksPath(), "utf8"));
    expect(afterEnable.hooks.PreToolUse ?? []).not.toContainEqual(
      expect.objectContaining({ id: "keryx.ctx-guard", enabled: false }),
    );
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
    await hooksCommand(["disable", "keryx.ctx-guard", "--user", "--acknowledge-gate-risk"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    expect(existsSync(userHooksPath())).toBe(true);
    expect(existsSync(projectHooksPath())).toBe(false);
    const userDoc = JSON.parse(await readFile(userHooksPath(), "utf8"));
    expect(userDoc.hooks.PreToolUse).toContainEqual({ id: "keryx.ctx-guard", enabled: false, acknowledge: "disable-builtin-gate" });
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

    // R700-01: a project full registration only loads (and so is runnable by
    // `hooks test`, D8) once trusted.
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    logs = [];
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

  test("R700-01: test refuses an untrusted project hook", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: { PreToolUse: [{ id: "untrusted-hook", matcher: "*", class: "observe", command: { argv: ["true"] } }] },
    });
    await hooksCommand(["test", "untrusted-hook"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
    expect(errors.some((e) => e.includes("not trusted") && e.includes("keryx hooks trust"))).toBe(true);
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

  // F-004 (fix round 4): `keryx hooks test keryx.impact-evidence` used to
  // read only `toolInput.filePath`, so a dry run of a real `apply_patch`
  // ({patch}) payload tested a synthetic fallback file instead of the
  // patch's actual targets. It must use the same extractor the live runtime
  // does (`extractFilePathsFromToolInput`), including a multi-file patch,
  // and surface the provider's warnings.
  test("F-004: keryx hooks test keryx.impact-evidence extracts files from an apply_patch-shaped payload, the same way the runtime does", async () => {
    const seenFiles: string[][] = [];
    const payloadPath = path.join(project, "payload.json");
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old a",
      "+new a",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1 @@",
      "-old b",
      "+new b",
      "",
    ].join("\n");
    await writeFile(
      payloadPath,
      JSON.stringify({
        sessionId: "s",
        runId: "r",
        toolCallId: "t1",
        toolName: "Edit",
        keryxToolName: "apply_patch",
        toolInput: { patch },
        policyProfile: "monitored-trusted-local",
      }),
      "utf8",
    );
    await hooksCommand(["test", "keryx.impact-evidence", "--payload-file", payloadPath, "--json"], {
      cwd: project,
      homeDir: home,
      impactEvidence: {
        evidenceFor: (input) => {
          seenFiles.push(input.files);
          return { warnings: ["skipped 1 path(s) outside the project root: ../secret.ts"] };
        },
      },
    });
    expect(process.exitCode).toBe(0);
    expect(seenFiles).toEqual([["src/a.ts", "src/b.ts"]]);
    const report = jsonOutput() as { warnings?: string[] };
    expect(report.warnings).toEqual(["skipped 1 path(s) outside the project root: ../secret.ts"]);
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

  // Flow 306 fix round 2 (finding F): `hooks test` used to omit
  // `isolationRequired` from its `runner.run()` request entirely, so a
  // project hook explicitly configured `runsIn: "unsandboxed"` would actually
  // SPAWN here even under `unattended-untrusted` — while a live session
  // (`runtime.ts`'s `runCommandHook`) refuses that exact same call. Same
  // `isIsolationRequired` helper, same runner refusal now on both paths.
  test("finding F: --profile unattended-untrusted refuses a runsIn:unsandboxed project hook (same refusal as the runtime)", async () => {
    const scriptPath = path.join(project, "fixture-marker-hook.js");
    await writeFile(scriptPath, "process.exit(0);\n", "utf8");
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          {
            id: "unsandboxed-project-hook",
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

    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    logs = [];
    await hooksCommand(["test", "unsandboxed-project-hook", "--profile", "unattended-untrusted", "--json"], {
      cwd: project,
      homeDir: home,
    });
    expect(process.exitCode).toBe(0); // "test" itself never fails for a hook's own refusal — same posture as AC12's deny.
    const report = jsonOutput() as { failure?: string; runsIn?: string };
    expect(report.runsIn).toBe("unsandboxed");
    expect(report.failure).toBe("refused");
  });

  test("finding F: the SAME project hook actually runs under a profile that does not require isolation", async () => {
    const scriptPath = path.join(project, "fixture-marker-hook.js");
    await writeFile(scriptPath, "process.exit(0);\n", "utf8");
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          {
            id: "unsandboxed-project-hook",
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

    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    logs = [];
    await hooksCommand(["test", "unsandboxed-project-hook", "--profile", "monitored-trusted-local", "--json"], {
      cwd: project,
      homeDir: home,
    });
    expect(process.exitCode).toBe(0);
    const report = jsonOutput() as { failure?: string; exitCode?: number };
    expect(report.failure).toBeUndefined();
    expect(report.exitCode).toBe(0);
  });
});

describe("keryx hooks trust / untrust", () => {
  async function writeOneGateHook(id = "my-gate"): Promise<void> {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: { PreToolUse: [{ id, matcher: "Bash", class: "gate", command: { argv: ["echo", "hi"] }, runsIn: "unsandboxed" }] },
    });
  }

  test("list shows trust=untrusted and the trust header", async () => {
    await writeOneGateHook();
    await hooksCommand(["list"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    expect(errors.some((e) => e.includes("not trusted") && e.includes("keryx hooks trust"))).toBe(true);
    expect(logs.join("\n")).toContain("trust=untrusted");
  });

  // R700-01 fix (flow 319): "are not trusted and do not run (not trusted)"
  // said the same thing twice — the parenthetical is dropped for the
  // untrusted state (the sentence already says it), and reworded to a fact
  // ("changed since you trusted it") for the changed state, which is
  // genuinely new information the sentence doesn't otherwise carry.
  test("R700-01 fix: the untrusted header has no redundant parenthesis", async () => {
    await writeOneGateHook();
    await hooksCommand(["list"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const header = errors.find((e) => e.includes("are not trusted and do not run"));
    expect(header).toBeDefined();
    expect(header).toContain("are not trusted and do not run. Review and trust them with: keryx hooks trust");
    expect(header).not.toContain("(not trusted)");
    expect(header).not.toContain("(untrusted)");
  });

  test("R700-01 fix: the changed-since-trusted header names what changed, not a bare label", async () => {
    await writeOneGateHook();
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    // Trusted at THIS digest; changing the file after trust makes it "changed".
    await writeOneGateHook("my-gate-renamed");
    errors = [];
    await hooksCommand(["list"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    const header = errors.find((e) => e.includes("are not trusted and do not run"));
    expect(header).toBeDefined();
    expect(header).toContain(
      "are not trusted and do not run (changed since you trusted it). Review and trust them with: keryx hooks trust",
    );
    expect(header).not.toContain("(changed since trusted)");
  });

  test("list --json carries projectTrust and per-row trust", async () => {
    await writeOneGateHook();
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const result = jsonOutput() as { projectTrust: { state: string }; hooks: Array<{ id: string; trust?: string }> };
    expect(result.projectTrust.state).toBe("untrusted");
    expect(result.hooks.find((h) => h.id === "my-gate")?.trust).toBe("untrusted");
  });

  test("trust --yes records trust and list then shows trusted", async () => {
    await writeOneGateHook();
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Trusted");

    logs = [];
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const result = jsonOutput() as { hooks: Array<{ id: string; trust?: string; scope: string }> };
    const row = result.hooks.find((h) => h.id === "my-gate");
    expect(row?.trust).toBe("trusted");
    expect(row?.scope).toBe("project");
  });

  test("trust without --yes and without a TTY refuses and writes nothing", async () => {
    await writeOneGateHook();
    await hooksCommand(["trust"], { cwd: project, homeDir: home, isInteractive: false });
    expect(process.exitCode).toBe(1);
    expect(existsSync(path.join(home, "..", "does-not-matter"))).toBe(false);
    expect(errors.some((e) => e.includes("Re-run with --yes"))).toBe(true);
  });

  test('trust in a TTY asks; "no" writes nothing', async () => {
    await writeOneGateHook();
    let asked = "";
    await hooksCommand(["trust"], {
      cwd: project,
      homeDir: home,
      isInteractive: true,
      confirm: async (q) => {
        asked = q;
        return false;
      },
    });
    expect(process.exitCode).toBe(1);
    expect(asked).toContain("Trust exactly this version");
    expect(errors.some((e) => e.includes("Nothing was trusted"))).toBe(true);
  });

  test("trust prints every command and a WARNING for unsandboxed hooks", async () => {
    await writeOneGateHook();
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    const text = logs.join("\n");
    expect(text).toContain("my-gate");
    expect(text).toContain("UNSANDBOXED");
    expect(text).toContain("WARNING");
  });

  // R1-02 (flow 319 review round 1): reviewer's scratch repo r2 — an argv
  // token with no whitespace (via ${IFS}) carrying a CSI cursor-erase
  // sequence that tries to overwrite the UNSANDBOXED warning line. Must
  // reach the terminal escaped, and the trust display must ALSO print its
  // own "contains control or invisible characters" warning.
  test("trust escapes a CSI cursor-erase argv payload and warns about it", async () => {
    const csiArgv = "touch${IFS}/tmp/M2\u001b[1A\u001b[2K\u001b[1G";
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          { id: "csi-hook", matcher: "*", class: "gate", command: { argv: ["/bin/sh", "-c", csiArgv] }, runsIn: "unsandboxed" },
        ],
      },
    });
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    const text = logs.join("\n");
    expect(text).not.toContain("\u001b");
    expect(text).toContain("\\x1b[1A\\x1b[2K\\x1b[1G");
    expect(text).toContain("WARNING: this file contains control or invisible characters");
    expect(text).toContain("UNSANDBOXED");
  });

  // A bidi override in an argv token (the `id` schema pattern
  // `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$` already excludes bidi/control
  // characters, so it cannot carry one through this end-to-end path — the
  // defence-in-depth escaping of `id` itself is covered directly in
  // trust.test.ts): escaped in both `hooks trust` and `hooks list`.
  test("trust and list escape a bidi override in an argv token", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          { id: "bidi-hook", matcher: "*", class: "observe", command: { argv: ["echo", "safe-‮evil-diguc.exe"] } },
        ],
      },
    });
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    const trustText = logs.join("\n");
    expect(trustText).not.toContain("‮");
    expect(trustText).toContain("\\u202e");

    logs = [];
    await hooksCommand(["list"], { cwd: project, homeDir: home });
    const listText = logs.join("\n");
    expect(listText).not.toContain("‮");
    expect(listText).toContain("\\u202e");
  });

  test("trust refuses an invalid file", async () => {
    await writeProjectHooks({ schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: "x" }] } });
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(1);
  });

  test("untrust removes trust", async () => {
    await writeOneGateHook();
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    logs = [];
    await hooksCommand(["untrust"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("Removed trust");

    logs = [];
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const result = jsonOutput() as { projectTrust: { state: string } };
    expect(result.projectTrust.state).toBe("untrusted");
  });

  test("disable/enable of a project hook carries trust over when the file was trusted", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: { Stop: [{ id: "my-observe-hook", matcher: "*", class: "observe", command: { argv: ["true"] } }] },
    });
    await hooksCommand(["trust", "--yes"], { cwd: project, homeDir: home });
    logs = [];
    await hooksCommand(["disable", "my-observe-hook"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("carried over");

    logs = [];
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const result = jsonOutput() as { hooks: Array<{ id: string; trust?: string; enabled: boolean }> };
    const row = result.hooks.find((h) => h.id === "my-observe-hook");
    expect(row?.trust).toBe("trusted");
    expect(row?.enabled).toBe(false);
  });

  test("enable of a project hook in an untrusted file leaves it untrusted", async () => {
    await writeProjectHooks({
      schemaVersion: "1.0.0",
      hooks: { Stop: [{ id: "my-observe-hook", matcher: "*", class: "observe", command: { argv: ["true"] }, enabled: false }] },
    });
    // Never trusted this file.
    await hooksCommand(["enable", "my-observe-hook"], { cwd: project, homeDir: home });
    expect(process.exitCode).toBe(0);
    expect(logs.join("\n")).toContain("not trusted");

    logs = [];
    await hooksCommand(["list", "--json"], { cwd: project, homeDir: home });
    const result = jsonOutput() as { projectTrust: { state: string } };
    expect(result.projectTrust.state).toBe("untrusted");
  });

  test("disable refuses to write through a .metaproject/hooks.json symlink that escapes the project", async () => {
    // R700-04: `writeDocAtomic` now routes every hooks.json write through
    // `writeContained`, which refuses a symlink whose resolved target leaves
    // `root` rather than following it.
    const { symlinkSync, mkdirSync: mkdirSyncNode } = await import("node:fs");
    const outside = path.join(path.dirname(project), `keryx-hooks-outside-${Date.now()}`);
    mkdirSyncNode(outside, { recursive: true });
    mkdirSyncNode(path.join(project, ".metaproject"), { recursive: true });
    symlinkSync(path.join(outside, "hooks.json"), projectHooksPath());
    await hooksCommand(["disable", "keryx.learning-observer"], { cwd: project, homeDir: home });
    expect(process.exitCode).not.toBe(0);
    expect(errors.join("\n")).toContain(`Refusing to write ${projectHooksPath()}`);
    expect(errors.join("\n")).toContain("Nothing was written");
    // The outside target must not have been created or written through the link.
    expect(existsSync(path.join(outside, "hooks.json"))).toBe(false);
  });
});
