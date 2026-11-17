import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AI_ATTRIBUTION_WORDS,
  commitMsgHookInstalled,
  findAttributionViolations,
  inspectCommitMsgHook,
  installCommitMsgHookOrWarn,
  installManagedHook,
  ManagedGitHookEscapeError,
  removeCommitMsgHookOrWarn,
  removeManagedHook,
} from "./managed-git-hook";
import { installSyncHooks, uninstallSyncHooks } from "../sync/hooks";
import { uniqueTestRoot } from "./test-tmp";

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

test("installManagedHook writes a normal (non-symlinked) hook", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-normal");
  try {
    await initRepo(root);
    await installManagedHook(root, "post-commit", "test-block", "echo hi");
    const hookPath = path.join(root, ".git", "hooks", "post-commit");
    const content = await readFile(hookPath, "utf8");
    expect(content).toContain("# keryx:test-block:begin");
    expect(content).toContain("echo hi");
    expect(content).toContain("# keryx:test-block:end");

    // Idempotent update, and removal, both still work on the plain case.
    await installManagedHook(root, "post-commit", "test-block", "echo bye");
    expect(await readFile(hookPath, "utf8")).toContain("echo bye");
    await removeManagedHook(root, "post-commit", "test-block");
    expect(await readFile(hookPath, "utf8")).not.toContain("keryx:test-block");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R1-F6: the OLD per-command comment ("resolveGitHooksRoot's own symlink
// check") was false — nothing rejected a `.git/hooks` that is ITSELF a
// symlink. `resolveContainedHookPath` now lstat/realpath-checks the hooks
// directory before `installManagedHook` ever `mkdir`s or writes into it.
test("installManagedHook refuses a .git/hooks directory symlinked outside the git common dir", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-dir-link");
  const outside = uniqueTestRoot(tmpdir(), "keryx-managed-hook-dir-link-outside");
  try {
    await initRepo(root);
    await rm(path.join(root, ".git", "hooks"), { recursive: true, force: true });
    await symlink(outside, path.join(root, ".git", "hooks"));

    await expect(installManagedHook(root, "post-commit", "test-block", "echo hi")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readdir(outside)).toEqual([]);
    expect((await lstat(path.join(root, ".git", "hooks"))).isSymbolicLink()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// R1-F6: same escape, one level deeper — the hooks DIRECTORY resolves fine,
// but the specific hook FILE is a symlink pointing outside it.
test("installManagedHook refuses a hook file symlinked outside the git common dir, and does not overwrite the victim", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-file-link");
  const outside = uniqueTestRoot(tmpdir(), "keryx-managed-hook-file-link-outside");
  try {
    await initRepo(root);
    const victimPath = path.join(outside, "victim");
    await writeFile(victimPath, "#!/usr/bin/env sh\necho victim\n", "utf8");
    await symlink(victimPath, path.join(root, ".git", "hooks", "post-commit"));

    await expect(installManagedHook(root, "post-commit", "test-block", "echo hi")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readFile(victimPath, "utf8")).toBe("#!/usr/bin/env sh\necho victim\n");
    expect((await lstat(path.join(root, ".git", "hooks", "post-commit"))).isSymbolicLink()).toBe(true);

    // removeManagedHook refuses the same way.
    await expect(removeManagedHook(root, "post-commit", "test-block")).rejects.toBeInstanceOf(
      ManagedGitHookEscapeError,
    );
    expect(await readFile(victimPath, "utf8")).toBe("#!/usr/bin/env sh\necho victim\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("installManagedHook no-ops (no throw) when there is no git repository at all", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-no-git");
  try {
    await mkdir(root, { recursive: true });
    await installManagedHook(root, "post-commit", "test-block", "echo hi");
    expect(await readdir(root).catch(() => [])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-F2: `.git/hooks/<hook> -> ../../scripts/<hook>`, a tracked script inside
// the project, is a common and legitimate setup. Before this fix, only the
// git common dir was an accepted resolution target, so this aborted with
// ManagedGitHookEscapeError even though nothing was written outside the
// project.
test("installManagedHook accepts a hook file symlinked to an in-project tracked script", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-inproject-link");
  try {
    await initRepo(root);
    const scriptDir = path.join(root, "scripts");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "post-commit");
    await writeFile(scriptPath, "#!/usr/bin/env sh\necho tracked\n", "utf8");
    await symlink(path.join("..", "..", "scripts", "post-commit"), path.join(root, ".git", "hooks", "post-commit"));

    await installManagedHook(root, "post-commit", "test-block", "echo hi");
    const written = await readFile(scriptPath, "utf8");
    expect(written).toContain("# keryx:test-block:begin");
    expect(written).toContain("echo hi");
    expect((await lstat(path.join(root, ".git", "hooks", "post-commit"))).isSymbolicLink()).toBe(true);

    await removeManagedHook(root, "post-commit", "test-block");
    expect(await readFile(scriptPath, "utf8")).not.toContain("keryx:test-block");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-F2: a dangling hook-file symlink used to surface as a raw ENOENT out of
// `realpath`, uncaught — a crash with no named reason. It is now the same
// `ManagedGitHookEscapeError` every other refusal in this module throws.
test("installManagedHook refuses a dangling hook-file symlink with a named error, not a raw ENOENT", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-dangling-link");
  try {
    await initRepo(root);
    await symlink(path.join(root, "does-not-exist"), path.join(root, ".git", "hooks", "post-commit"));

    let caught: unknown;
    try {
      await installManagedHook(root, "post-commit", "test-block", "echo hi");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ManagedGitHookEscapeError);
    expect((caught as Error).message).toContain("dangling symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legitimate linked worktree's hooks directory (resolves inside the common dir) still works", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-managed-hook-worktree-root");
  const linked = uniqueTestRoot(tmpdir(), "keryx-managed-hook-worktree-linked");
  try {
    await initRepo(root);
    await writeFile(path.join(root, "README.md"), "test\n");
    await run(root, ["add", "README.md"]);
    await run(root, ["commit", "-q", "-m", "initial"]);
    await rm(linked, { recursive: true, force: true });
    await run(root, ["worktree", "add", "-q", "-b", "linked", linked]);

    await installManagedHook(linked, "post-commit", "test-block", "echo hi");
    const hookPath = path.join(await realpath(path.join(root, ".git", "hooks")), "post-commit");
    expect(await readFile(hookPath, "utf8")).toContain("# keryx:test-block:begin");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
  }
});

// ADR-0001 D3: the managed commit-msg hook (AI attribution only).
const REJECTED_MESSAGES: Array<[string, string]> = [
  ["Claude trailer", "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"],
  ["Claude Opus trailer lowercase key", "feat: x\n\nco-authored-by: Claude Opus 4 <x@y.z>\n"],
  ["CO-AUTHORED-BY uppercase key", "feat: x\n\nCO-AUTHORED-BY: ChatGPT <x@y.z>\n"],
  ["Copilot trailer", "feat: x\n\nCo-Authored-By: Copilot <12345+Copilot@users.noreply.github.com>\n"],
  ["Codex trailer", "feat: x\n\nCo-Authored-By: Codex <codex@openai.com>\n"],
  ["noreply@anthropic.com only", "feat: x\n\nCo-Authored-By: Bot <noreply@anthropic.com>\n"],
  ["openai address only", "feat: x\n\nCo-Authored-By: Bot <bot@openai.com>\n"],
  ["Gemini trailer", "feat: x\n\nCo-Authored-By: Gemini <g@google.com>\n"],
  ["Amazon Q trailer", "feat: x\n\nCo-Authored-By: Amazon Q Developer <q@amazon.com>\n"],
  ["Claude Code footer", "feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"],
  ["Generated by Codex", "feat: x\n\nGenerated by Codex\n"],
  ["Generated with GitHub Copilot", "feat: x\n\nGenerated with GitHub Copilot\n"],
  ["Generated-by trailer", "feat: x\n\nGenerated-by: Codex\n"],
  ["markdown emphasised", "feat: x\n\n*Generated with* Claude\n"],
  ["indented lowercase", "feat: x\n\n   generated by cursor\n"],
  ["last line without newline", "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"],
  ["comment line is still checked", "feat: x\n\n# Co-Authored-By: Claude\n"],
  ["below the scissors line is still checked", "feat: x\n\n# ------------------------ >8 ------------------------\nGenerated with Claude Code\n"],
  ["CRLF line endings", "feat: x\r\n\r\nCo-Authored-By: Claude <noreply@anthropic.com>\r\n"],
];
const ACCEPTED_MESSAGES: Array<[string, string]> = [
  ["human co-author", "feat: x\n\nCo-Authored-By: Jane Doe <jane@example.com>\n"],
  ["human co-author named Claudette", "feat: x\n\nCo-Authored-By: Claudette Smith <claudette@example.com>\n"],
  ["Generated by protoc", "chore: x\n\nGenerated by protoc\n"],
  ["Generated by the OpenAPI generator", "chore: x\n\nGenerated by the OpenAPI generator\n"],
  ["Generated with openapi-generator", "chore: x\n\nGenerated with openapi-generator 7\n"],
  ["Generated-by trailer naming a codegen", "chore: x\n\nGenerated-by: protoc\n"],
  ["CLAUDE.md in subject", "docs: update CLAUDE.md routing\n"],
  ["product name in subject", "feat: Claude runtime adapter\n"],
  ["generated in another position", "fix: regenerate generated index\n"],
  ["Codex and Copilot in body", "feat: x\n\nWorks with Codex and Copilot.\n"],
  ["Generated by on a line naming no tool", "feat: x\n\nGenerated by hand\n"],
  ["empty message", ""],
  ["no trailing newline", "feat: x"],
];

test("findAttributionViolations rejects AI attribution and accepts everything else", () => {
  for (const [name, message] of REJECTED_MESSAGES) {
    expect(findAttributionViolations(message).length, name).toBeGreaterThan(0);
  }
  for (const [name, message] of ACCEPTED_MESSAGES) {
    expect(findAttributionViolations(message), name).toEqual([]);
  }
  expect(findAttributionViolations("a\n\nCo-Authored-By: Claude\n")[0]).toMatchObject({ line: 3, reason: "co-author-trailer" });
  expect(findAttributionViolations("a\nGenerated by Codex\n")[0]).toMatchObject({ line: 2, reason: "generated-by-line" });
  expect(AI_ATTRIBUTION_WORDS).toContain("claude");
});

async function runHook(root: string, message: string): Promise<{ code: number; stderr: string }> {
  const messageFile = path.join(root, "COMMIT_EDITMSG_TEST");
  await writeFile(messageFile, message, "utf8");
  const proc = Bun.spawn(["sh", path.join(root, ".git", "hooks", "commit-msg"), messageFile], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

test("the installed commit-msg script agrees with findAttributionViolations on every sample", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-script");
  try {
    await initRepo(root);
    expect(await installCommitMsgHookOrWarn(root)).toBeNull();
    for (const [name, message] of REJECTED_MESSAGES) {
      const result = await runHook(root, message);
      expect(result.code, name).toBe(1);
      expect(result.stderr, name).toMatch(/line \d+/);
    }
    for (const [name, message] of ACCEPTED_MESSAGES) {
      expect((await runHook(root, message)).code, name).toBe(0);
    }
    // The reject message names the first offending line.
    expect((await runHook(root, "a\n\nCo-Authored-By: Claude\n")).stderr).toContain("line 3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commit-msg hook install is idempotent, coexists with user content, is detected, and is removed cleanly", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-lifecycle");
  try {
    await initRepo(root);
    const hookPath = path.join(root, ".git", "hooks", "commit-msg");
    await writeFile(hookPath, "#!/usr/bin/env sh\necho user-hook\n", "utf8");
    expect(await commitMsgHookInstalled(root)).toBe(false);
    await installCommitMsgHookOrWarn(root);
    await installCommitMsgHookOrWarn(root);
    const content = await readFile(hookPath, "utf8");
    expect(content.match(/keryx:commit-msg-attribution:begin/g)?.length).toBe(1);
    expect(content).toContain("echo user-hook");
    expect(await commitMsgHookInstalled(root)).toBe(true);
    expect(await removeCommitMsgHookOrWarn(root)).toBeNull();
    expect(await commitMsgHookInstalled(root)).toBe(false);
    expect(await readFile(hookPath, "utf8")).toContain("echo user-hook");
    // Removing again is a no-op that leaves user content intact.
    expect(await removeCommitMsgHookOrWarn(root)).toBeNull();
    expect(await readFile(hookPath, "utf8")).toContain("echo user-hook");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing the commit-msg block when no hook file exists is a no-op", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-remove-absent");
  try {
    await initRepo(root);
    expect(await removeCommitMsgHookOrWarn(root)).toBeNull();
    expect(await commitMsgHookInstalled(root)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstallSyncHooks removes the managed commit-msg hook, installSyncHooks puts it back", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-uninstall");
  try {
    await initRepo(root);
    await installCommitMsgHookOrWarn(root);
    expect(await uninstallSyncHooks(root)).toContain("commit-msg");
    expect(await commitMsgHookInstalled(root)).toBe(false);
    expect(await installSyncHooks(root)).toContain("commit-msg");
    expect(await commitMsgHookInstalled(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspectCommitMsgHook reports missing, active, and inactive (with a reason) under a foreign core.hooksPath", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-inspect");
  try {
    await initRepo(root);
    expect((await inspectCommitMsgHook(root)).state).toBe("missing");
    await installCommitMsgHookOrWarn(root);
    expect((await inspectCommitMsgHook(root)).state).toBe("active");
    await mkdir(path.join(root, ".githooks"), { recursive: true });
    await run(root, ["config", "core.hooksPath", ".githooks"]);
    const inactive = await inspectCommitMsgHook(root);
    expect(inactive.state).toBe("inactive");
    expect(inactive.state === "inactive" && inactive.reason).toContain("core.hooksPath");
    // Pointing core.hooksPath back at the managed directory makes it active again.
    await run(root, ["config", "core.hooksPath", path.join(root, ".git", "hooks")]);
    expect((await inspectCommitMsgHook(root)).state).toBe("active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("commit-msg install skips a hook the block cannot run in", () => {
  async function skipCase(
    label: string,
    setup: (hookPath: string, root: string) => Promise<void>,
    reasonPattern: RegExp,
  ): Promise<void> {
    const root = uniqueTestRoot(tmpdir(), `keryx-commit-msg-skip-${label}`);
    try {
      await initRepo(root);
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      await setup(hookPath, root);
      const before = await readFile(hookPath, "utf8");
      const warning = await installCommitMsgHookOrWarn(root);
      expect(warning).toMatch(reasonPattern);
      expect(await readFile(hookPath, "utf8")).toBe(before);
      expect(await commitMsgHookInstalled(root)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("python shebang", async () => {
    await skipCase("python", (hookPath) => writeFile(hookPath, "#!/usr/bin/env python3\nprint('x')\n", "utf8"), /non-POSIX-shell shebang/);
  });
  test("node shebang", async () => {
    await skipCase("node", (hookPath) => writeFile(hookPath, "#!/usr/bin/env node\nconsole.log(1)\n", "utf8"), /non-POSIX-shell shebang/);
  });
  test("trailing exec", async () => {
    await skipCase("exec", (hookPath) => writeFile(hookPath, "#!/bin/sh\necho a\nexec other-tool \"$@\"\n\n# end\n", "utf8"), /never reaches/);
  });
  test("trailing exit", async () => {
    await skipCase("exit", (hookPath) => writeFile(hookPath, "#!/bin/sh\necho a\nexit 0\n", "utf8"), /never reaches/);
  });
  test("symlink to an in-project script", async () => {
    await skipCase(
      "symlink",
      async (hookPath, root) => {
        await mkdir(path.join(root, "scripts"), { recursive: true });
        await writeFile(path.join(root, "scripts", "commit-msg"), "#!/bin/sh\necho tracked\n", "utf8");
        await symlink(path.join("..", "..", "scripts", "commit-msg"), hookPath);
      },
      /symlink/,
    );
  });

  test("POSIX shell shebangs are accepted", async () => {
    for (const shebang of ["#!/bin/sh", "#!/usr/bin/env sh", "#!/bin/bash", "#!/usr/bin/env bash", "#!/bin/dash", "#!/bin/zsh"]) {
      const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-shebang");
      try {
        await initRepo(root);
        await writeFile(path.join(root, ".git", "hooks", "commit-msg"), `${shebang}\necho user\n`, "utf8");
        expect(await installCommitMsgHookOrWarn(root), shebang).toBeNull();
        expect(await commitMsgHookInstalled(root), shebang).toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("inspectCommitMsgHook reports inactive with the reason when a later edit made the block unreachable", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-inspect-exec");
    try {
      await initRepo(root);
      await installCommitMsgHookOrWarn(root);
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      await writeFile(hookPath, `${await readFile(hookPath, "utf8")}\nexec true\n`, "utf8");
      const state = await inspectCommitMsgHook(root);
      expect(state.state).toBe("inactive");
      expect(state.state === "inactive" && state.reason).toContain("never reaches");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("inspectCommitMsgHook never reports active when git cannot be run", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-no-git-binary");
  const originalPath = process.env.PATH;
  try {
    await initRepo(root);
    await installCommitMsgHookOrWarn(root);
    process.env.PATH = path.join(root, "empty-bin");
    const state = await inspectCommitMsgHook(root);
    expect(state.state).toBe("inactive");
    expect(state.state === "inactive" && state.reason).toContain("git");
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});
