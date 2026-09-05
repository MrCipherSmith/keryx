// What the ablation actually removes, and proof that it removed it.
//
// The measurement's whole validity rests on one claim: the two arms differ in
// the project's own context and in nothing else. Two ways that claim was false
// in practice, both found by the operator asking whether the keryx CLI was part
// of the trial:
//
//  1. keryx installs its hooks into `.claude/settings.json`, which is tracked in
//     the repository and was NOT part of the strip list. So the `context-off`
//     arm kept a PreToolUse hook that refuses raw `grep` and redirects it to
//     `keryx ctx rg` — pointing at a workspace the strip had just deleted. The
//     control arm was being obstructed by the system under test while receiving
//     none of its benefits, which manufactures a win.
//
//  2. On the intended primary repository, `.metaproject/` is in `.gitignore`.
//     A worktree comes out of git, so the `context-on` arm would have had no
//     graph, no wiki and no routing index — nothing to strip and nothing to
//     help. Fifty tasks would have compared two near-identical trees, returned
//     the expected zero, and been written up as an honest negative result.
//
// The second is the dangerous one: it produces a plausible finding pointed the
// wrong way. Hence `assertArmContext` — the arms are inspected after setup and
// before the agent starts, and a run that cannot show the ablation happened
// fails instead of scoring.

import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The one that carries the substance under test — graph, wiki, routing index.
 *
 * `AGENTS.md` and `CLAUDE.md` are pointers into it. A tree with those but
 * without this has routing instructions that resolve to nothing, which is not
 * the `context-on` arm the design describes.
 */
export const SUBSTANTIVE_CONTEXT = ".metaproject";

/** Where an agent runtime reads project-local hook configuration. */
export const CLAUDE_SETTINGS = path.join(".claude", "settings.json");

interface HookGroup {
  readonly _keryxManaged?: string;
  readonly [key: string]: unknown;
}

/**
 * Remove keryx's own hook registrations from a worktree, leaving the project's
 * alone.
 *
 * Marker-based rather than "delete `.claude/`", because a repository's other
 * hooks are part of the repository and belong to BOTH arms. The intended
 * primary repository has its own `scripts/claude-guard.mjs` guard registered
 * the same way; that one fires identically on both sides and confounds nothing.
 * Deleting the whole file would strip it from the control arm only, which is the
 * same asymmetry in the other direction.
 *
 * Malformed JSON is left untouched: an agent runtime cannot load it either, so
 * there is nothing active to remove, and rewriting a file we failed to parse
 * would be a worse outcome than leaving it.
 */
export async function stripKeryxHooks(worktreePath: string): Promise<void> {
  const file = path.join(worktreePath, CLAUDE_SETTINGS);
  if (!existsSync(file)) return;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }

  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks !== undefined && hooks !== null) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = (groups as HookGroup[]).filter((group) => group?._keryxManaged === undefined);
      if (kept.length === 0) delete hooks[event];
      else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }
  delete settings._keryxManaged;

  // A file left holding `{}` is not the same as no file, but it is close enough
  // to be misleading in a diff; a settings file that configures nothing is
  // removed so the control arm looks like what it is.
  if (Object.keys(settings).length === 0) {
    await rm(file, { force: true });
    return;
  }
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** Every keryx-managed hook still registered in a worktree. Empty means clean. */
export async function keryxHooksIn(worktreePath: string): Promise<string[]> {
  const file = path.join(worktreePath, CLAUDE_SETTINGS);
  if (!existsSync(file)) return [];
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks === undefined || hooks === null) return [];

  const found: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as HookGroup[]) {
      if (group?._keryxManaged !== undefined) found.push(`${event}:${String(group._keryxManaged)}`);
    }
  }
  return found;
}

/**
 * Refuse to run an arm that is not the arm it claims to be.
 *
 * This is the guard that would have stopped the primary sweep before it spent
 * anything. `.metaproject/` is gitignored there, so `context-on` would have
 * checked out without it — and every downstream number would still have looked
 * like a result.
 *
 * Both directions are checked. A `context-off` arm that kept its context scores
 * a false null; a `context-on` arm that never had any scores a false negative;
 * and a `context-off` arm still carrying keryx's hooks is the obstruction case.
 * None of the three is visible in the output they produce, which is exactly why
 * they are asserted here rather than trusted.
 */
export async function assertArmContext(
  worktreePath: string,
  arm: "context-on" | "context-off",
  contextPaths: readonly string[],
): Promise<void> {
  const present = contextPaths.filter((entry) => existsSync(path.join(worktreePath, entry)));

  if (arm === "context-on") {
    if (!present.includes(SUBSTANTIVE_CONTEXT)) {
      throw new Error(
        `context-on arm has no ${SUBSTANTIVE_CONTEXT}/ in ${worktreePath} — there is nothing under test. ` +
          `A worktree is checked out from git, so this is what happens when ${SUBSTANTIVE_CONTEXT}/ is ` +
          `gitignored or was never committed. Both arms would be near-identical and the sweep would ` +
          `report a confident "no effect" for a context that was never present.`,
      );
    }
    return;
  }

  if (present.length > 0) {
    throw new Error(
      `context-off arm still has ${present.join(", ")} in ${worktreePath} — the ablation did not happen`,
    );
  }
  const hooks = await keryxHooksIn(worktreePath);
  if (hooks.length > 0) {
    throw new Error(
      `context-off arm still has keryx-managed hooks (${hooks.join(", ")}) in ${worktreePath} — ` +
        `the control arm would be steered into a workspace that was just deleted, which handicaps it ` +
        `rather than leaving it alone`,
    );
  }
}
