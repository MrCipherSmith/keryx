// Spec §5.3: an agent working in a linked worktree is told the absolute root and
// where its metaproject index is, so it reads the worktree's own index and not the
// main checkout's. Cheap: one `rev-parse` pair, no config, no file reads.

import path from "node:path";
import { resolveWorktreeContext } from "./context";

/** The two lines for an agent whose cwd is inside a linked worktree; `undefined` in the main checkout or outside git. */
export async function worktreeAgentLines(cwd: string): Promise<[string, string] | undefined> {
  try {
    const context = await resolveWorktreeContext(cwd);
    if (context.isMain) return undefined;
    return [`Worktree root: ${context.root}`, `Metaproject index: ${path.join(context.root, ".metaproject", "index.md")}`];
  } catch {
    return undefined;
  }
}

/** `worktreeAgentLines` joined for appending to a prompt; empty string when there is nothing to add. */
export async function worktreeAgentBlock(cwd: string): Promise<string> {
  const lines = await worktreeAgentLines(cwd);
  return lines === undefined ? "" : lines.join("\n");
}
