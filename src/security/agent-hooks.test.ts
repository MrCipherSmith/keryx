import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  AGENT_CHECK_INPUT_COMMAND,
  AGENT_CHECK_OUTPUT_COMMAND,
  AGENT_HOOKS_SENTINEL,
  agentSettingsPath,
  installSecurityAgentHooks,
  uninstallSecurityAgentHooks,
} from "./agent-hooks";

type Settings = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
  _gdMetaproManaged?: unknown;
  [key: string]: unknown;
};

async function readSettings(root: string): Promise<Settings> {
  return JSON.parse(await readFile(agentSettingsPath(root), "utf8")) as Settings;
}

function commandsFor(settings: Settings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((group) =>
    (group.hooks ?? []).map((entry) => entry.command ?? ""),
  );
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-agent-hooks-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("installs security agent hooks into an absent settings file as valid JSON", async () => {
  await withTempDir(async (root) => {
    await installSecurityAgentHooks(root);

    const raw = await readFile(agentSettingsPath(root), "utf8");
    // Always valid JSON, 2-space indented.
    const settings = JSON.parse(raw) as Settings;
    expect(raw.endsWith("\n")).toBe(true);
    expect(commandsFor(settings, "UserPromptSubmit")).toContain(AGENT_CHECK_INPUT_COMMAND);
    expect(commandsFor(settings, "PreToolUse")).toContain(AGENT_CHECK_OUTPUT_COMMAND);
    const preToolUse = settings.hooks?.PreToolUse ?? [];
    expect(preToolUse.some((group) => group.matcher === "Write|Edit")).toBe(true);
    expect(settings._gdMetaproManaged).toEqual([AGENT_HOOKS_SENTINEL]);
  });
});

test("merges into a pre-populated settings file preserving user keys and hook entries", async () => {
  await withTempDir(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const userSettings = {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "user-prompt-logger" }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "user-bash-guard" }] },
        ],
        PostToolUse: [
          { matcher: "Write", hooks: [{ type: "command", command: "user-post-write" }] },
        ],
      },
    };
    await writeFile(
      agentSettingsPath(root),
      `${JSON.stringify(userSettings, null, 2)}\n`,
      "utf8",
    );

    await installSecurityAgentHooks(root);
    const settings = await readSettings(root);

    // User top-level keys survive.
    expect(settings.model).toBe("opus");
    expect((settings.permissions as { allow: string[] }).allow).toEqual(["Bash(ls:*)"]);
    // User hook entries survive alongside the injected security entries.
    expect(commandsFor(settings, "UserPromptSubmit")).toContain("user-prompt-logger");
    expect(commandsFor(settings, "UserPromptSubmit")).toContain(AGENT_CHECK_INPUT_COMMAND);
    expect(commandsFor(settings, "PreToolUse")).toContain("user-bash-guard");
    expect(commandsFor(settings, "PreToolUse")).toContain(AGENT_CHECK_OUTPUT_COMMAND);
    // An unrelated user hook event is untouched.
    expect(commandsFor(settings, "PostToolUse")).toEqual(["user-post-write"]);
  });
});

test("re-install is idempotent (no duplicate security entries)", async () => {
  await withTempDir(async (root) => {
    await installSecurityAgentHooks(root);
    await installSecurityAgentHooks(root);
    await installSecurityAgentHooks(root);
    const settings = await readSettings(root);

    const inputCount = commandsFor(settings, "UserPromptSubmit").filter(
      (command) => command === AGENT_CHECK_INPUT_COMMAND,
    ).length;
    const outputCount = commandsFor(settings, "PreToolUse").filter(
      (command) => command === AGENT_CHECK_OUTPUT_COMMAND,
    ).length;
    expect(inputCount).toBe(1);
    expect(outputCount).toBe(1);
    expect(settings._gdMetaproManaged).toEqual([AGENT_HOOKS_SENTINEL]);
  });
});

test("uninstall removes only managed entries and preserves user hooks", async () => {
  await withTempDir(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const userSettings = {
      model: "opus",
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "user-prompt-logger" }] },
        ],
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "user-bash-guard" }] },
        ],
      },
    };
    await writeFile(
      agentSettingsPath(root),
      `${JSON.stringify(userSettings, null, 2)}\n`,
      "utf8",
    );

    await installSecurityAgentHooks(root);
    await uninstallSecurityAgentHooks(root);
    const settings = await readSettings(root);

    // User model + hook entries remain; security entries gone; sentinel cleared.
    expect(settings.model).toBe("opus");
    expect(commandsFor(settings, "UserPromptSubmit")).toEqual(["user-prompt-logger"]);
    expect(commandsFor(settings, "PreToolUse")).toEqual(["user-bash-guard"]);
    expect(commandsFor(settings, "UserPromptSubmit")).not.toContain(AGENT_CHECK_INPUT_COMMAND);
    expect(commandsFor(settings, "PreToolUse")).not.toContain(AGENT_CHECK_OUTPUT_COMMAND);
    expect(settings._gdMetaproManaged).toBeUndefined();
  });
});
