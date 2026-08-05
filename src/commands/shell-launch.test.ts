// Flow 112 — T6 / AC12: the TUI launch path's credential + selection bootstrap.
//
// `src/commands/shell.test.ts` stays untouched (AC15 pins it "unmodified"), so
// the new coverage lives here.
//
// The bug this closes is real and user-visible: `loadShellConfig()` /
// `applySavedApiKeys()` were called ONLY inside the agent-only TUI branch, and
// the launch guard excluded `--chat`. A provider key entered through `/connect`
// was written to `auth.json` and then invisible to `keryx shell --chat`, which
// fell back to the offline no-op provider with a "…_API_KEY is not set" notice.
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseShellSurface, parseShellCliFlags, resolveTuiStartup } from "./shell";
import type { DetectedProvider } from "./select";

/** A env var name no other test or real environment uses. */
const ENV_KEY = "KERYX_FLOW112_FAKE_API_KEY";

async function withConfigDir(
  config: Record<string, unknown>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "keryx-shell-launch-"));
  const previous = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  try {
    await writeFile(join(dir, "auth.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
    await run(dir);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

const never = (): Promise<DetectedProvider[]> => {
  throw new Error("providers must not be detected when a saved selection exists");
};

test("AC12: `--chat` parses as a MODE flag, and only `--no-tui` clears wantTui", () => {
  const chat = parseShellCliFlags(["--chat"]);
  expect(chat.modeFlag).toBe(false);
  // NOTE: `wantTui: true` for `--chat` is NOT evidence of the AC12 fix — the
  // parser always returned that. The exclusion lived in the launch guard, which
  // `chooseShellSurface` (next test) is what actually pins.
  expect(chat.wantTui).toBe(true);

  // The explicit opt-outs still work, and still reach the readline fallback.
  expect(parseShellCliFlags(["--chat", "--no-tui"]).wantTui).toBe(false);
  expect(parseShellCliFlags(["--agent"]).modeFlag).toBe(true);
  expect(parseShellCliFlags([]).modeFlag).toBeUndefined();
});

test("AC12: the launch guard sends `--chat` to the TUI chat surface, not past the TUI", () => {
  const surfaceFor = (args: string[], isTty = true): string =>
    chooseShellSurface(parseShellCliFlags(args), isTty);

  // THE headline claim: with a TTY, `--chat` reaches `launchTuiChatShell`. The
  // pre-fix guard (`… && modeFlag !== false`) returned the readline shell here,
  // which is exactly what no test covered.
  expect(surfaceFor(["--chat"])).toBe("tui-chat");

  // Agent is the default and stays the default; `--agent` is explicit agreement.
  expect(surfaceFor([])).toBe("tui-agent");
  expect(surfaceFor(["--agent"])).toBe("tui-agent");
  expect(surfaceFor(["--tui"])).toBe("tui-agent");

  // `--no-tui` is the ONLY flag that opts out of the TUI — in both modes.
  expect(surfaceFor(["--no-tui"])).toBe("readline");
  expect(surfaceFor(["--chat", "--no-tui"])).toBe("readline");
  expect(surfaceFor(["--agent", "--no-tui"])).toBe("readline");

  // …and without a TTY there is no TUI to dispatch to, whatever the flags say.
  expect(surfaceFor([], false)).toBe("readline");
  expect(surfaceFor(["--chat"], false)).toBe("readline");
  expect(surfaceFor(["--agent", "--tui"], false)).toBe("readline");
});

test("AC12: a provider key saved by /connect is applied to the environment at launch", async () => {
  await withConfigDir(
    {
      provider: "openrouter",
      model: "some/model",
      apiKeys: { [ENV_KEY]: "sk-saved-by-connect" },
    },
    async (dir) => {
      expect(process.env[ENV_KEY]).toBeUndefined(); // the bug's starting state

      const startup = await resolveTuiStartup({ detect: never, configDir: dir });

      // The credential is now in the environment the provider factory reads …
      expect(startup.appliedKeys).toContain(ENV_KEY);
      expect(process.env[ENV_KEY]).toBe("sk-saved-by-connect");
      // … and the saved selection is reused instead of re-detecting providers.
      expect(startup.initial).toEqual({ provider: "openrouter", model: "some/model" });
      expect(startup.detected).toEqual([]);
    },
  );
});

test("AC12: an env var already set by the user always wins over the saved key", async () => {
  await withConfigDir({ apiKeys: { [ENV_KEY]: "sk-from-disk" } }, async (dir) => {
    process.env[ENV_KEY] = "sk-from-environment";
    const startup = await resolveTuiStartup({
      providerArg: "anthropic",
      modelArg: "claude-x",
      detect: never,
      configDir: dir,
    });
    expect(process.env[ENV_KEY]).toBe("sk-from-environment");
    expect(startup.appliedKeys).not.toContain(ENV_KEY);
    // Explicit flags outrank the persisted selection.
    expect(startup.initial).toEqual({ provider: "anthropic", model: "claude-x" });
  });
});

test("AC12: with nothing persisted, providers are detected and no selection is assumed", async () => {
  await withConfigDir({}, async (dir) => {
    const detected: DetectedProvider[] = [{ name: "ollama", models: ["llama3"] }];
    const startup = await resolveTuiStartup({
      detect: async () => detected,
      configDir: dir,
    });
    expect(startup.initial).toBeUndefined();
    expect(startup.detected).toEqual(detected);
    expect(startup.appliedKeys).not.toContain(ENV_KEY);
  });
});

test("AC12: `--base-url` is carried into the reused selection", async () => {
  await withConfigDir({ provider: "ollama", model: "llama3" }, async (dir) => {
    const startup = await resolveTuiStartup({
      baseUrl: "http://127.0.0.1:11434/v1",
      detect: never,
      configDir: dir,
    });
    expect(startup.initial).toEqual({
      provider: "ollama",
      model: "llama3",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
  });
});
