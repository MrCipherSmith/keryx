import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertArmContext,
  keryxHooksIn,
  stripKeryxHooks,
  CLAUDE_SETTINGS,
  SUBSTANTIVE_CONTEXT,
} from "./retrieval-ablation";

const CONTEXT_PATHS = [".metaproject", "AGENTS.md", "CLAUDE.md"];

async function tree(over: {
  settings?: unknown;
  metaproject?: boolean;
  agentsMd?: boolean;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-ablation-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  if (over.metaproject === true) {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "index.md"), "# routing\n", "utf8");
  }
  if (over.agentsMd === true) await writeFile(path.join(root, "AGENTS.md"), "# rules\n", "utf8");
  if (over.settings !== undefined) {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, CLAUDE_SETTINGS), JSON.stringify(over.settings, null, 2), "utf8");
  }
  return root;
}

// The real shape, copied from this repository's own .claude/settings.json.
const KERYX_SETTINGS = {
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [{ type: "command", command: "keryx security check-input" }],
        _keryxManaged: "security-agent-hooks",
      },
    ],
    PreToolUse: [
      {
        matcher: "Bash|Grep",
        hooks: [{ type: "command", command: "keryx ctx hook claude" }],
        _keryxManaged: "ctx-agent-hooks",
      },
    ],
  },
  _keryxManaged: ["ctx-agent-hooks", "security-agent-hooks"],
};

// The intended primary repository's own guard. Not keryx's, fires on both arms.
const PROJECT_SETTINGS = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "node scripts/claude-guard.mjs bash" }] },
    ],
  },
};

describe("stripKeryxHooks", () => {
  test("removes keryx's hooks and the file with them when nothing else is configured", async () => {
    const root = await tree({ settings: KERYX_SETTINGS });
    try {
      await stripKeryxHooks(root);
      expect(existsSync(path.join(root, CLAUDE_SETTINGS))).toBe(false);
      expect(await keryxHooksIn(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("leaves the project's OWN hooks alone", async () => {
    // Deleting `.claude/` wholesale would strip the project's guard from the
    // control arm only — the same asymmetry that caused this fix, reversed.
    const root = await tree({
      settings: {
        hooks: {
          PreToolUse: [
            ...PROJECT_SETTINGS.hooks.PreToolUse,
            { matcher: "Bash|Grep", hooks: [], _keryxManaged: "ctx-agent-hooks" },
          ],
        },
      },
    });
    try {
      await stripKeryxHooks(root);
      const left = JSON.parse(await readFile(path.join(root, CLAUDE_SETTINGS), "utf8"));
      expect(left.hooks.PreToolUse).toHaveLength(1);
      expect(JSON.stringify(left)).toContain("claude-guard.mjs");
      expect(JSON.stringify(left)).not.toContain("_keryxManaged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a settings file with no hooks at all is untouched", async () => {
    const root = await tree({ settings: { model: "opus" } });
    try {
      await stripKeryxHooks(root);
      const left = JSON.parse(await readFile(path.join(root, CLAUDE_SETTINGS), "utf8"));
      expect(left.model).toBe("opus");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no settings file is not an error", async () => {
    const root = await tree({});
    try {
      await expect(stripKeryxHooks(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed settings are left as they are rather than rewritten", async () => {
    // An agent runtime cannot load this either, so there is no active hook to
    // remove; rewriting a file we failed to parse would be the worse outcome.
    const root = await mkdtemp(path.join(tmpdir(), "keryx-ablation-bad-"));
    try {
      await mkdir(path.join(root, ".claude"), { recursive: true });
      await writeFile(path.join(root, CLAUDE_SETTINGS), "{ not json", "utf8");
      await stripKeryxHooks(root);
      expect(await readFile(path.join(root, CLAUDE_SETTINGS), "utf8")).toBe("{ not json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("assertArmContext", () => {
  test("context-on without .metaproject is refused — the gitignored-primary case", async () => {
    // This is the assertion that would have stopped a fifty-task sweep on a
    // repository where `.metaproject/` is in .gitignore, before it spent
    // anything and before it produced a confident, wrong, negative result.
    const root = await tree({ agentsMd: true });
    try {
      await expect(assertArmContext(root, "context-on", CONTEXT_PATHS)).rejects.toThrow(
        /no \.metaproject\/ .* nothing under test/s,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("context-on with the context present passes", async () => {
    const root = await tree({ metaproject: true, agentsMd: true });
    try {
      await expect(assertArmContext(root, "context-on", CONTEXT_PATHS)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("context-off that still has the context is refused", async () => {
    const root = await tree({ metaproject: true });
    try {
      await expect(assertArmContext(root, "context-off", CONTEXT_PATHS)).rejects.toThrow(
        /ablation did not happen/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("context-off that still has keryx's hooks is refused", async () => {
    // The obstruction case: files gone, hook alive, control arm forbidden to
    // grep and redirected at a workspace that no longer exists.
    const root = await tree({ settings: KERYX_SETTINGS });
    try {
      await expect(assertArmContext(root, "context-off", CONTEXT_PATHS)).rejects.toThrow(
        /keryx-managed hooks/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("context-off keeping the project's own hooks is fine", async () => {
    const root = await tree({ settings: PROJECT_SETTINGS });
    try {
      await expect(assertArmContext(root, "context-off", CONTEXT_PATHS)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the substantive path is the one that carries the graph and wiki", () => {
    // AGENTS.md and CLAUDE.md are pointers into it; a tree with only those has
    // routing instructions that resolve to nothing.
    expect(SUBSTANTIVE_CONTEXT).toBe(".metaproject");
    expect(CONTEXT_PATHS).toContain(SUBSTANTIVE_CONTEXT);
  });
});
