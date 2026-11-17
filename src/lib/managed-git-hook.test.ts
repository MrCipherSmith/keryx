import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AI_EMAIL_DOMAINS,
  AI_GOOGLE_AGENT_LOCAL_PARTS,
  AI_GITHUB_BOT_LOGINS,
  AI_GITHUB_USER_LOGINS,
  AI_PRODUCT_NAMES,
  analyzeCommitMsgCall,
  applyCommitMsgHookSetting,
  COMMIT_MSG_CHECK_SCRIPT,
  COMMIT_MSG_FIX_LINE,
  type CommitMessageContext,
  commitMsgHookInstalled,
  findAttributionViolations,
  inspectCommitMsgHook,
  installCommitMsgHookOrWarn,
  installManagedHook,
  ManagedGitHookEscapeError,
  removeCommitMsgHookOrWarn,
  readCommitMsgHookSetting,
  removeManagedHook,
} from "./managed-git-hook";
import { pathExists } from "./fs";
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

// ADR-0001 D3: the managed commit-msg check (AI attribution only).

/** Every AI_PRODUCT_NAMES entry with a concrete name it must match; the test below fails when an entry has no example. */
const PRODUCT_EXAMPLES: Record<string, string> = {
  claude: "Claude",
  "claude code": "Claude Code",
  "claude( [0-9][0-9.]*)? (opus|sonnet|haiku)": "Claude 3.5 Sonnet",
  anthropic: "Anthropic",
  chatgpt: "ChatGPT",
  "gpt-[0-9][0-9a-z.]*": "GPT-4o",
  openai: "OpenAI",
  "openai codex": "OpenAI Codex",
  codex: "Codex",
  "github copilot": "GitHub Copilot",
  copilot: "Copilot",
  gemini: "Gemini",
  "gemini( [0-9][0-9.]*)? (pro|flash|ultra)": "Gemini 2.5 Pro",
  "gemini code assist": "Gemini Code Assist",
  "google gemini": "Google Gemini",
  "google jules": "Google Jules",
  jules: "Jules",
  bard: "Bard",
  "google bard": "Google Bard",
  cursor: "Cursor",
  "cursor agent": "Cursor Agent",
  devin: "Devin",
  "devin ai": "Devin AI",
  aider: "Aider",
  windsurf: "Windsurf",
  codeium: "Codeium",
  "amazon q": "Amazon Q",
  "amazon q developer": "Amazon Q Developer",
  codewhisperer: "CodeWhisperer",
  "amazon codewhisperer": "Amazon CodeWhisperer",
  tabnine: "Tabnine",
  qwen: "Qwen",
  "qwen code": "Qwen Code",
  keryx: "Keryx",
  "keryx agent": "Keryx agent",
};

const REJECTED_MESSAGES: Array<[string, string]> = [
  ["Claude trailer", "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"],
  ["Claude Opus trailer lowercase key", "feat: x\n\nco-authored-by: Claude Opus 4 <x@y.z>\n"],
  ["Claude Opus with version and note", "feat: x\n\nCo-Authored-By: Claude Opus 4.5 (1M context) <x@example.org>\n"],
  ["CO-AUTHORED-BY uppercase key", "feat: x\n\nCO-AUTHORED-BY: ChatGPT <x@y.z>\n"],
  ["space before the colon", "feat: x\n\nCo-Authored-By : Claude <claude@example.org>\n"],
  ["bare product name, no surname", "feat: x\n\nCo-Authored-By: Claude <claude@example.org>\n"],
  ["quoted product name", "feat: x\n\nCo-Authored-By: \"Codex\" <c@example.org>\n"],
  ["name only, no address", "a\n\nCo-Authored-By: Claude\n"],
  ["indented trailer", "feat: x\n\n   Co-Authored-By: Claude\n"],
  ["Copilot noreply trailer", "feat: x\n\nCo-Authored-By: Copilot <12345+Copilot@users.noreply.github.com>\n"],
  ["Copilot noreply under a human name", "feat: x\n\nCo-Authored-By: Jane <198982749+Copilot@users.noreply.github.com>\n"],
  ["copilot@github.com", "feat: x\n\nCo-Authored-By: Jane <copilot@github.com>\n"],
  ["GitHub bot noreply", "feat: x\n\nCo-Authored-By: Helper <161369871+google-labs-jules[bot]@users.noreply.github.com>\n"],
  ["vendor address under a human-looking name", "feat: x\n\nCo-Authored-By: Bot <noreply@anthropic.com>\n"],
  ["vendor subdomain", "feat: x\n\nCo-Authored-By: CI <ci@mail.openai.com>\n"],
  ["bare vendor address", "feat: x\n\nCo-Authored-By: noreply@anthropic.com\n"],
  ["google.com agent address", "feat: x\n\nCo-Authored-By: Jane <gemini@google.com>\n"],
  ["google.com agent address with +tag", "feat: x\n\nCo-Authored-By: Jane <jules+run7@google.com>\n"],
  ["Claude Code footer", "feat: x\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"],
  ["Generated by Codex", "feat: x\n\nGenerated by Codex\n"],
  ["Generated with GitHub Copilot", "feat: x\n\nGenerated with GitHub Copilot\n"],
  ["Generated-by trailer", "feat: x\n\nGenerated-by: Cursor\n"],
  ["Generated with a versioned product", "feat: x\n\nGenerated with Claude Code v1.2\n"],
  ["Generated by the product, then punctuation", "feat: x\n\nGenerated by the Codex.\n"],
  ["Generated by product with a note", "feat: x\n\nGenerated by Claude (Anthropic)\n"],
  ["markdown emphasised", "feat: x\n\n*Generated with* Claude\n"],
  ["indented lowercase", "feat: x\n\n   generated by cursor\n"],
  ["last line without newline", "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"],
  ["CRLF line endings", "feat: x\r\n\r\nCo-Authored-By: Claude <noreply@anthropic.com>\r\n"],
];

const ACCEPTED_MESSAGES: Array<[string, string]> = [
  ["human co-author", "feat: x\n\nCo-Authored-By: Jane Doe <jane@example.com>\n"],
  ["human named Claudette", "feat: x\n\nCo-Authored-By: Claudette Smith <claudette@example.com>\n"],
  ["human named Devin", "feat: x\n\nCo-Authored-By: Devin Smith <devin@example.com>\n"],
  ["human named Claude", "feat: x\n\nCo-Authored-By: Claude Monet <claude@example.org>\n"],
  ["human named Gemini", "feat: x\n\nCo-Authored-By: Gemini Ruiz <g@x.io>\n"],
  ["human named Bard", "feat: x\n\nCo-Authored-By: Bard Johansson <bard@example.no>\n"],
  ["human at google.com", "feat: x\n\nCo-Authored-By: Jane <jane@google.com>\n"],
  ["human GitHub noreply", "feat: x\n\nCo-Authored-By: Jane <123+jane@users.noreply.github.com>\n"],
  ["vendor domain only as a prefix", "feat: x\n\nCo-Authored-By: Jane <jane@anthropic.com.example.org>\n"],
  ["vendor domain only as a suffix", "feat: x\n\nCo-Authored-By: Jane <jane@notanthropic.com>\n"],
  ["leading-word-boundary mutant in a name", "feat: x\n\nCo-Authored-By: xClaude <x@example.com>\n"],
  ["Generated by protoc", "chore: x\n\nGenerated by protoc\n"],
  ["Generated by the OpenAPI generator", "chore: x\n\nGenerated by the OpenAPI generator\n"],
  ["Generated with openapi-generator", "chore: x\n\nGenerated with openapi-generator 7\n"],
  ["Generated-by naming a codegen", "chore: x\n\nGenerated-by: protoc\n"],
  ["Generated with a cursor-based script", "chore: x\n\nGenerated with a cursor-based script\n"],
  ["Generated with cursor-based tooling", "chore: x\n\nGenerated with cursor-based tooling\n"],
  ["Generated by a person's script", "chore: x\n\nGenerated by Gemini Ruiz's script\n"],
  ["leading-word-boundary mutant after by", "chore: x\n\nGenerated by xClaude\n"],
  ["no separator after by", "chore: x\n\nGenerated byClaude\n"],
  ["CLAUDE.md in subject", "docs: update CLAUDE.md routing\n"],
  ["product name in subject", "feat: Claude runtime adapter\n"],
  ["generated in another position", "fix: regenerate generated index\n"],
  ["Codex and Copilot in body", "feat: x\n\nWorks with Codex and Copilot.\n"],
  ["Generated by on a line naming no tool", "feat: x\n\nGenerated by hand\n"],
  ["comment line (default cleanup, edited)", "feat: x\n\n# Co-Authored-By: Claude\n"],
  ["below the scissors line (edited)", "feat: x\n\n# ------------------------ >8 ------------------------\nGenerated with Claude Code\n"],
  ["empty message", ""],
  ["no trailing newline", "feat: x"],
];

/** Per-table-entry samples, so every product name, vendor domain and google agent is exercised. */
function tableSamples(): { rejected: Array<[string, string]>; accepted: Array<[string, string]> } {
  const rejected: Array<[string, string]> = [];
  const accepted: Array<[string, string]> = [];
  for (const example of Object.values(PRODUCT_EXAMPLES)) {
    rejected.push([`name ${example}`, `feat: x\n\nCo-Authored-By: ${example} <someone@example.com>\n`]);
    rejected.push([`generated ${example}`, `feat: x\n\nGenerated by ${example}\n`]);
    accepted.push([`name ${example} Smith`, `feat: x\n\nCo-Authored-By: ${example} Smith <someone@example.com>\n`]);
    accepted.push([`name x${example}`, `feat: x\n\nCo-Authored-By: x${example} <someone@example.com>\n`]);
    accepted.push([`generated x${example}`, `feat: x\n\nGenerated by x${example}\n`]);
  }
  for (const domain of AI_EMAIL_DOMAINS) {
    rejected.push([`domain ${domain}`, `feat: x\n\nCo-Authored-By: Jane Doe <jane@${domain}>\n`]);
    accepted.push([`domain x${domain}`, `feat: x\n\nCo-Authored-By: Jane Doe <jane@x${domain}>\n`]);
    accepted.push([`domain ${domain}.example.org`, `feat: x\n\nCo-Authored-By: Jane Doe <jane@${domain}.example.org>\n`]);
  }
  for (const login of AI_GITHUB_BOT_LOGINS) {
    rejected.push([`AI bot ${login}`, `feat: x\n\nCo-Authored-By: ${login}[bot] <12345+${login}[bot]@users.noreply.github.com>\n`]);
    rejected.push([`AI bot ${login}, no id`, `feat: x\n\nCo-Authored-By: Helper <${login}[bot]@users.noreply.github.com>\n`]);
    accepted.push([`bot x${login}`, `feat: x\n\nCo-Authored-By: Helper <12345+x${login}[bot]@users.noreply.github.com>\n`]);
  }
  for (const login of AI_GITHUB_USER_LOGINS) {
    rejected.push([`AI user ${login}`, `feat: x\n\nCo-Authored-By: Helper <12345+${login}@users.noreply.github.com>\n`]);
  }
  for (const bot of ["dependabot", "renovate", "github-actions", "pre-commit-ci", "mergify"]) {
    accepted.push([`non-AI bot ${bot}`, `feat: x\n\nCo-Authored-By: ${bot}[bot] <49699333+${bot}[bot]@users.noreply.github.com>\n`]);
  }
  for (const local of AI_GOOGLE_AGENT_LOCAL_PARTS) {
    rejected.push([`google ${local}`, `feat: x\n\nCo-Authored-By: Jane Doe <${local}@google.com>\n`]);
    accepted.push([`google ${local}x`, `feat: x\n\nCo-Authored-By: Jane Doe <${local}x@google.com>\n`]);
  }
  return { rejected, accepted };
}

const ALL_REJECTED = [...REJECTED_MESSAGES, ...tableSamples().rejected];
const ALL_ACCEPTED = [...ACCEPTED_MESSAGES, ...tableSamples().accepted];

/** Samples whose verdict depends on git's cleanup mode, comment character and whether an editor was used. */
const CONTEXT_CASES: Array<{ name: string; message: string; context: CommitMessageContext; rejected: boolean }> = [
  { name: "comment, unset, edited", message: "a\n\n# Co-Authored-By: Claude\n", context: {}, rejected: false },
  { name: "comment, unset, -m", message: "a\n\n# Co-Authored-By: Claude\n", context: { edited: false }, rejected: true },
  { name: "comment, default, edited", message: "a\n\n# Co-Authored-By: Claude\n", context: { cleanup: "default" }, rejected: false },
  { name: "comment, default, -m", message: "a\n\n# Co-Authored-By: Claude\n", context: { cleanup: "default", edited: false }, rejected: true },
  { name: "comment, strip, -m", message: "a\n\n# Co-Authored-By: Claude\n", context: { cleanup: "strip", edited: false }, rejected: false },
  { name: "comment, verbatim, edited", message: "a\n\n# Co-Authored-By: Claude\n", context: { cleanup: "verbatim" }, rejected: true },
  { name: "comment, whitespace, edited", message: "a\n\n# Co-Authored-By: Claude\n", context: { cleanup: "whitespace" }, rejected: true },
  { name: "comment, scissors, edited", message: "a\n\n# Co-Authored-By: Claude\n", context: { cleanup: "scissors" }, rejected: true },
  { name: "commentChar ; skips ; lines", message: "a\n\n; Co-Authored-By: Claude\n", context: { commentChar: ";" }, rejected: false },
  { name: "commentChar ; keeps # lines", message: "a\n\n# Co-Authored-By: Claude\n", context: { commentChar: ";" }, rejected: true },
  { name: "commentChar auto skips nothing", message: "a\n\n# Co-Authored-By: Claude\n", context: { commentChar: "auto" }, rejected: true },
  {
    name: "scissors, -m, default: not cut",
    message: "a\n\n# ------------------------ >8 ------------------------\nGenerated with Claude Code\n",
    context: { edited: false },
    rejected: true,
  },
  {
    name: "scissors, -m, scissors mode: cut",
    message: "a\n\n# ------------------------ >8 ------------------------\nGenerated with Claude Code\n",
    context: { cleanup: "scissors", edited: false },
    rejected: false,
  },
  {
    name: "scissors with commentChar ;",
    message: "a\n\n; ------------------------ >8 ------------------------\nGenerated with Claude Code\n",
    context: { commentChar: ";" },
    rejected: false,
  },
  {
    name: "# scissors is not a cut under commentChar ;",
    message: "a\n\n# ------------------------ >8 ------------------------\nGenerated with Claude Code\n",
    context: { commentChar: ";" },
    rejected: true,
  },
  {
    name: "scissors under commentChar auto",
    message: "a\n\n; ------------------------ >8 ------------------------\nGenerated with Claude Code\n",
    context: { commentChar: "auto" },
    rejected: false,
  },
  {
    name: "scissors line with trailing text is not a cut",
    message: "a\n\n# ------------------------ >8 ------------------------ x\nCo-Authored-By: Claude\n",
    context: {},
    rejected: true,
  },
];

test("findAttributionViolations rejects AI attribution and accepts everything else", () => {
  expect(Object.keys(PRODUCT_EXAMPLES).sort()).toEqual([...AI_PRODUCT_NAMES].sort());
  for (const [name, message] of ALL_REJECTED) {
    expect(findAttributionViolations(message).length, name).toBeGreaterThan(0);
  }
  for (const [name, message] of ALL_ACCEPTED) {
    expect(findAttributionViolations(message), name).toEqual([]);
  }
  for (const { name, message, context, rejected } of CONTEXT_CASES) {
    expect(findAttributionViolations(message, context).length > 0, name).toBe(rejected);
  }
  expect(findAttributionViolations("a\n\nCo-Authored-By: Claude\n")[0]).toMatchObject({ line: 3, reason: "co-author-trailer" });
  expect(findAttributionViolations("a\nGenerated by Codex\n")[0]).toMatchObject({ line: 2, reason: "generated-by-line" });
});

/** Environment for git and the hook: no global/system config (this machine's template hooks refuse test identities) and no inherited GIT_EDITOR. */
function hookEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "GIT_EDITOR" && !key.startsWith("GIT_CONFIG")) env[key] = value;
  }
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
}

async function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: hookEnv(extraEnv) });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** A repo with no template hooks and a committer identity the global template guard accepts. */
async function initIsolatedRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const args of [
    ["init", "-q", "--template="],
    ["config", "user.email", "200531777+MrCipherSmith@users.noreply.github.com"],
    ["config", "user.name", "MrCipherSmith"],
  ]) {
    const result = await git(root, args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

async function runHook(
  root: string,
  message: string,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const messageFile = path.join(root, "COMMIT_EDITMSG_TEST");
  await writeFile(messageFile, message, "utf8");
  const proc = Bun.spawn(["sh", path.join(root, ".git", "hooks", "commit-msg"), messageFile], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: hookEnv(extraEnv),
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

test(
  "the installed commit-msg check agrees with findAttributionViolations on every sample",
  async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-script");
    try {
      await initIsolatedRepo(root);
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      for (const [name, message] of ALL_REJECTED) {
        const result = await runHook(root, message);
        expect(result.code, name).toBe(1);
        expect(result.stderr, name).toMatch(/line \d+ is AI attribution/);
      }
      for (const [name, message] of ALL_ACCEPTED) {
        const result = await runHook(root, message);
        expect(result.code, `${name}: ${result.stderr}`).toBe(0);
      }
      for (const { name, message, context, rejected } of CONTEXT_CASES) {
        await git(root, ["config", "--unset", "commit.cleanup"]);
        await git(root, ["config", "--unset", "core.commentChar"]);
        if (context.cleanup) await git(root, ["config", "commit.cleanup", context.cleanup]);
        if (context.commentChar) await git(root, ["config", "core.commentChar", context.commentChar]);
        const result = await runHook(root, message, context.edited === false ? { GIT_EDITOR: ":" } : {});
        expect(result.code, `${name}: ${result.stderr}`).toBe(rejected ? 1 : 0);
      }
      // The reject message names the first offending line.
      expect((await runHook(root, "a\n\nCo-Authored-By: Claude\n")).stderr).toContain("line 3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

test("the check fails loudly, never silently passes, when it cannot run", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-loud");
  try {
    await initIsolatedRepo(root);
    expect(await installCommitMsgHookOrWarn(root)).toBeNull();
    const script = path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT);
    const runScript = async (args: string[], env: Record<string, string> = {}) => {
      const proc = Bun.spawn(["sh", script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: hookEnv(env) });
      const stderr = await new Response(proc.stderr).text();
      return { code: await proc.exited, stderr };
    };
    const noArg = await runScript([]);
    expect(noArg.code).toBe(2);
    expect(noArg.stderr).toContain("no readable commit message file");
    expect((await runScript([path.join(root, "absent-message")])).code).toBe(2);

    // awk failing (stand-in on PATH exits 3) refuses the commit with a message.
    const fakeBin = path.join(root, "fake-bin");
    await mkdir(fakeBin, { recursive: true });
    await writeFile(path.join(fakeBin, "awk"), "#!/bin/sh\nexit 3\n", "utf8");
    await chmod(path.join(fakeBin, "awk"), 0o755);
    await writeFile(path.join(root, "msg"), "feat: clean\n", "utf8");
    const awkFails = await runScript([path.join(root, "msg")], { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
    expect(awkFails.code).toBe(3);
    expect(awkFails.stderr).toContain("could not run");

    // git config failing (a corrupt config file) refuses the commit with a message.
    await writeFile(path.join(root, ".git", "config"), "[core\nbroken", "utf8");
    const configFails = await runScript([path.join(root, "msg")]);
    expect(configFails.code).toBe(2);
    expect(configFails.stderr).toContain("git config --get commit.cleanup");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("real git commits through the installed hook", () => {
  async function commitRepo(label: string): Promise<string> {
    const root = uniqueTestRoot(tmpdir(), `keryx-commit-msg-real-${label}`);
    await initIsolatedRepo(root);
    // A tracked file whose diff context will carry an attribution-looking line.
    await writeFile(path.join(root, "notes.txt"), "first\nCo-Authored-By: Claude <noreply@anthropic.com>\nlast\n", "utf8");
    expect((await git(root, ["add", "notes.txt"])).code).toBe(0);
    expect((await git(root, ["commit", "-q", "-m", "chore: seed"])).code).toBe(0);
    expect(await installCommitMsgHookOrWarn(root)).toBeNull();
    await writeFile(path.join(root, "notes.txt"), "first changed\nCo-Authored-By: Claude <noreply@anthropic.com>\nlast\n", "utf8");
    expect((await git(root, ["add", "notes.txt"])).code).toBe(0);
    return root;
  }

  /** An editor that puts `subject` (and optional `body`) above git's template, keeping the -v diff below the scissors line. */
  async function editor(root: string, body: string): Promise<string> {
    const editorPath = path.join(root, "test-editor.sh");
    await writeFile(path.join(root, "editor-message.txt"), body, "utf8");
    await writeFile(editorPath, `#!/bin/sh\n{ cat "${path.join(root, "editor-message.txt")}"; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n`, "utf8");
    await chmod(editorPath, 0o755);
    return editorPath;
  }

  test("git commit -v: a clean message passes although the diff below the scissors line holds a trailer", async () => {
    const root = await commitRepo("verbose-clean");
    try {
      const result = await git(root, ["commit", "-q", "-v"], { GIT_EDITOR: await editor(root, "feat: clean change\n") });
      expect(result.code, result.stderr).toBe(0);
      expect((await git(root, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("feat: clean change");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("git commit -v: a message carrying the trailer is refused", async () => {
    const root = await commitRepo("verbose-trailer");
    try {
      const result = await git(root, ["commit", "-q", "-v"], {
        GIT_EDITOR: await editor(root, "feat: change\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n"),
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("keryx commit-msg: line 3 is AI attribution");
      expect((await git(root, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("chore: seed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("git commit -m keeps # lines under the default cleanup, so a # trailer is refused; strip drops it", async () => {
    const root = await commitRepo("message-comment");
    try {
      const refused = await git(root, ["commit", "-q", "-m", "feat: change", "-m", "# Co-Authored-By: Claude <noreply@anthropic.com>"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("keryx commit-msg");

      await git(root, ["config", "commit.cleanup", "strip"]);
      const stripped = await git(root, ["commit", "-q", "-m", "feat: change", "-m", "# Co-Authored-By: Claude <noreply@anthropic.com>"]);
      expect(stripped.code, stripped.stderr).toBe(0);
      expect((await git(root, ["log", "-1", "--format=%B"])).stdout).not.toContain("Co-Authored-By");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("install creates commit-msg + keryx-commit-msg, is idempotent, refreshes a legacy block, and removal cleans both", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-lifecycle");
  try {
    await initRepo(root);
    const hooksDir = path.join(root, ".git", "hooks");
    const hookPath = path.join(hooksDir, "commit-msg");
    const scriptPath = path.join(hooksDir, COMMIT_MSG_CHECK_SCRIPT);
    expect(await commitMsgHookInstalled(root)).toBe(false);
    expect(await installCommitMsgHookOrWarn(root)).toBeNull();
    expect(await installCommitMsgHookOrWarn(root)).toBeNull();
    const created = await readFile(hookPath, "utf8");
    expect(created.startsWith("#!/bin/sh\n")).toBe(true);
    expect(created.match(/keryx:commit-msg-attribution:begin/g)?.length).toBe(1);
    expect(created).toContain(`"$(dirname "$0")/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit $?`);
    expect((await stat(scriptPath)).mode & 0o777).toBe(0o755);
    expect(await commitMsgHookInstalled(root)).toBe(true);

    expect(await removeCommitMsgHookOrWarn(root)).toEqual({ removed: true, warning: null });
    expect(await commitMsgHookInstalled(root)).toBe(false);
    expect(await pathExists(scriptPath)).toBe(false);
    expect(await pathExists(hookPath)).toBe(false);
    expect(await removeCommitMsgHookOrWarn(root)).toEqual({ removed: false, warning: null });
    // A shebang-only hook does nothing, so install may take it over.
    await writeFile(hookPath, "#!/usr/bin/env sh\n\n", "utf8");
    expect(await installCommitMsgHookOrWarn(root)).toBeNull();
    expect(await commitMsgHookInstalled(root)).toBe(true);
    expect((await removeCommitMsgHookOrWarn(root)).removed).toBe(true);

    // A user hook carrying the block an older keryx appended: the block is refreshed in place, user content kept.
    await writeFile(
      hookPath,
      "#!/usr/bin/env sh\necho user-hook\n\n# keryx:commit-msg-attribution:begin\nold_inline_check \"$@\" || exit $?\n# keryx:commit-msg-attribution:end\n",
      "utf8",
    );
    expect(await installCommitMsgHookOrWarn(root)).toBeNull();
    const refreshed = await readFile(hookPath, "utf8");
    expect(refreshed).toContain("echo user-hook");
    expect(refreshed).not.toContain("old_inline_check");
    expect(refreshed).toContain(COMMIT_MSG_CHECK_SCRIPT);
    expect((await removeCommitMsgHookOrWarn(root)).removed).toBe(true);
    expect(await readFile(hookPath, "utf8")).toBe("#!/usr/bin/env sh\necho user-hook\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("a foreign commit-msg hook is never edited", () => {
  const PRE_COMMIT_SHAPED_HOOK =
    "#!/usr/bin/env bash\n# installed by a hook manager\nINSTALL_PYTHON=/usr/bin/python3\n" +
    'if [ -x "$INSTALL_PYTHON" ]; then exec "$INSTALL_PYTHON" -mpre_commit "$@"; else echo "hook manager missing" >&2; exit 1; fi\n';

  test("pre-commit framework shape: skipped, untouched, inactive with the fix line; adding the line makes it active", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-precommit");
    try {
      await initRepo(root);
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      await writeFile(hookPath, PRE_COMMIT_SHAPED_HOOK, "utf8");
      await chmod(hookPath, 0o755);

      const warning = await installCommitMsgHookOrWarn(root);
      expect(warning).toContain("left the existing commit-msg hook");
      expect(warning).toContain(COMMIT_MSG_FIX_LINE);
      expect(await readFile(hookPath, "utf8")).toBe(PRE_COMMIT_SHAPED_HOOK);
      expect(await pathExists(path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT))).toBe(true);
      expect(await commitMsgHookInstalled(root)).toBe(false);

      const state = await inspectCommitMsgHook(root);
      expect(state.state).toBe("inactive");
      expect(state.state === "inactive" && state.reason).toContain("foreign commit-msg hook");
      expect(state.state === "inactive" && state.fix).toContain(COMMIT_MSG_FIX_LINE);

      // Appended after the `if … exec … fi`: the line never runs, so it is not active.
      const appended = `${PRE_COMMIT_SHAPED_HOOK}${COMMIT_MSG_FIX_LINE}\n`;
      await writeFile(hookPath, appended, "utf8");
      const unverified = await inspectCommitMsgHook(root);
      expect(unverified.state).toBe("unverified");
      expect(unverified.state === "unverified" && unverified.reason).toContain("unverified — check that this line runs before any exec");
      expect(await installCommitMsgHookOrWarn(root)).toContain("cannot show that the call runs");
      expect(await readFile(hookPath, "utf8")).toBe(appended);

      // Placed right after the shebang: provably runs, so active.
      const [shebang, ...restOfHook] = PRE_COMMIT_SHAPED_HOOK.split("\n");
      const atTop = `${shebang}\n${COMMIT_MSG_FIX_LINE}\n${restOfHook.join("\n")}`;
      await writeFile(hookPath, atTop, "utf8");
      expect((await inspectCommitMsgHook(root)).state).toBe("active");
      expect(await commitMsgHookInstalled(root)).toBe(true);
      // Re-running install leaves the user-wired hook alone and reports no problem.
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      expect(await readFile(hookPath, "utf8")).toBe(atTop);
      // Removal keeps the script while the user's hook still calls it.
      const removal = await removeCommitMsgHookOrWarn(root);
      expect(removal.removed).toBe(false);
      expect(removal.warning).toContain("still calls");
      expect(await pathExists(path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the fix line works when git runs the user's hook", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-fix-line-runs");
    try {
      await initIsolatedRepo(root);
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, `#!/bin/sh\n${COMMIT_MSG_FIX_LINE}\necho user-hook-ran >&2\n`, "utf8");
      await chmod(hookPath, 0o755);
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      await writeFile(path.join(root, "a.txt"), "a\n", "utf8");
      await git(root, ["add", "a.txt"]);
      const refused = await git(root, ["commit", "-q", "-m", "feat: a", "-m", "Co-Authored-By: Claude <noreply@anthropic.com>"]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("keryx commit-msg");
      const passed = await git(root, ["commit", "-q", "-m", "feat: a"]);
      expect(passed.code, passed.stderr).toBe(0);
      expect(passed.stderr).toContain("user-hook-ran");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a plain user hook, a python hook: skipped and untouched", async () => {
    for (const body of ["#!/bin/sh\necho user-hook\n", "#!/usr/bin/env python3\nprint('x')\n"]) {
      const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-foreign");
      try {
        await initRepo(root);
        const hookPath = path.join(root, ".git", "hooks", "commit-msg");
        await writeFile(hookPath, body, "utf8");
        expect(await installCommitMsgHookOrWarn(root), body).toContain(COMMIT_MSG_FIX_LINE);
        expect(await readFile(hookPath, "utf8")).toBe(body);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("symlinked commit-msg: install does not write through it, uninstall refuses to edit through it", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-symlink");
    try {
      await initRepo(root);
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      const target = path.join(root, "scripts", "commit-msg");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "#!/bin/sh\necho tracked\n", "utf8");
      await symlink(path.join("..", "..", "scripts", "commit-msg"), hookPath);

      expect(await installCommitMsgHookOrWarn(root)).toMatch(/a symlink/);
      expect(await readFile(target, "utf8")).toBe("#!/bin/sh\necho tracked\n");
      expect((await lstat(hookPath)).isSymbolicLink()).toBe(true);

      // The link target carries a keryx block (written by hand or an older tool): uninstall must not strip it through the link.
      const withBlock = `#!/bin/sh\n\n# keryx:commit-msg-attribution:begin\n"$(dirname "$0")/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit $?\n# keryx:commit-msg-attribution:end\n`;
      await writeFile(target, withBlock, "utf8");
      const removal = await removeCommitMsgHookOrWarn(root);
      expect(removal.removed).toBe(false);
      expect(removal.warning).toContain("is a symlink and keryx does not edit a hook through a link");
      expect(await readFile(target, "utf8")).toBe(withBlock);
      expect(await pathExists(path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("install never refreshes or replaces a commit-msg reached through a symlink", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-link-refresh");
    try {
      await initRepo(root);
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      const target = path.join(root, "scripts", "commit-msg");
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(path.join("..", "..", "scripts", "commit-msg"), hookPath);
      // An old keryx block behind the link: a refresh would rewrite the target.
      const legacy = "#!/bin/sh\n# keryx:commit-msg-attribution:begin\nold_inline_check \"$@\" || exit $?\n# keryx:commit-msg-attribution:end\n";
      await writeFile(target, legacy, "utf8");
      await installCommitMsgHookOrWarn(root);
      expect(await readFile(target, "utf8")).toBe(legacy);
      // A shebang-only target behind the link: replacing it would write through the link.
      await writeFile(target, "#!/bin/sh\n", "utf8");
      expect(await installCommitMsgHookOrWarn(root)).toMatch(/a symlink/);
      expect(await readFile(target, "utf8")).toBe("#!/bin/sh\n");
      expect((await lstat(hookPath)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removal strips the keryx block but keeps the script while a user line still calls it", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-still-wired");
    try {
      await initRepo(root);
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      const scriptPath = path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT);
      await writeFile(hookPath, `${await readFile(hookPath, "utf8")}${COMMIT_MSG_FIX_LINE}\n`, "utf8");
      const removal = await removeCommitMsgHookOrWarn(root);
      expect(removal.removed).toBe(true);
      expect(removal.warning).toContain("still calls");
      expect(await readFile(hookPath, "utf8")).not.toContain("keryx:commit-msg-attribution");
      expect(await readFile(hookPath, "utf8")).toContain(COMMIT_MSG_FIX_LINE);
      expect(await pathExists(scriptPath)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a symlinked or foreign keryx-commit-msg is not overwritten", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-script-guard");
    const outside = uniqueTestRoot(tmpdir(), "keryx-commit-msg-script-guard-outside");
    try {
      await initRepo(root);
      const scriptPath = path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT);
      await writeFile(scriptPath, "#!/bin/sh\necho mine\n", "utf8");
      expect(await installCommitMsgHookOrWarn(root)).toContain("was not written by keryx");
      expect(await readFile(scriptPath, "utf8")).toBe("#!/bin/sh\necho mine\n");

      await rm(scriptPath);
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, "victim"), "victim\n", "utf8");
      await symlink(path.join(outside, "victim"), scriptPath);
      expect(await installCommitMsgHookOrWarn(root)).toMatch(/Skipped/);
      expect(await readFile(path.join(outside, "victim"), "utf8")).toBe("victim\n");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("readCommitMsgHookSetting: on by default, off only for false, invalid otherwise", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-setting");
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const manifestPath = path.join(root, ".metaproject", "metaproject.json");
    expect((await readCommitMsgHookSetting(root)).state).toBe("on");
    for (const [content, state] of [
      ["not json", "invalid"],
      ["[]", "invalid"],
      ["null", "invalid"],
      [JSON.stringify({}), "on"],
      [JSON.stringify({ hooks: {} }), "on"],
      [JSON.stringify({ hooks: null }), "invalid"],
      [JSON.stringify({ hooks: [] }), "invalid"],
      [JSON.stringify({ hooks: { commitMsg: true } }), "on"],
      [JSON.stringify({ hooks: { commitMsg: 0 } }), "invalid"],
      [JSON.stringify({ hooks: { commitMsg: "false" } }), "invalid"],
      [JSON.stringify({ hooks: { commitMsg: false } }), "off"],
    ] as const) {
      await writeFile(manifestPath, content, "utf8");
      expect((await readCommitMsgHookSetting(root)).state, content).toBe(state);
    }
    // From a subdirectory, the manifest at the project root is the one read.
    const sub = path.join(root, "packages", "app");
    await mkdir(sub, { recursive: true });
    await mkdir(path.join(root, ".git"), { recursive: true });
    expect(await readCommitMsgHookSetting(sub)).toEqual({ state: "off", manifestPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyCommitMsgHookSetting: on installs, off removes through the same guard, invalid touches nothing", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-apply");
  try {
    await initRepo(root);
    expect(await applyCommitMsgHookSetting(root)).toEqual({ setting: "on", installed: true, removed: false, warning: null });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    const manifestPath = path.join(root, ".metaproject", "metaproject.json");

    // Unreadable setting: the installed check stays, with a warning.
    await writeFile(manifestPath, "{ not json", "utf8");
    const invalidOn = await applyCommitMsgHookSetting(root);
    expect(invalidOn).toMatchObject({ setting: "invalid", installed: false, removed: false });
    expect(invalidOn.warning).toContain("is not valid JSON");
    expect(await commitMsgHookInstalled(root)).toBe(true);
    const state = await inspectCommitMsgHook(root);
    expect(state.state).toBe("setting-invalid");

    await writeFile(manifestPath, JSON.stringify({ hooks: { commitMsg: false } }), "utf8");
    expect(await applyCommitMsgHookSetting(root)).toEqual({ setting: "off", installed: false, removed: true, warning: null });
    expect(await commitMsgHookInstalled(root)).toBe(false);
    expect(await inspectCommitMsgHook(root)).toEqual({ state: "disabled" });

    // Unreadable setting while off: nothing is installed either.
    await writeFile(manifestPath, JSON.stringify({ hooks: { commitMsg: "no" } }), "utf8");
    expect((await applyCommitMsgHookSetting(root)).setting).toBe("invalid");
    expect(await pathExists(path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT))).toBe(false);
    expect(await pathExists(path.join(root, ".git", "hooks", "commit-msg"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("analyzeCommitMsgCall: active only for a call that provably runs", () => {
  const call = COMMIT_MSG_FIX_LINE;
  const managed = `"$(dirname "$0")/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit $?`;
  const runs: Array<[string, string]> = [
    ["fix line after the shebang", `#!/bin/sh\n${call}\nexec other "$@"\n`],
    ["managed block line", `#!/bin/sh\n\n# keryx:commit-msg-attribution:begin\n${managed}\n# keryx:commit-msg-attribution:end\n`],
    ["after plain commands and a closed if", `#!/bin/bash\nA=1\nif [ -n "$A" ]; then echo y; fi\n${call}\n`],
    ["no shebang", `${call}\n`],
    ["last line without || exit", `#!/bin/sh\necho a\n"$(git rev-parse --git-path hooks)/${COMMIT_MSG_CHECK_SCRIPT}" "$1"\n`],
  ];
  const notRuns: Array<[string, string]> = [
    ["after exec", `#!/bin/sh\nexec other "$@"\n${call}\n`],
    ["after if…exec…fi", `#!/bin/sh\nif [ -x x ]; then exec x "$@"; else exit 1; fi\n${call}\n`],
    ["after a conditional exit", `#!/bin/sh\n[ -f x ] || exit 0\n${call}\n`],
    ["inside an if", `#!/bin/sh\nif true; then\n  ${call}\nfi\n`],
    ["inside a function", `#!/bin/sh\ncheck() {\n  ${call}\n}\n`],
    ["inside a loop", `#!/bin/sh\nfor f in a; do\n${call}\ndone\n`],
    ["inside a case", `#!/bin/sh\ncase "$1" in\n*)\n${call}\n;;\nesac\n`],
    ["after a sourced file", `#!/bin/sh\n. ./lib.sh\n${call}\n`],
    ["after a here-document", `#!/bin/sh\ncat <<EOF\nx\nEOF\n${call}\n`],
    ["guarded by &&", `#!/bin/sh\ntrue && ${call}\n`],
    ["status ignored", `#!/bin/sh\n"$(git rev-parse --git-path hooks)/${COMMIT_MSG_CHECK_SCRIPT}" "$1"\necho done\n`],
    ["run in the background", `#!/bin/sh\n"$(git rev-parse --git-path hooks)/${COMMIT_MSG_CHECK_SCRIPT}" "$1" &\n`],
    ["python hook", `#!/usr/bin/env python3\n${call}\n`],
    ["mentioned only in a test", `#!/bin/sh\n[ -x "${COMMIT_MSG_CHECK_SCRIPT}" ]\n`],
  ];
  for (const [name, text] of runs) expect(analyzeCommitMsgCall(text).runs, name).toBe(true);
  for (const [name, text] of notRuns) expect(analyzeCommitMsgCall(text).runs, name).toBe(false);
});

test("uninstallSyncHooks removes the commit-msg check, installSyncHooks puts it back", async () => {
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

describe("inspectCommitMsgHook", () => {
  test("missing, active, and inactive under a foreign core.hooksPath until that hook calls the check", async () => {
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
      expect(inactive.state === "inactive" && inactive.fix).toContain(`hooks/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit 1`);
      // The hook git actually runs now calls the check.
      const foreignHook = path.join(root, ".githooks", "commit-msg");
      await writeFile(foreignHook, `#!/bin/sh\n"$(git rev-parse --git-common-dir)/hooks/${COMMIT_MSG_CHECK_SCRIPT}" "$1" || exit 1\n`, "utf8");
      await chmod(foreignHook, 0o644);
      const notExecutable = await inspectCommitMsgHook(root);
      expect(notExecutable.state === "inactive" && notExecutable.reason).toContain("not executable");
      await chmod(foreignHook, 0o755);
      expect((await inspectCommitMsgHook(root)).state).toBe("active");
      // Pointing core.hooksPath back at the managed directory is active too.
      await run(root, ["config", "core.hooksPath", path.join(root, ".git", "hooks")]);
      expect((await inspectCommitMsgHook(root)).state).toBe("active");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a commit-msg line only mentioned in a comment does not count as calling the check", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-inspect-comment");
    try {
      await initRepo(root);
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      await writeFile(hookPath, `#!/bin/sh\n# TODO: call ${COMMIT_MSG_CHECK_SCRIPT}\necho hi\n`, "utf8");
      await chmod(hookPath, 0o755);
      await installCommitMsgHookOrWarn(root);
      expect((await inspectCommitMsgHook(root)).state).toBe("inactive");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the block without the script is inactive (git would refuse every commit)", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-inspect-no-script");
    try {
      await initRepo(root);
      await installCommitMsgHookOrWarn(root);
      await rm(path.join(root, ".git", "hooks", COMMIT_MSG_CHECK_SCRIPT));
      const state = await inspectCommitMsgHook(root);
      expect(state.state).toBe("inactive");
      expect(state.state === "inactive" && state.reason).toContain("is missing");
      expect(state.state === "inactive" && state.fix).toBe("keryx update");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("no-git outside a repository", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-inspect-no-repo");
    try {
      await mkdir(root, { recursive: true });
      expect(await inspectCommitMsgHook(root)).toEqual({ state: "no-git" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never active when git cannot report its hooks directory", async () => {
    // A bare .git directory that is not a repository: the hooks root resolves through the
    // fallback, but `git rev-parse --git-path hooks` fails.
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-inspect-rev-parse");
    try {
      await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      const state = await inspectCommitMsgHook(root);
      expect(state.state).toBe("inactive");
      expect(state.state === "inactive" && state.reason).toContain("effective hooks directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never active when git cannot be run", async () => {
    const root = uniqueTestRoot(tmpdir(), "keryx-commit-msg-no-git-binary");
    const originalPath = process.env.PATH;
    try {
      await initRepo(root);
      await installCommitMsgHookOrWarn(root);
      process.env.PATH = path.join(root, "empty-bin");
      const state = await inspectCommitMsgHook(root);
      expect(state.state).toBe("inactive");
      expect(state.state === "inactive" && state.reason).toContain("git executable was not found");
    } finally {
      process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
});
