import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { installRuntimeHook, uninstallRuntimeHook } from "./hook-install";
import {
  CLAUDE_RUNTIME,
  CTX_HOOK_SENTINEL,
  preToolUseMatcher,
  getRuntime,
  resolveRuntimes,
  runtimeIds,
} from "./runtimes";

const CLAUDE_COMMAND = "keryx ctx hook claude";

type Settings = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }>; _keryxManaged?: string }>>;
  _keryxManaged?: unknown;
  [key: string]: unknown;
};

function claudeSettingsPath(root: string): string {
  return CLAUDE_RUNTIME.locate(root);
}

async function readSettings(root: string): Promise<Settings> {
  return JSON.parse(await readFile(claudeSettingsPath(root), "utf8")) as Settings;
}

function preToolUse(settings: Settings) {
  return settings.hooks?.PreToolUse ?? [];
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ctx-hook-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("registry resolves known/unknown/unsupported runtimes", () => {
  expect(runtimeIds()).toContain("claude");
  expect(getRuntime("claude")).toBeDefined();
  const { runtimes, unknown, unsupported } = resolveRuntimes(["claude", "bogus", "zed"]);
  expect(runtimes.map((r) => r.id)).toEqual(["claude"]);
  expect(unknown).toEqual(["bogus"]);
  expect(unsupported).toEqual(["zed"]);
  expect(resolveRuntimes(["all"]).runtimes.map((r) => r.id)).toEqual(runtimeIds());
});

test("installs the Bash routing guard into an absent settings file", async () => {
  await withTempDir(async (root) => {
    const { errors } = await installRuntimeHook(root, CLAUDE_RUNTIME);
    expect(errors).toEqual([]);
    const raw = await readFile(claudeSettingsPath(root), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const settings = JSON.parse(raw) as Settings;

    const group = preToolUse(settings).find((g) => g.matcher === preToolUseMatcher(CLAUDE_RUNTIME));
    expect(group).toBeDefined();
    expect(group?._keryxManaged).toBe(CTX_HOOK_SENTINEL);
    expect(group?.hooks?.[0]?.command).toBe(CLAUDE_COMMAND);
    expect(settings._keryxManaged).toEqual([CTX_HOOK_SENTINEL]);
  });
});

test("is idempotent — re-install does not duplicate the managed group", async () => {
  await withTempDir(async (root) => {
    await installRuntimeHook(root, CLAUDE_RUNTIME);
    await installRuntimeHook(root, CLAUDE_RUNTIME);
    const settings = await readSettings(root);
    const managed = preToolUse(settings).filter((g) => g._keryxManaged === CTX_HOOK_SENTINEL);
    expect(managed).toHaveLength(1);
    expect((settings._keryxManaged as string[]).filter((v) => v === CTX_HOOK_SENTINEL)).toHaveLength(1);
  });
});

test("preserves user keys and coexists with security hooks", async () => {
  await withTempDir(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const userSettings = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: "keryx security check-output" }],
            _keryxManaged: "security-agent-hooks",
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "keryx security check-input --source untrusted-external" }],
            _keryxManaged: "security-agent-hooks",
          },
        ],
      },
      _keryxManaged: ["security-agent-hooks"],
    };
    await writeFile(claudeSettingsPath(root), `${JSON.stringify(userSettings, null, 2)}\n`, "utf8");

    await installRuntimeHook(root, CLAUDE_RUNTIME);
    const settings = await readSettings(root);

    expect(settings.model).toBe("opus");
    const security = preToolUse(settings).find((g) => g.matcher === "Write|Edit");
    expect(security?._keryxManaged).toBe("security-agent-hooks");
    expect(settings.hooks?.UserPromptSubmit?.[0]?._keryxManaged).toBe("security-agent-hooks");
    expect(preToolUse(settings).some((g) => g.matcher === preToolUseMatcher(CLAUDE_RUNTIME))).toBe(true);
    expect(settings._keryxManaged).toEqual(["security-agent-hooks", CTX_HOOK_SENTINEL]);
  });
});

test("uninstall removes only the ctx group, leaving security hooks intact", async () => {
  await withTempDir(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const userSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: "keryx security check-output" }],
            _keryxManaged: "security-agent-hooks",
          },
        ],
      },
      _keryxManaged: ["security-agent-hooks"],
    };
    await writeFile(claudeSettingsPath(root), `${JSON.stringify(userSettings, null, 2)}\n`, "utf8");

    await installRuntimeHook(root, CLAUDE_RUNTIME);
    const removed = await uninstallRuntimeHook(root, CLAUDE_RUNTIME);
    expect(removed).toBe(true);

    const settings = await readSettings(root);
    expect(preToolUse(settings).some((g) => g.matcher === preToolUseMatcher(CLAUDE_RUNTIME))).toBe(false);
    expect(preToolUse(settings).some((g) => g.matcher === "Write|Edit")).toBe(true);
    expect(settings._keryxManaged).toEqual(["security-agent-hooks"]);
  });
});

test("uninstall on an absent settings file returns false", async () => {
  await withTempDir(async (root) => {
    expect(await uninstallRuntimeHook(root, CLAUDE_RUNTIME)).toBe(false);
  });
});

test("an install over a stale guard says what it replaced", async () => {
  // The drift check used to run after the merge that erases the drift, so it
  // could never fire in production. This is the assertion that would have caught
  // that: it drives the real installer over a real Bash-only settings file.
  await withTempDir(async (root) => {
    const file = claudeSettingsPath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [{ type: "command", command: CLAUDE_COMMAND }],
                _keryxManaged: CTX_HOOK_SENTINEL,
              },
            ],
          },
          _keryxManaged: [CTX_HOOK_SENTINEL],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await installRuntimeHook(root, CLAUDE_RUNTIME);
    expect(result.errors).toEqual([]);
    expect(result.upgraded).toBeDefined();
    expect(result.upgraded).toContain("Bash|Grep");

    // And the install actually rewrote it, so a second run has nothing to say.
    const second = await installRuntimeHook(root, CLAUDE_RUNTIME);
    expect(second.upgraded).toBeUndefined();
    const settings = JSON.parse(await readFile(file, "utf8")) as Settings;
    expect(preToolUse(settings).some((g) => g.matcher === preToolUseMatcher(CLAUDE_RUNTIME))).toBe(true);
  });
});

test("uninstall removes a guard written in every shape any build ever wrote", async () => {
  // The shape test added for antigravity narrowed what counts as OWNED, so the
  // regression question is whether an older install becomes invisible to
  // removal. It does not: removal keys on the managed sentinel, never on the
  // matcher, the entry type, or the group shape. Asserted by driving the real
  // uninstaller over each shape rather than by reading stripManaged.
  const SHAPES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["the original Bash-only matcher", {
      matcher: "Bash",
      hooks: [{ type: "command", command: CLAUDE_COMMAND }],
      _keryxManaged: CTX_HOOK_SENTINEL,
    }],
    ["the current matcher", {
      matcher: "Bash|Grep",
      hooks: [{ type: "command", command: CLAUDE_COMMAND }],
      _keryxManaged: CTX_HOOK_SENTINEL,
    }],
    ["an inert type:prompt entry", {
      matcher: "Bash|Grep",
      hooks: [{ type: "prompt", command: CLAUDE_COMMAND }],
      _keryxManaged: CTX_HOOK_SENTINEL,
    }],
    ["a flat entry", {
      matcher: "Bash",
      command: CLAUDE_COMMAND,
      _keryxManaged: CTX_HOOK_SENTINEL,
    }],
    ["no matcher at all", {
      hooks: [{ type: "command", command: CLAUDE_COMMAND }],
      _keryxManaged: CTX_HOOK_SENTINEL,
    }],
  ];

  for (const [label, group] of SHAPES) {
    await withTempDir(async (root) => {
      const file = claudeSettingsPath(root);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `${JSON.stringify({ hooks: { PreToolUse: [group] }, _keryxManaged: [CTX_HOOK_SENTINEL] }, null, 2)}\n`,
        "utf8",
      );

      const removed = await uninstallRuntimeHook(root, CLAUDE_RUNTIME);
      expect(removed, label).toBe(true);
      const settings = JSON.parse(await readFile(file, "utf8")) as Settings;
      expect(preToolUse(settings), label).toHaveLength(0);
    });
  }
});
