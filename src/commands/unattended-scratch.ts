// Flow 295 (N3) / flow 301 (AC12): the ONE safety check every unattended run's scratch
// parent must pass before anything is written under it — shared by `trigger-agent-task.ts`
// (`agentTaskScratchParent`, `keryx-agent-tasks`) and `trigger-dispatch.ts`
// (`triggerDispatchScratchParent`, `keryx-trigger-worktrees`), so both get the identical
// guarantee rather than two copies that could quietly drift.
//
// A shared `/tmp` (or a shared TMPDIR outside `/tmp`) lets another local user
// pre-create the directory world-writable and swap our children, so the directory must
// be a real directory (not a symlink), owned by us, and mode 0700. Anything else
// refuses the run rather than writing into something it does not control.

import { lstatSync } from "node:fs";
import { mkdir } from "node:fs/promises";

export async function ensureScratchParent(
  dir: string,
): Promise<{ readonly ok: true; readonly dir: string } | { readonly ok: false; readonly reason: string }> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
      return { ok: false, reason: `could not create the scratch parent ${dir} (${error instanceof Error ? error.message : String(error)})` };
    }
  }
  const st = lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: `the scratch parent ${dir} is not a plain directory (a symlink?) — refusing` };
  if (uid !== undefined && st.uid !== uid) return { ok: false, reason: `the scratch parent ${dir} is owned by uid ${st.uid}, not by you (${uid}) — refusing` };
  if (process.platform !== "win32" && (st.mode & 0o777) !== 0o700) {
    return { ok: false, reason: `the scratch parent ${dir} has mode ${(st.mode & 0o777).toString(8)}, not 700 — refusing; remove it and rerun` };
  }
  return { ok: true, dir };
}
