import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { expect, test } from "bun:test";
import {
  CLAUDE_ORIENT,
  CURSOR_ORIENT,
  CODEX_ORIENT,
  ORIENT_SENTINEL,
  orientRuntimeIds,
  resolveOrientRuntimes,
} from "./orient-runtimes";

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-orient-rt-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A tiny inline installer mirroring src/commands/orient.ts install path.
async function install(root: string, runtime: typeof CLAUDE_ORIENT): Promise<Record<string, unknown>> {
  const file = runtime.locate(root);
  await mkdir(path.dirname(file), { recursive: true });
  const merged = runtime.merge({});
  await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

test("resolve classifies verified / unknown / unsupported (windsurf, zed)", () => {
  expect(orientRuntimeIds()).toEqual(["claude", "codex", "cursor"]);
  const { runtimes, unknown, unsupported } = resolveOrientRuntimes(["claude", "windsurf", "bogus", "zed", "opencode"]);
  expect(runtimes.map((r) => r.id)).toEqual(["claude"]);
  expect(unknown).toEqual(["bogus"]);
  expect(unsupported.sort()).toEqual(["opencode", "windsurf", "zed"]);
});

test("claude formats orientation as plain stdout", () => {
  expect(CLAUDE_ORIENT.format("HELLO")).toBe("HELLO");
});

test("cursor formats orientation as { additional_context } JSON", () => {
  const parsed = JSON.parse(CURSOR_ORIENT.format("HELLO"));
  expect(parsed.additional_context).toBe("HELLO");
});

test("claude installs a UserPromptSubmit orientation hook", async () => {
  await withTempDir(async (root) => {
    const s = (await install(root, CLAUDE_ORIENT)) as {
      hooks: { UserPromptSubmit: Array<{ hooks?: Array<{ command?: string }>; _keryxManaged?: string }> };
      _keryxManaged?: string[];
    };
    const group = s.hooks.UserPromptSubmit[0];
    expect(group?.hooks?.[0]?.command).toBe("keryx orient claude");
    expect(group?._keryxManaged).toBe(ORIENT_SENTINEL);
    expect(s._keryxManaged).toEqual([ORIENT_SENTINEL]);
    expect(CLAUDE_ORIENT.validate(s)).toEqual([]);
  });
});

test("codex installs into .codex/hooks.json UserPromptSubmit", async () => {
  await withTempDir(async (root) => {
    const s = await install(root, CODEX_ORIENT);
    expect(CODEX_ORIENT.locate(root)).toBe(path.join(root, ".codex", "hooks.json"));
    expect(CODEX_ORIENT.validate(s)).toEqual([]);
  });
});

test("cursor installs version:1 + sessionStart entry", async () => {
  await withTempDir(async (root) => {
    const s = (await install(root, CURSOR_ORIENT)) as {
      version?: number;
      hooks: { sessionStart: Array<{ command?: string }> };
    };
    expect(s.version).toBe(1);
    expect(s.hooks.sessionStart[0]?.command).toBe("keryx orient cursor");
    expect(CURSOR_ORIENT.validate(s as Record<string, unknown>)).toEqual([]);
  });
});

test("strip removes the managed orientation group and sentinel", () => {
  const merged = CLAUDE_ORIENT.merge({
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "keryx security check-input" }], _keryxManaged: "security-agent-hooks" },
      ],
    },
    _keryxManaged: ["security-agent-hooks"],
  });
  const stripped = CLAUDE_ORIENT.strip(merged) as {
    hooks?: { UserPromptSubmit?: Array<{ _keryxManaged?: string }> };
    _keryxManaged?: string[];
  };
  // security hook preserved, orient hook gone
  expect(stripped.hooks?.UserPromptSubmit?.some((g) => g._keryxManaged === "security-agent-hooks")).toBe(true);
  expect(stripped.hooks?.UserPromptSubmit?.some((g) => g._keryxManaged === ORIENT_SENTINEL)).toBe(false);
  expect(stripped._keryxManaged).toEqual(["security-agent-hooks"]);
});
