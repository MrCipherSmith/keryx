// Shared "extend, don't replace" managed-hook-block writer.
//
// `src/commands/update.ts`'s `installManagedHook`/`removeManagedHook` (mirrored,
// byte-for-byte at the time of writing, in `src/commands/init.ts` — flow 286 T5
// survey, `context.md`) already prove the shape AC5 needs: MULTIPLE
// independently-named blocks can live in the SAME git hook file, each delimited
// by its own `# keryx:<blockId>:begin/end` markers, and any one of them can be
// added/updated/removed without touching the others already there — including
// ones written by a DIFFERENT installer (`src/sync/hooks.ts`'s `keryx-sync`
// block uses the identical marker convention on `post-merge`/`post-checkout`,
// just under its own narrower single-block writer). `src/trigger/hooks.ts`
// (flow 286 T9) needs exactly that mechanism for `keryx trigger install`, so it
// is pulled out here rather than re-derived a third time or, worse, replacing
// `src/sync/hooks.ts`'s installer outright — which is the literal thing AC5
// forbids ("extends... instead of replacing it").
//
// `update.ts`/`init.ts` were later refactored (R1-F3) onto one shared writer
// in `src/lib/managed-git-hook.ts` instead of their own local copies; this
// module's own on-disk WRITE logic (the block-marker regex, the
// function-form `replace`) is still a separate copy — its `hookName` type
// (`TriggerEventName`: post-merge/post-commit/post-checkout) and its
// `boolean` "did it write" return contract both differ from
// `managed-git-hook.ts`'s narrower `"post-commit" | "pre-push"` / `void`
// pair, so merging the two write paths outright is a larger change than this
// module needs. What it DID need, and lacked (R2-F5): `managed-git-hook.ts`'s
// symlink-containment check (R1-F6) — `resolveGitHooksRoot` alone never
// rejected a `.git/hooks` (or a hook file under it) that is itself a symlink
// resolving outside the project. That check — `resolveContainedHookPath` — is
// now reused here directly, so the ONE escape check has exactly one
// implementation even though there remain two hook-block WRITERS.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs";
import { resolveGitHooksRoot } from "./git-hooks";
import { ManagedGitHookEscapeError, resolveContainedHookPath } from "./managed-git-hook";

export { ManagedGitHookEscapeError };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockPatternFor(blockId: string): RegExp {
  const start = `# keryx:${blockId}:begin`;
  const end = `# keryx:${blockId}:end`;
  return new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
}

/**
 * Write (or replace) ONE managed block, identified by `blockId`, into
 * `hookName` under this project's git hooks directory. Every other block
 * already in the file — one this function wrote under a different `blockId`,
 * one a DIFFERENT installer wrote under the same `# keryx:<id>:begin/end`
 * convention (e.g. `src/sync/hooks.ts`'s `keryx-sync` block), or hand-authored
 * content — is preserved byte-for-byte. Returns `false` (nothing written) only
 * when there is no `.git` hooks directory to write into at all. R2-F5: reuses
 * `managed-git-hook.ts`'s `resolveContainedHookPath` for the symlink-escape
 * check (R1-F6) — throws `ManagedGitHookEscapeError` (re-exported from this
 * module) on an escaping or dangling hooks dir/hook file, same as
 * `installManagedHook` in `src/lib/managed-git-hook.ts`.
 */
export async function installManagedHook(
  projectRoot: string,
  hookName: string,
  blockId: string,
  content: string,
): Promise<boolean> {
  const resolved = await resolveContainedHookPath(projectRoot, hookName);
  if (!resolved) return false;
  const { hooksRoot, hookPath } = resolved;
  await mkdir(hooksRoot, { recursive: true });
  const managedBlock = `# keryx:${blockId}:begin\n${content.trim()}\n# keryx:${blockId}:end`;
  const existing = (await pathExists(hookPath)) ? await readFile(hookPath, "utf8") : "#!/usr/bin/env sh\n";
  const pattern = blockPatternFor(blockId);
  // `() => managedBlock`, not `managedBlock`: see `src/commands/update.ts`'s
  // `installManagedHook` comment. These blocks are shell scripts full of `$`,
  // and the STRING form of `String.replace` reads `$'`/`` $` `` in the
  // replacement as substitution patterns — a hook containing one spliced the
  // rest of the file back in and duplicated every managed block below it. The
  // function form has no such reading. Preserved here for the identical
  // reason, on the identical class of content.
  const next = pattern.test(existing)
    ? existing.replace(pattern, () => managedBlock)
    : `${existing.trimEnd()}\n\n${managedBlock}\n`;
  await writeFile(hookPath, next, "utf8");
  await chmod(hookPath, 0o755);
  return true;
}

/**
 * Strip a single managed block, identified by `blockId`, from `hookName`,
 * preserving every other block and any hand-authored content. No-op
 * (`false`) when the hook file, or that block inside it, is absent. R2-F5:
 * same containment check as {@link installManagedHook}.
 */
export async function removeManagedHook(projectRoot: string, hookName: string, blockId: string): Promise<boolean> {
  const resolved = await resolveContainedHookPath(projectRoot, hookName);
  if (!resolved) return false;
  const { hookPath } = resolved;
  if (!(await pathExists(hookPath))) return false;
  const existing = await readFile(hookPath, "utf8");
  const start = `# keryx:${blockId}:begin`;
  const end = `# keryx:${blockId}:end`;
  const pattern = new RegExp(`\\n*${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n*`);
  if (!pattern.test(existing)) return false;
  await writeFile(hookPath, `${existing.replace(pattern, "\n").trimEnd()}\n`, "utf8");
  await chmod(hookPath, 0o755);
  return true;
}

/** Read-only: whether `blockId` is currently present in `hookName` — for `keryx trigger list`'s "hook installed" column. Never mutates. */
export async function hasManagedHook(projectRoot: string, hookName: string, blockId: string): Promise<boolean> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) return false;
  const hookPath = path.join(hooksRoot, hookName);
  if (!(await pathExists(hookPath))) return false;
  const existing = await readFile(hookPath, "utf8");
  return blockPatternFor(blockId).test(existing);
}
