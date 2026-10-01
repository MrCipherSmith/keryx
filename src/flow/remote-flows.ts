import path from "node:path";

// Flow 384: the numbers other clones already spent.
//
// Allocation (`allocation.ts`) is scoped to ONE clone: its ledger lives in the
// git common dir. A second clone, or a branch this clone never fetched, hands
// out the same number — on 2026-10-01 origin/main held flows 360-365 that were
// different flows from the local 360-365. What this clone CAN see without a
// network is the remote-tracking refs it already has, so this module reads the
// flow folders those refs hold. Nothing here fetches; a ref that was never
// fetched is exactly the case no local tool can see, and the repair is
// `flow renumber`.
//
// Everything fails soft: no git, not a repository, no remotes, a ref git
// cannot read — each answers "nothing known", never an error. A guard that
// throws would block `flow init` for a reason the operator cannot act on.

/**
 * Remote-tracking refs inspected per call. A clone with more is not a normal
 * clone; the refs that decide a number (`<remote>/main`, `<remote>/master`, the
 * branch `<remote>/HEAD` points at) are read first, so the cap never drops them.
 */
export const MAX_REFS = 500;
/** `git ls-tree` runs in parallel up to this many at a time. */
const CONCURRENCY = 8;

export type RemoteFlowDir = { ref: string; dir: string };

export type GitResult = { code: number; stdout: string };

export async function runGit(cwd: string, args: string[]): Promise<GitResult | undefined> {
  try {
    // An argv array, never a shell string: nothing here is interpreted.
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const stdout = await new Response(proc.stdout).text();
    return { code: await proc.exited, stdout };
  } catch {
    // `git` itself is unavailable, or `cwd` is gone: same answer as "not a repository".
    return undefined;
  }
}

export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The entries of NUL-terminated git output (`-z`). Without `-z` git C-quotes a
 * non-ASCII or control-character path, which would never equal the path that
 * was asked for; with it every path is the raw bytes. Nothing is trimmed: a
 * path may legitimately start or end with a space.
 */
export function nulSplit(text: string): string[] {
  return text.split("\0").filter((entry) => entry.length > 0);
}

/**
 * A folder name from another branch, safe to print: control characters (C0,
 * DEL, C1, so ESC too) are removed. `-z` hands over the raw name, and a name
 * that carries a terminal escape must not reach an operator's screen intact.
 */
export function safeDirName(dir: string): string {
  let out = "";
  for (const char of dir) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 0x1f && (code < 0x7f || code > 0x9f)) {
      out += char;
    }
  }
  return out;
}

/** `<cwd relative to the repository root>/`, or "" at the root. null when `cwd` is not in a repository. */
export async function showPrefix(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--show-prefix"]);
  if (result === undefined || result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

export type RefEntry = { tip: string; ref: string; symref: string };

/**
 * Order refs so the ones that decide a flow number survive the cap: first
 * `<remote>/main` and `<remote>/master`, then the branch each `<remote>/HEAD`
 * points at, then everything else alphabetically. `<remote>/HEAD` itself is
 * dropped, and so is a ref whose tip an earlier one already has (two branches at
 * one commit hold the same folders: asking once is enough). Truncated to `max`.
 */
export function orderRemoteRefs(entries: readonly RefEntry[], max: number = MAX_REFS): string[] {
  const headTargets = new Set(entries.map((entry) => entry.symref).filter((symref) => symref.length > 0));
  const rank = (ref: string): number => {
    if (/^refs\/remotes\/[^/]+\/(main|master)$/.test(ref)) {
      return 0;
    }
    return headTargets.has(ref) ? 1 : 2;
  };
  const candidates = entries
    .filter((entry) => entry.ref.startsWith("refs/remotes/") && !entry.ref.endsWith("/HEAD") && entry.symref === "")
    .sort((a, b) => rank(a.ref) - rank(b.ref) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  const seenTips = new Set<string>();
  const refs: string[] = [];
  for (const entry of candidates) {
    if (seenTips.has(entry.tip)) {
      continue;
    }
    seenTips.add(entry.tip);
    refs.push(entry.ref);
    if (refs.length >= max) {
      break;
    }
  }
  return refs;
}

/** Remote-tracking refs to read, in the order `orderRemoteRefs` gives. */
async function remoteRefs(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["for-each-ref", "--format=%(objectname) %(refname) %(symref)", "refs/remotes/"]);
  if (result === undefined || result.code !== 0) {
    return [];
  }
  const entries: RefEntry[] = [];
  for (const line of lines(result.stdout)) {
    const [tip, ref, symref] = line.split(" ");
    if (tip === undefined || ref === undefined) {
      continue;
    }
    entries.push({ tip, ref, symref: symref ?? "" });
  }
  return orderRemoteRefs(entries);
}

async function flowDirsOnRef(cwd: string, ref: string, flowsPath: string): Promise<string[]> {
  const result = await runGit(cwd, ["ls-tree", "-z", "-d", "--name-only", "--full-tree", ref, "--", `${flowsPath}/`]);
  if (result === undefined || result.code !== 0) {
    return [];
  }
  // Exactly the shape `listFlowDirs` accepts locally: three digits, then a dash.
  // A folder name on another branch is untrusted input (`2026-notes`, `9999-x`).
  return nulSplit(result.stdout)
    .map((entry) => path.posix.basename(entry))
    .filter((name) => /^\d{3}-/.test(name));
}

/**
 * Flow folders held by the remote-tracking refs this clone already has, as
 * `{ ref, dir }` pairs (`ref` is the short name, e.g. `origin/main`). No
 * network. `[]` for anything it cannot read.
 */
export async function knownRemoteFlowDirs(cwd: string): Promise<RemoteFlowDir[]> {
  try {
    const prefix = await showPrefix(cwd);
    if (prefix === null) {
      return [];
    }
    const refs = await remoteRefs(cwd);
    if (refs.length === 0) {
      return [];
    }
    const flowsPath = `${prefix}.metaproject/flows`;
    const found: RemoteFlowDir[][] = new Array<RemoteFlowDir[]>(refs.length).fill([]);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < refs.length) {
        const index = next;
        next += 1;
        const ref = refs[index];
        if (ref === undefined) {
          continue;
        }
        const short = ref.slice("refs/remotes/".length);
        found[index] = (await flowDirsOnRef(cwd, ref, flowsPath)).map((dir) => ({ ref: short, dir }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, refs.length) }, () => worker()));
    return found.flat();
  } catch {
    return [];
  }
}

/** The number a flow folder name starts with (`005-2026-...` is 5); NaN when it has none. */
export function flowNumberOfDir(dir: string): number {
  const dash = dir.indexOf("-");
  return dash > 0 ? Number(dir.slice(0, dash)) : Number.NaN;
}

/** The numbers used by flow folders on known remote branches. */
export async function remoteFlowNumbers(cwd: string): Promise<number[]> {
  const dirs = await knownRemoteFlowDirs(cwd);
  const numbers = new Set<number>();
  for (const { dir } of dirs) {
    const value = flowNumberOfDir(dir);
    if (!Number.isNaN(value)) {
      numbers.add(value);
    }
  }
  return [...numbers].sort((a, b) => a - b);
}
