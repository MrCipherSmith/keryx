import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../lib/fs";
import { resolveGitHooksRoot } from "../lib/git-hooks";

// Install merge/checkout git hooks that run `keryx sync` — so a `git pull`
// (post-merge) or branch switch / `fetch`+checkout (post-checkout) reports what
// the code change added/changed/deleted vs the built graph/wiki/memory. Advisory
// and non-blocking by design (a hook never auto-runs a heavy rebuild); the user
// runs `keryx sync --apply` to reconcile. Managed-block discipline: only this
// installer's block is touched, existing hook content is preserved.

const BLOCK_ID = "keryx-sync";
export const SYNC_HOOKS = ["post-merge", "post-checkout"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hookBody(hookName: string): string {
  const fn = `keryx_sync_${hookName.replace(/-/g, "_")}`;
  // post-checkout gets: $1 old-ref $2 new-ref $3 branch-flag (1=branch checkout).
  // Skip file checkouts. post-merge has no such arg.
  const guard =
    hookName === "post-checkout"
      ? '  [ "${3:-1}" = "1" ] || return 0\n'
      : "";
  return `${fn}() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
${guard}  command -v keryx >/dev/null 2>&1 || return 0
  # Advisory: report what changed vs the built artifacts. Run 'keryx sync --apply'
  # to reconcile graph/wiki/memory.
  keryx sync 2>/dev/null || true
  return 0
}
${fn} "$@"`;
}

async function writeManagedHook(projectRoot: string, hookName: string): Promise<boolean> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) {
    return false;
  }
  await mkdir(hooksRoot, { recursive: true });
  const hookPath = path.join(hooksRoot, hookName);

  const start = `# keryx:${BLOCK_ID}:begin`;
  const end = `# keryx:${BLOCK_ID}:end`;
  const block = `${start}\n${hookBody(hookName)}\n${end}`;
  const existing = (await pathExists(hookPath)) ? await readFile(hookPath, "utf8") : "#!/usr/bin/env sh\n";
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : `${existing.trimEnd()}\n\n${block}\n`;
  await writeFile(hookPath, next, "utf8");
  await chmod(hookPath, 0o755);
  return true;
}

async function stripManagedHook(projectRoot: string, hookName: string): Promise<boolean> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) {
    return false;
  }
  const hookPath = path.join(hooksRoot, hookName);
  if (!(await pathExists(hookPath))) {
    return false;
  }
  const start = `# keryx:${BLOCK_ID}:begin`;
  const end = `# keryx:${BLOCK_ID}:end`;
  const pattern = new RegExp(`\\n*${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n*`);
  const existing = await readFile(hookPath, "utf8");
  if (!pattern.test(existing)) {
    return false;
  }
  await writeFile(hookPath, `${existing.replace(pattern, "\n").trimEnd()}\n`, "utf8");
  return true;
}

export async function installSyncHooks(projectRoot: string): Promise<string[]> {
  const installed: string[] = [];
  for (const hook of SYNC_HOOKS) {
    if (await writeManagedHook(projectRoot, hook)) installed.push(hook);
  }
  return installed;
}

export async function uninstallSyncHooks(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];
  for (const hook of SYNC_HOOKS) {
    if (await stripManagedHook(projectRoot, hook)) removed.push(hook);
  }
  return removed;
}
