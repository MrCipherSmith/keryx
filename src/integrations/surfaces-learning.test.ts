// Flow 312 (W3 self-learning loop), T11: the opt-in Claude Code learning
// observer surface (`surfaces-learning.ts`) — AC14.
//
// Proves, in order:
//   (a) install with the `observe`/`learning-observer` selector writes all
//       seven hook entries (sentinel + command) into `.claude/settings.json`;
//       install with NO selector never installs it (opt-in, plan D5).
//   (b) install then uninstall removes only the observer's own entries,
//       leaving ctx-guard's `PreToolUse` and security-check-input's
//       `UserPromptSubmit` entries intact (coexistence on a shared file/key).
//   (c) `doctor` reports it under `--surface observe` opt-in checks, same as
//       `agents`.
//   (d) a round-trip: the installed hook command, run as
//       `bun ./src/cli.ts learn observe --hook claude` with a real Claude
//       PostToolUse payload on stdin (cwd = a temp project), exits 0 and
//       appends exactly one JSONL line under
//       `.metaproject/data/learning/observations/`.

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { getHarnessAdapter } from "./registry";
import { doctorIntegration, installIntegration, resolveSurfaceSelection, uninstallIntegration } from "./installer";
import { readSettingsFile } from "./settings-json";
import { LEARNING_OBSERVER_CLAUDE, LEARNING_OBSERVER_EVENTS, LEARNING_OBSERVER_SENTINEL, learningObserverCommand } from "./surfaces-learning";
import type { Settings } from "./types";

const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-learning-observer-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function settingsOf(root: string): Promise<Settings> {
  return readSettingsFile(path.join(root, ".claude", "settings.json"));
}

function groupsFor(settings: Settings, event: string): Array<Record<string, unknown>> {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const list = hooks && Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
  return list as Array<Record<string, unknown>>;
}

function ownGroup(settings: Settings, event: string): Record<string, unknown> | undefined {
  return groupsFor(settings, event).find((g) => g["_keryxManaged"] === LEARNING_OBSERVER_SENTINEL);
}

describe("surface registration", () => {
  test("claude: registered as id 'learning-observer', flag 'observe', subsystem 'learning', optIn true", () => {
    const claude = getHarnessAdapter("claude")!;
    const surface = claude.surfaces.find((s) => s.id === "learning-observer");
    expect(surface).toBeDefined();
    expect(surface).toBe(LEARNING_OBSERVER_CLAUDE);
    expect(surface!.flag).toBe("observe");
    expect(surface!.subsystem).toBe("learning");
    expect(surface!.optIn).toBe(true);
    expect(surface!.confidence).toBe("verified");
  });

  test("resolveSurfaceSelection: empty selector excludes it; '--surface observe' and '--surface learning-observer' both select it", () => {
    const claude = getHarnessAdapter("claude")!;
    expect(resolveSurfaceSelection(claude, []).some((s) => s.id === "learning-observer")).toBe(false);
    expect(resolveSurfaceSelection(claude, ["observe"]).map((s) => s.id)).toEqual(["learning-observer"]);
    expect(resolveSurfaceSelection(claude, ["learning-observer"]).map((s) => s.id)).toEqual(["learning-observer"]);
  });
});

describe("(a) install writes all seven hook entries; absent without the selector", () => {
  test("install --surface observe writes PreToolUse/PostToolUse/PostToolUseFailure/UserPromptSubmit/SessionStart/Stop/SessionEnd, each with the sentinel and the command", async () => {
    await withTempDir(async (root) => {
      const result = await installIntegration(root, "claude", { surfaces: ["observe"] });
      expect(result.errors, JSON.stringify(result)).toEqual([]);
      expect(result.results.map((r) => r.status)).toEqual(["installed"]);

      const settings = await settingsOf(root);
      for (const event of LEARNING_OBSERVER_EVENTS) {
        const group = ownGroup(settings, event);
        expect(group, `missing ${event} group`).toBeDefined();
        const hooks = group!["hooks"] as Array<Record<string, unknown>>;
        expect(hooks).toEqual([{ type: "command", command: learningObserverCommand(), timeout: 5 }]);
      }
      // Tool events carry a matcher; the four lifecycle-only events do not.
      expect((ownGroup(settings, "PreToolUse") as Record<string, unknown>)["matcher"]).toBe("*");
      expect((ownGroup(settings, "PostToolUse") as Record<string, unknown>)["matcher"]).toBe("*");
      expect((ownGroup(settings, "PostToolUseFailure") as Record<string, unknown>)["matcher"]).toBe("*");
      expect(ownGroup(settings, "UserPromptSubmit")!["matcher"]).toBeUndefined();
      expect(ownGroup(settings, "SessionStart")!["matcher"]).toBeUndefined();
      expect(ownGroup(settings, "Stop")!["matcher"]).toBeUndefined();
      expect(ownGroup(settings, "SessionEnd")!["matcher"]).toBeUndefined();

      const doctor = await doctorIntegration(root, "claude", { surfaces: ["observe"] });
      const own = doctor.surfaces.find((s) => s.surfaceId === "learning-observer");
      expect(own?.live).toBe("valid");
    });
  });

  test("install with no --surface never writes the observer (opt-in, plan D5)", async () => {
    await withTempDir(async (root) => {
      const result = await installIntegration(root, "claude");
      expect(result.errors, JSON.stringify(result)).toEqual([]);
      expect(result.results.some((r) => r.surfaceId === "learning-observer")).toBe(false);

      const settings = await settingsOf(root);
      for (const event of LEARNING_OBSERVER_EVENTS) {
        expect(ownGroup(settings, event), `${event} should not be present`).toBeUndefined();
      }
    });
  });
});

describe("(b) coexistence: uninstall removes only the observer's own entries", () => {
  test("install everything (ctx-guard/orient/security default + observer opt-in), uninstall only observer -> siblings intact", async () => {
    await withTempDir(async (root) => {
      const defaultInstall = await installIntegration(root, "claude");
      expect(defaultInstall.errors, JSON.stringify(defaultInstall)).toEqual([]);
      const observerInstall = await installIntegration(root, "claude", { surfaces: ["observe"] });
      expect(observerInstall.errors, JSON.stringify(observerInstall)).toEqual([]);

      const before = await settingsOf(root);
      expect(ownGroup(before, "PreToolUse")).toBeDefined();
      // ctx-guard's own PreToolUse group (sentinel "ctx-agent-hooks") must
      // still be present alongside ours.
      expect(groupsFor(before, "PreToolUse").some((g) => g["_keryxManaged"] === "ctx-agent-hooks")).toBe(true);
      expect(groupsFor(before, "UserPromptSubmit").some((g) => g["_keryxManaged"] === "ctx-orient-hooks")).toBe(true);
      expect(groupsFor(before, "UserPromptSubmit").some((g) => g["_keryxManaged"] === "security-agent-hooks")).toBe(true);

      const uninstalled = await uninstallIntegration(root, "claude", { surfaces: ["observe"] });
      expect(uninstalled.errors, JSON.stringify(uninstalled)).toEqual([]);
      expect(uninstalled.results.map((r) => r.status)).toEqual(["removed"]);

      const after = await settingsOf(root);
      for (const event of LEARNING_OBSERVER_EVENTS) {
        expect(ownGroup(after, event), `${event} should be gone`).toBeUndefined();
      }
      // Siblings untouched.
      expect(groupsFor(after, "PreToolUse").some((g) => g["_keryxManaged"] === "ctx-agent-hooks")).toBe(true);
      expect(groupsFor(after, "PreToolUse").some((g) => g["_keryxManaged"] === "security-agent-hooks")).toBe(true);
      expect(groupsFor(after, "UserPromptSubmit").some((g) => g["_keryxManaged"] === "ctx-orient-hooks")).toBe(true);
      expect(groupsFor(after, "UserPromptSubmit").some((g) => g["_keryxManaged"] === "security-agent-hooks")).toBe(true);

      const doctorAfter = await doctorIntegration(root, "claude");
      expect(doctorAfter.ok, JSON.stringify(doctorAfter)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// (d) round-trip through the real CLI.
// ---------------------------------------------------------------------------

async function observationLinesFor(root: string, date: string): Promise<string[]> {
  const file = path.join(root, ".metaproject", "data", "learning", "observations", `${date}.jsonl`);
  try {
    const raw = await readFile(file, "utf8");
    return raw.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

describe("(d) round-trip: the installed command really appends an observation line", () => {
  test("`bun ./src/cli.ts learn observe --hook claude` with a PostToolUse payload exits 0 and appends one line", async () => {
    await withTempDir(async (root) => {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });

      const today = new Date().toISOString().slice(0, 10);
      const payload = JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "sess-t11-roundtrip",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        tool_response: { stdout: "hello\n", stderr: "" },
        tool_use_id: "tool-1",
        cwd: root,
      });

      const homeDir = await mkdtemp(path.join(tmpdir(), "keryx-home-"));
      try {
        const proc = Bun.spawn([process.execPath, CLI, "learn", "observe", "--hook", "claude"], {
          cwd: root,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NO_COLOR: "1", KERYX_HOME: homeDir },
        });
        proc.stdin.write(payload);
        await proc.stdin.end();
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(code, `stdout=${out} stderr=${err}`).toBe(0);
        expect(out.trim()).toBe(""); // D5: no stdout decision, ever.

        const lines = await observationLinesFor(root, today);
        expect(lines.length).toBe(1);
        const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(parsed.schemaVersion).toBe(1);
        expect(parsed.event).toBe("tool-complete");
        expect(parsed.tool).toBe("Bash");
        expect(typeof parsed.inputDigest).toBe("string");
        expect(typeof parsed.cwdHash).toBe("string");
        expect((parsed.inputPreview as string).length).toBeLessThanOrEqual(200);
      } finally {
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  }, 15_000);
});
