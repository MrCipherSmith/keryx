import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { link, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveGitCommonDir } from "../lib/git-worktrees";
import { gitDirOf } from "./git";

/** The per-worktree label (spec §3). A local label for ports and diagnostics, not an access identity. */
export interface Checkout {
  version: 1;
  checkoutId: string;
  createdAt: string;
  flowId?: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** `<worktree-git-dir>/keryx` — where everything the package writes about one worktree lives. */
export function keryxDirIn(gitDir: string): string {
  return path.join(gitDir, "keryx");
}

function checkoutFileIn(gitDir: string): string {
  return path.join(keryxDirIn(gitDir), "checkout.json");
}

function parseCheckout(text: string): Checkout | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return undefined;
    const record = raw as Record<string, unknown>;
    if (record.version !== 1 || typeof record.checkoutId !== "string" || !UUID_V4.test(record.checkoutId)) return undefined;
    if (typeof record.createdAt !== "string") return undefined;
    if (record.flowId !== undefined && (typeof record.flowId !== "string" || record.flowId.length === 0)) return undefined;
    return {
      version: 1,
      checkoutId: record.checkoutId,
      createdAt: record.createdAt,
      ...(typeof record.flowId === "string" && { flowId: record.flowId }),
    };
  } catch {
    return undefined;
  }
}

/** The label stored in the worktree git directory `gitDir`; `undefined` when absent or unreadable. */
export async function readCheckoutFile(gitDir: string): Promise<Checkout | undefined> {
  try {
    return parseCheckout(await readFile(checkoutFileIn(gitDir), "utf8"));
  } catch {
    return undefined;
  }
}

/** True when `cwd` is the main checkout: its git directory is the shared one, so it has no label. */
export async function isMainCheckout(cwd: string): Promise<boolean> {
  const [gitDir, commonDir] = await Promise.all([gitDirOf(cwd), resolveGitCommonDir(cwd)]);
  if (commonDir === undefined) return false;
  const canonical = async (target: string): Promise<string> => realpath(target).catch(() => target);
  return (await canonical(gitDir)) === (await canonical(commonDir));
}

/** The label of the worktree at `cwd`; `undefined` for the main checkout and for a worktree not yet labelled. */
export async function readCheckout(cwd: string): Promise<Checkout | undefined> {
  if (await isMainCheckout(cwd)) return undefined;
  return readCheckoutFile(await gitDirOf(cwd));
}

/**
 * The label of the worktree at `cwd`, created if absent. Idempotent: an existing
 * label is returned unchanged (`flowId` is not rewritten). A fresh creation always
 * draws a new random id, so a re-created worktree never inherits a predecessor's
 * records. The main checkout has no label and yields `undefined`.
 */
export async function ensureCheckout(cwd: string, opts: { flowId?: string; now?: () => Date } = {}): Promise<Checkout | undefined> {
  if (await isMainCheckout(cwd)) return undefined;
  const gitDir = await gitDirOf(cwd);
  const existing = await readCheckoutFile(gitDir);
  if (existing !== undefined) return existing;

  const checkout: Checkout = {
    version: 1,
    checkoutId: randomUUID(),
    createdAt: (opts.now?.() ?? new Date()).toISOString(),
    ...(opts.flowId !== undefined && opts.flowId.length > 0 && { flowId: opts.flowId }),
  };
  const dir = keryxDirIn(gitDir);
  await mkdir(dir, { recursive: true });
  // Write a private temp file, then hard-link it into place: link() fails when the
  // label already exists, so a concurrent `ensure` cannot replace the winner's id.
  const temp = path.join(dir, `checkout.json.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(checkout, null, 2)}\n`, "utf8");
  try {
    await link(temp, checkoutFileIn(gitDir));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      const winner = await readCheckoutFile(gitDir);
      if (winner !== undefined) return winner;
    }
    throw cause;
  } finally {
    await rm(temp, { force: true });
  }
  return checkout;
}

/** Ids of every live linked worktree's label: the `keryx/checkout.json` under each `<common>/worktrees/<name>` directory. */
export async function listLiveCheckoutIds(commonDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(path.join(commonDir, "worktrees"));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names.sort()) {
    const checkout = await readCheckoutFile(path.join(commonDir, "worktrees", name));
    if (checkout !== undefined) ids.push(checkout.checkoutId);
  }
  return ids;
}

/** Synchronous twin of {@link listLiveCheckoutIds}, for use inside a file-lock section that must not yield. */
export function listLiveCheckoutIdsSync(commonDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(path.join(commonDir, "worktrees"));
  } catch {
    return [];
  }
  const ids: string[] = [];
  for (const name of names.sort()) {
    try {
      const checkout = parseCheckout(readFileSync(checkoutFileIn(path.join(commonDir, "worktrees", name)), "utf8"));
      if (checkout !== undefined) ids.push(checkout.checkoutId);
    } catch {
      // A worktree without a readable label holds no records.
    }
  }
  return ids;
}
