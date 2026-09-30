import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { uniqueTestRoot } from "../lib/test-tmp";
import { decideLegacyEntrypointScope, resolveLegacyEntrypointTargets, settingsTextHasManagedHooks } from "./entrypoint-migration";
import { normalizeEntrypointTargets } from "./entrypoint-targets";

const BLOCK = "<!-- keryx:index -->\n## Metaproject\n<!-- /keryx:index -->\n";
const MANAGED_SETTINGS = `${JSON.stringify(
  {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] },
        { _keryxManaged: "security-agent-hooks", matcher: "Write", hooks: [{ type: "command", command: "keryx security check-input" }] },
      ],
    },
    _keryxManaged: ["security-agent-hooks"],
  },
  null,
  2,
)}\n`;
const PLAIN_SETTINGS = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] }] } }, null, 2)}\n`;

async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await run(root, ["init", "-q"]);
  await run(root, ["config", "user.email", "keryx@example.test"]);
  await run(root, ["config", "user.name", "Keryx Test"]);
}

async function commitAll(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
    await run(root, ["add", "--", rel]);
  }
  await run(root, ["commit", "-q", "-m", "fixture"]);
}

const claudeMd = { kind: "root", runtime: "claude", path: "CLAUDE.md" } as const;
const agentsMd = { kind: "root", runtime: "codex", path: "AGENTS.md" } as const;
const settings = { kind: "claudeSettings", path: ".claude/settings.json" } as const;

test("settingsTextHasManagedHooks finds a managed hook group and ignores foreign ones", () => {
  expect(settingsTextHasManagedHooks(MANAGED_SETTINGS)).toBe(true);
  expect(settingsTextHasManagedHooks(PLAIN_SETTINGS)).toBe(false);
  expect(settingsTextHasManagedHooks("{}")).toBe(false);
  expect(settingsTextHasManagedHooks("not json")).toBe(false);
  expect(settingsTextHasManagedHooks("[]")).toBe(false);
  // The string appearing in a command is not a managed group.
  expect(settingsTextHasManagedHooks(JSON.stringify({ hooks: { Stop: [{ command: "echo _keryxManaged" }] } }))).toBe(false);
});

test("block committed in HEAD migrates as shared", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-migrate-head");
  try {
    await initRepo(root);
    await commitAll(root, { "CLAUDE.md": `# Team\n\n${BLOCK}\nRules\n`, ".claude/settings.json": MANAGED_SETTINGS });
    expect(await decideLegacyEntrypointScope(root, claudeMd)).toEqual({ scope: "shared", reason: "managed-in-head", head: "equal" });
    expect(await decideLegacyEntrypointScope(root, settings)).toEqual({ scope: "shared", reason: "managed-in-head", head: "equal" });

    // Still shared when the working tree has since drifted from HEAD.
    await writeFile(path.join(root, "CLAUDE.md"), "# Team\n\nRules, edited\n");
    expect(await decideLegacyEntrypointScope(root, claudeMd)).toEqual({ scope: "shared", reason: "managed-in-head", head: "differs" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("block only in the working tree migrates as local", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-migrate-worktree");
  try {
    await initRepo(root);
    await commitAll(root, { "AGENTS.md": "# Team\n\nRules\n", ".claude/settings.json": PLAIN_SETTINGS });
    await writeFile(path.join(root, "AGENTS.md"), `# Team\n\n${BLOCK}\nRules\n`);
    await writeFile(path.join(root, ".claude/settings.json"), MANAGED_SETTINGS);
    expect(await decideLegacyEntrypointScope(root, agentsMd)).toEqual({ scope: "local", reason: "not-managed-in-head", head: "differs" });
    expect(await decideLegacyEntrypointScope(root, settings)).toEqual({ scope: "local", reason: "not-managed-in-head", head: "differs" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fenced example or a prose mention in HEAD is not a committed block", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-migrate-fenced");
  try {
    await initRepo(root);
    await commitAll(root, { "AGENTS.md": `# Team\n\nThe block opens with <!-- keryx:index --> inline.\n\n\`\`\`md\n${BLOCK}\`\`\`\n` });
    expect(await decideLegacyEntrypointScope(root, agentsMd)).toEqual({ scope: "local", reason: "not-managed-in-head", head: "equal" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an untracked file, a missing file and a repository with no commit all migrate as local", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-migrate-untracked");
  try {
    await initRepo(root);
    await writeFile(path.join(root, "CLAUDE.md"), BLOCK);
    expect(await decideLegacyEntrypointScope(root, claudeMd)).toEqual({ scope: "local", reason: "not-in-head", head: "untracked" });

    await commitAll(root, { "README.md": "readme\n" });
    expect(await decideLegacyEntrypointScope(root, claudeMd)).toEqual({ scope: "local", reason: "not-in-head", head: "untracked" });
    expect(await decideLegacyEntrypointScope(root, agentsMd)).toEqual({ scope: "local", reason: "not-in-head", head: "untracked" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outside a git repository every legacy entry migrates as local", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-migrate-nogit");
  try {
    await writeFile(path.join(root, "CLAUDE.md"), BLOCK);
    expect(await decideLegacyEntrypointScope(root, claudeMd)).toEqual({ scope: "local", reason: "not-a-git-repository", head: "untracked" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveLegacyEntrypointTargets settles each legacy entry on its own evidence", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-entry-migrate-resolve");
  try {
    await initRepo(root);
    // CLAUDE.md: block committed by the team. AGENTS.md: block is a local edit.
    await commitAll(root, { "CLAUDE.md": `# Team\n\n${BLOCK}`, "AGENTS.md": "# Team\n" });
    await writeFile(path.join(root, "AGENTS.md"), `# Team\n\n${BLOCK}`);

    const resolved = await resolveLegacyEntrypointTargets(root, normalizeEntrypointTargets({ root: ["AGENTS.md", "CLAUDE.md"] }));
    expect(resolved.targets).toEqual({
      root: [
        { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" },
        { runtime: "claude", path: "CLAUDE.md", scope: "shared" },
      ],
      claudeSettings: { path: ".claude/settings.local.json", scope: "local" },
    });
    expect(resolved.decisions.map((d) => [d.legacy.path, d.scope])).toEqual([
      ["AGENTS.md", "local"],
      ["CLAUDE.md", "shared"],
      [".claude/settings.json", "local"],
    ]);

    // The resolved model is the entry form: a second pass has nothing left to decide.
    const again = normalizeEntrypointTargets(resolved.targets);
    expect(again.needsRewrite).toBe(false);
    expect(again.legacy).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
