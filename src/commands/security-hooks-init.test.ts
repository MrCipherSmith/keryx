import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { initCommand } from "./init";

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
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-sec-hooks-"));
  const previousCwd = process.cwd();
  try {
    if (options.withGit !== false) {
      await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    }
    process.chdir(root);
    await run(root);
  } finally {
    process.chdir(previousCwd);
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
        "# gd-metapro:testing-pre-push:begin",
        "gd-metapro test run --changed --strict",
        "# gd-metapro:testing-pre-push:end",
        "",
      ].join("\n"),
      "utf8",
    );

    await initCommand(["--yes", ...SECURITY_ONLY]);

    const hook = await readFile(prePushPath, "utf8");
    expect(hook).toContain("echo 'user pre-push guard'");
    expect(hook).toContain("# gd-metapro:testing-pre-push:begin");
    expect(hook).toContain("# gd-metapro:security-pre-push:begin");
    expect(hook).toContain("# gd-metapro:security-pre-push:end");
    expect(hook).toContain("security scan");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.prePush).toBe(".git/hooks/pre-push");
  });
});

test("init --no-security-hook skips the pre-push hook but keeps the agent hook", async () => {
  await withProject(async (root) => {
    await initCommand(["--yes", "--no-security-hook", ...SECURITY_ONLY]);

    const prePushPath = path.join(root, ".git", "hooks", "pre-push");
    let hook = "";
    try {
      hook = await readFile(prePushPath, "utf8");
    } catch {
      hook = "";
    }
    expect(hook).not.toContain("security-pre-push");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.prePush).toBeUndefined();
    expect(manifest.modules.security.hooks?.agent).toBe(".claude/settings.json");
  });
});

test("init installs merge-safe .claude/settings.json security hooks", async () => {
  await withProject(async (root) => {
    await initCommand(["--yes", ...SECURITY_ONLY]);

    const settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.json"), "utf8"),
    ) as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
    const inputCommands = (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) =>
      (group.hooks ?? []).map((entry) => entry.command),
    );
    const outputCommands = (settings.hooks?.PreToolUse ?? []).flatMap((group) =>
      (group.hooks ?? []).map((entry) => entry.command),
    );
    expect(inputCommands).toContain("gd-metapro security check-input --source untrusted-external");
    expect(outputCommands).toContain("gd-metapro security check-output");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.agent).toBe(".claude/settings.json");
  });
});

test("init merges security hooks into a pre-populated .claude/settings.json", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.json"),
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
      await readFile(path.join(root, ".claude", "settings.json"), "utf8"),
    ) as {
      model?: string;
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const inputCommands = (settings.hooks?.UserPromptSubmit ?? []).flatMap((group) =>
      (group.hooks ?? []).map((entry) => entry.command),
    );
    expect(settings.model).toBe("sonnet");
    expect(inputCommands).toContain("user-logger");
    expect(inputCommands).toContain("gd-metapro security check-input --source untrusted-external");
  });
});

test("init --no-security-agent-hook skips the .claude/settings.json hooks", async () => {
  await withProject(async (root) => {
    await initCommand(["--yes", "--no-security-agent-hook", ...SECURITY_ONLY]);

    let exists = true;
    try {
      await readFile(path.join(root, ".claude", "settings.json"), "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.agent).toBeUndefined();
  });
});

test("re-init with --no-security-agent-hook removes the .claude security hooks but keeps user entries + the pre-push blocks", async () => {
  await withProject(async (root) => {
    // A pre-existing user hook in .claude/settings.json that must survive.
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(
      path.join(root, ".claude", "settings.json"),
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
        "# gd-metapro:testing-pre-push:begin",
        "gd_metapro_testing_pre_push || exit $?",
        "# gd-metapro:testing-pre-push:end",
        "",
      ].join("\n"),
      "utf8",
    );

    // First install: agent hook + pre-push are live.
    await initCommand(["--yes", ...SECURITY_ONLY]);
    let settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(JSON.stringify(settings)).toContain("security-agent-hooks");
    expect((await readManifest(root)).modules.security.hooks?.agent).toBe(
      ".claude/settings.json",
    );

    // Disable ONLY the agent hook; the pre-push hook stays enabled.
    await initCommand(["--yes", "--no-security-agent-hook", ...SECURITY_ONLY]);

    settings = JSON.parse(
      await readFile(path.join(root, ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    const settingsText = JSON.stringify(settings);
    // Security sentinel + managed entries are gone...
    expect(settingsText).not.toContain("security-agent-hooks");
    expect(settingsText).not.toContain("gd-metapro security check-input");
    // ...but the user entry and unrelated keys are preserved.
    expect(settingsText).toContain("user-logger");
    expect(settings.model).toBe("sonnet");

    const manifest = await readManifest(root);
    expect(manifest.modules.security.hooks?.agent).toBeUndefined();
    expect(manifest.modules.security.hooks?.prePush).toBe(".git/hooks/pre-push");

    const hook = await readFile(prePushPath, "utf8");
    expect(hook).toContain("echo 'user pre-push guard'");
    expect(hook).toContain("# gd-metapro:testing-pre-push:begin");
    expect(hook).toContain("# gd-metapro:security-pre-push:begin");
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
        "# gd-metapro:testing-pre-push:begin",
        "gd_metapro_testing_pre_push || exit $?",
        "# gd-metapro:testing-pre-push:end",
        "",
      ].join("\n"),
      "utf8",
    );

    // First install the security hooks.
    await initCommand(["--yes", ...SECURITY_ONLY]);
    expect(await readFile(prePushPath, "utf8")).toContain(
      "# gd-metapro:security-pre-push:begin",
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
    expect(hook).toContain("# gd-metapro:testing-pre-push:begin");
    expect(hook).toContain("echo 'user pre-push guard'");

    // The .claude agent hooks are gone too (the settings file may remain, but it
    // must no longer carry the security sentinel).
    let settingsRaw = "";
    try {
      settingsRaw = await readFile(path.join(root, ".claude", "settings.json"), "utf8");
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
    let prePush = "";
    try {
      prePush = await readFile(prePushPath, "utf8");
    } catch {
      prePush = "";
    }
    expect(prePush).not.toContain("security-pre-push");

    let agentExists = true;
    try {
      await readFile(path.join(root, ".claude", "settings.json"), "utf8");
    } catch {
      agentExists = false;
    }
    expect(agentExists).toBe(false);

    const manifest = await readManifest(root);
    expect(manifest.modules.security.enabled).toBe(false);
  });
});
