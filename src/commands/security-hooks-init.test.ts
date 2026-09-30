import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { SECURITY_CHECK_INPUT_CLAUDE, SECURITY_CHECK_OUTPUT_CLAUDE } from "../integrations/service";
import { withCwd } from "../lib/test-cwd";
import { initCommand } from "./init";
import { updateCommand } from "./update";

const SECURITY_ONLY = [
  "--no-gdgraph",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
];

async function withProject(
  run: (root: string) => Promise<void>,
  options: { withGit?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sec-hooks-"));
  try {
    if (options.withGit !== false) {
      await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    }
    await withCwd(root, async () => {
    await run(root);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type ModuleEntry = { enabled: boolean; hooks?: { prePush?: string; agent?: string } };

async function readManifest(root: string): Promise<{ modules: { security: ModuleEntry } }> {
  return JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as { modules: { security: ModuleEntry } };
}

test("init installs a managed security pre-push block that coexists with testing + user content", async () => {
  await withProject(async (root) => {
    const prePushPath = path.join(root, ".git", "hooks", "pre-push");
    // Pre-existing user-authored pre-push content + an already-installed testing
    // managed block. Neither must be lost when the security block is merged in.
    await writeFile(
      prePushPath,
      [
        "#!/usr/bin/env sh",
        "echo 'user pre-push guard'",
        "",
        "# keryx:testing-pre-push:begin",
        "keryx test run --changed --strict",
        "# keryx:testing-pre-push:end",
        "",
      ].join("\n"),
      "utf8",
    );

    await initCommand(["--yes", ...SECURITY_ONLY]);

    const hook = await readFile(prePushPath, "utf8");
    expect(hook).toContain("echo 'user pre-push guard'");
    expect(hook).toContain("# keryx:testing-pre-push:begin");
    expect(hook).toContain("# keryx:security-pre-push:begin");
    expect(hook).toContain("# keryx:security-pre-push:end");
    expect(hook).toContain("security scan");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.prePush).toBe(".git/hooks/pre-push");
  });
});

test("init --no-security-hook skips the pre-push hook but keeps the agent hook", async () => {
  await withProject(async (root) => {
    await initCommand(["--yes", "--no-security-hook", ...SECURITY_ONLY]);

    const prePushPath = path.join(root, ".git", "hooks", "pre-push");
    let hook: string;
    try {
      hook = await readFile(prePushPath, "utf8");
    } catch {
      hook = "";
    }
    expect(hook).not.toContain("security-pre-push");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.prePush).toBeUndefined();
    expect(manifest.modules.security.hooks?.agent).toBe(".claude/settings.local.json");
  });
});

test("init installs merge-safe .claude/settings.local.json security hooks", async () => {
  await withProject(async (root) => {
    await initCommand(["--yes", ...SECURITY_ONLY]);

    const settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    const inputCommands = (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) =>
      (group.hooks ?? []).map((entry) => entry.command),
    );
    const outputCommands = (settings.hooks?.PreToolUse ?? []).flatMap((group) =>
      (group.hooks ?? []).map((entry) => entry.command),
    );
    // `--runtime claude` is what makes a refusal actually refuse: without it the
    // command exits 1, which Claude Code treats as a non-blocking error. Asserted
    // as a whole string rather than a prefix, so dropping the flag is red.
    expect(inputCommands).toContain("keryx security check-input --source untrusted-external --runtime claude");
    expect(outputCommands).toContain("keryx security check-output --runtime claude");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.agent).toBe(".claude/settings.local.json");
  });
});

test("init merges security hooks into a pre-populated .claude/settings.local.json and leaves the user's settings.json alone", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const teamSettings = '{ "model": "opus", "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "team-hook" } ] } ] } }\n';
    await writeFile(path.join(root, ".claude", "settings.json"), teamSettings, "utf8");
    await writeFile(
      path.join(root, ".claude", "settings.local.json"),
      `${JSON.stringify(
        {
          model: "sonnet",
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: "user-logger" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await initCommand(["--yes", ...SECURITY_ONLY]);

    const settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    ) as {
      model?: string;
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const inputCommands = (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) =>
      (group.hooks ?? []).map((entry) => entry.command),
    );
    expect(settings.model).toBe("sonnet");
    expect(inputCommands).toContain("user-logger");
    // `--runtime claude` is what makes a refusal actually refuse: without it the
    // command exits 1, which Claude Code treats as a non-blocking error. Asserted
    // as a whole string rather than a prefix, so dropping the flag is red.
    expect(inputCommands).toContain("keryx security check-input --source untrusted-external --runtime claude");
    expect(await readFile(path.join(root, ".claude", "settings.json"), "utf8")).toBe(teamSettings);
  });
});

test("init --no-security-agent-hook skips the Claude settings hooks", async () => {
  await withProject(async (root) => {
    await initCommand(["--yes", "--no-security-agent-hook", ...SECURITY_ONLY]);

    expect(existsSync(path.join(root, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(path.join(root, ".claude", "settings.json"))).toBe(false);

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.agent).toBeUndefined();
  });
});

test("re-init with --no-security-agent-hook removes the .claude security hooks but keeps user entries + the pre-push blocks", async () => {
  await withProject(async (root) => {
    // A pre-existing user hook in .claude/settings.json that must survive.
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.local.json"),
      `${JSON.stringify(
        {
          model: "sonnet",
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: "user-logger" }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    // A pre-existing user pre-push line + a testing managed block that must
    // survive the security block being stripped.
    const prePushPath = path.join(root, ".git", "hooks", "pre-push");
    await writeFile(
      prePushPath,
      [
        "#!/usr/bin/env sh",
        "echo 'user pre-push guard'",
        "",
        "# keryx:testing-pre-push:begin",
        "keryx_testing_pre_push || exit $?",
        "# keryx:testing-pre-push:end",
        "",
      ].join("\n"),
      "utf8",
    );

    // First install: agent hook + pre-push are live.
    await initCommand(["--yes", ...SECURITY_ONLY]);
    let settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(JSON.stringify(settings)).toContain("security-agent-hooks");
    expect((await readManifest(root)).modules.security.hooks?.agent).toBe(
      ".claude/settings.local.json",
    );

    // Disable ONLY the agent hook; the pre-push hook stays enabled.
    await initCommand(["--yes", "--no-security-agent-hook", ...SECURITY_ONLY]);

    settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"),
    ) as Record<string, unknown>;
    const settingsText = JSON.stringify(settings);
    // Security sentinel + managed entries are gone...
    expect(settingsText).not.toContain("security-agent-hooks");
    expect(settingsText).not.toContain("keryx security check-input");
    // ...but the user entry and unrelated keys are preserved.
    expect(settingsText).toContain("user-logger");
    expect(settings.model).toBe("sonnet");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.agent).toBeUndefined();
    expect(manifest.modules.security.hooks?.prePush).toBe(".git/hooks/pre-push");

    const hook = await readFile(prePushPath, "utf8");
    expect(hook).toContain("echo 'user pre-push guard'");
    expect(hook).toContain("# keryx:testing-pre-push:begin");
    expect(hook).toContain("# keryx:security-pre-push:begin");
  });
});

test("re-init with --no-security strips the security pre-push block but keeps the testing block + user content", async () => {
  await withProject(async (root) => {
    const prePushPath = path.join(root, ".git", "hooks", "pre-push");
    await writeFile(
      prePushPath,
      [
        "#!/usr/bin/env sh",
        "echo 'user pre-push guard'",
        "",
        "# keryx:testing-pre-push:begin",
        "keryx_testing_pre_push || exit $?",
        "# keryx:testing-pre-push:end",
        "",
      ].join("\n"),
      "utf8",
    );

    // First install the security hooks.
    await initCommand(["--yes", ...SECURITY_ONLY]);
    expect(await readFile(prePushPath, "utf8")).toContain(
      "# keryx:security-pre-push:begin",
    );

    // Disable security entirely.
    await initCommand([
      "--yes",
      "--no-security",
      "--no-gdgraph",
      "--no-gdctx",
      "--no-gdwiki",
      "--no-gdskills",
      "--no-health",
      "--no-testing",
      "--no-memory",
      "--no-tasks",
    ]);

    const hook = await readFile(prePushPath, "utf8");
    // Security block removed...
    expect(hook).not.toContain("security-pre-push");
    // ...testing block + user content preserved.
    expect(hook).toContain("# keryx:testing-pre-push:begin");
    expect(hook).toContain("echo 'user pre-push guard'");

    // The .claude agent hooks are gone too (the settings file may remain, but it
    // must no longer carry the security sentinel).
    let settingsRaw: string;
    try {
      settingsRaw = await readFile(path.join(root, ".claude", "settings.local.json"), "utf8");
    } catch {
      settingsRaw = "";
    }
    expect(settingsRaw).not.toContain("security-agent-hooks");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.enabled).toBe(false);
  });
});

test("init --no-security installs neither security hook", async () => {
  await withProject(async (root) => {
    await initCommand([
      "--yes",
      "--no-security",
      "--no-gdgraph",
      "--no-gdctx",
      "--no-gdwiki",
      "--no-gdskills",
      "--no-health",
      "--no-testing",
      "--no-memory",
      "--no-tasks",
    ]);

    const prePushPath = path.join(root, ".git", "hooks", "pre-push");
    let prePush: string;
    try {
      prePush = await readFile(prePushPath, "utf8");
    } catch {
      prePush = "";
    }
    expect(prePush).not.toContain("security-pre-push");

    expect(existsSync(path.join(root, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(path.join(root, ".claude", "settings.json"))).toBe(false);

    const manifest = await readManifest(root);
    expect(manifest.modules.security.enabled).toBe(false);
  });
});

// Flow 361 T8: in a real repository the managed hooks never reach the tracked
// `.claude/settings.json` — not on init, not on the update after it.
function gitInHooksRepo(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

async function committedRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-sec-hooks-git-"));
  gitInHooksRepo(root, ["init", "-q"]);
  gitInHooksRepo(root, ["config", "user.email", "test@test.com"]);
  gitInHooksRepo(root, ["config", "user.name", "test"]);
  // The developer's global excludes must not answer for the fixture.
  gitInHooksRepo(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content, "utf8");
  }
  gitInHooksRepo(root, ["add", "--", ...Object.keys(files)]);
  gitInHooksRepo(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

function managedCommands(settingsText: string): string[] {
  const settings = JSON.parse(settingsText) as {
    hooks?: Record<string, Array<{ _keryxManaged?: string; hooks?: Array<{ command?: string }> }>>;
  };
  return Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.filter((group) => typeof group._keryxManaged === "string").flatMap((group) => (group.hooks ?? []).map((hook) => `${event}: ${hook.command}`)),
  );
}

test("flow 361: fresh init then update put the managed hooks only in .claude/settings.local.json and keep settings.json out of git status (AC2, AC5)", async () => {
  const teamSettings = '{\n    "model": "sonnet"\n}\n';
  const root = await committedRepo({ "README.md": "readme\n", ".claude/settings.json": teamSettings });
  try {
    const assertLocalOnly = async () => {
      expect(await readFile(path.join(root, ".claude", "settings.json"), "utf8")).toBe(teamSettings);
      expect(managedCommands(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"))).toEqual([
        "UserPromptSubmit: keryx security check-input --source untrusted-external --runtime claude",
        "PreToolUse: keryx security check-output --runtime claude",
      ]);
      const status = gitInHooksRepo(root, ["status", "--porcelain"]);
      expect(status).not.toContain(".claude/");
      expect(Bun.spawnSync(["git", "diff", "--quiet", "--", ".claude/settings.json"], { cwd: root }).exitCode).toBe(0);
      const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
        modules: { security: ModuleEntry };
        agentEntrypoints: { claudeSettings: unknown };
      };
      expect(manifest.modules.security.hooks?.agent).toBe(".claude/settings.local.json");
      expect(manifest.agentEntrypoints.claudeSettings).toEqual({ path: ".claude/settings.local.json", scope: "local" });
    };

    await withCwd(root, async () => {
      await initCommand(["--yes", ...SECURITY_ONLY]);
    });
    await assertLocalOnly();
    const afterInit = await readFile(path.join(root, ".claude", "settings.local.json"));

    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
    await assertLocalOnly();
    expect((await readFile(path.join(root, ".claude", "settings.local.json"))).equals(afterInit)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: init over managed hooks committed in HEAD keeps them in settings.json and records scope shared", async () => {
  const committed = `${JSON.stringify(
    SECURITY_CHECK_OUTPUT_CLAUDE.merge!(SECURITY_CHECK_INPUT_CLAUDE.merge!({ model: "sonnet" })),
    null,
    2,
  )}\n`;
  const root = await committedRepo({ "README.md": "readme\n", ".claude/settings.json": committed });
  try {
    await withCwd(root, async () => {
      await initCommand(["--yes", ...SECURITY_ONLY]);
    });

    expect(await readFile(path.join(root, ".claude", "settings.json"), "utf8")).toBe(committed);
    expect(existsSync(path.join(root, ".claude", "settings.local.json"))).toBe(false);
    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: { security: ModuleEntry };
      agentEntrypoints: { claudeSettings: unknown };
    };
    expect(manifest.modules.security.hooks?.agent).toBe(".claude/settings.json");
    expect(manifest.agentEntrypoints.claudeSettings).toEqual({ path: ".claude/settings.json", scope: "shared" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: init --preview writes neither Claude settings file", async () => {
  const root = await committedRepo({ "README.md": "readme\n" });
  try {
    await withCwd(root, async () => {
      await initCommand(["--yes", "--preview", ...SECURITY_ONLY]);
    });
    expect(existsSync(path.join(root, ".claude"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
