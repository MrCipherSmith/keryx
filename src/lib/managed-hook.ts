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
// `update.ts`/`init.ts` keep their own local copies for now: refactoring those
// two (already-shipped, unrelated call sites) to import from here instead is a
// reasonable follow-up, left undone on purpose to keep this dispatch's diff
// scoped to flow 286 T8-T10 — the same call this codebase already makes
// elsewhere (see `src/trigger/run.ts`'s own note on the lock-scope gap it
// left open). What matters for AC5 is that the ON-DISK CONVENTION is
// identical, which it is: same marker format, same function-form-replace
// safety fix, same file layout — so a hook file this module writes into and
// one `update.ts`/`init.ts` also writes into coexist exactly as if they were
// the same code, because for every property that matters here, they are.

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs";
import { resolveGitHooksRoot } from "./git-hooks";

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
 * when there is no `.git` hooks directory to write into at all.
 */
export async function installManagedHook(
  projectRoot: string,
  hookName: string,
  blockId: string,
  content: string,
): Promise<boolean> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) return false;
  await mkdir(hooksRoot, { recursive: true });
  const hookPath = path.join(hooksRoot, hookName);
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
 * (`false`) when the hook file, or that block inside it, is absent.
 */
export async function removeManagedHook(projectRoot: string, hookName: string, blockId: string): Promise<boolean> {
  const hooksRoot = await resolveGitHooksRoot(projectRoot);
  if (!hooksRoot) return false;
  const hookPath = path.join(hooksRoot, hookName);
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
