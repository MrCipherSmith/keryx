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

/** Remote-tracking refs inspected per call; a clone with more is not a normal clone. */
const MAX_REFS = 200;
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

/** `<cwd relative to the repository root>/`, or "" at the root. null when `cwd` is not in a repository. */
export async function showPrefix(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ["rev-parse", "--show-prefix"]);
  if (result === undefined || result.code !== 0) {
    return null;
  }
  return result.stdout.trim();
}

/** Remote-tracking refs with distinct tips, `<remote>/HEAD` symbolic refs excluded. */
async function remoteRefs(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/"]);
  if (result === undefined || result.code !== 0) {
    return [];
  }
  const seenTips = new Set<string>();
  const refs: string[] = [];
  for (const line of lines(result.stdout)) {
    const space = line.indexOf(" ");
    if (space < 0) {
      continue;
    }
    const tip = line.slice(0, space);
    const ref = line.slice(space + 1);
    // Refs come from git itself, but `ls-tree <ref>` would read a leading dash
    // as an option, so one is refused rather than escaped.
    if (ref.startsWith("-") || !ref.startsWith("refs/remotes/") || ref.endsWith("/HEAD")) {
      continue;
    }
    // Two branches at one commit hold the same folders: asking once is enough.
    if (seenTips.has(tip)) {
      continue;
    }
    seenTips.add(tip);
    refs.push(ref);
    if (refs.length >= MAX_REFS) {
      break;
    }
  }
  return refs;
}

async function flowDirsOnRef(cwd: string, ref: string, flowsPath: string): Promise<string[]> {
  const result = await runGit(cwd, ["ls-tree", "-d", "--name-only", "--full-tree", ref, "--", `${flowsPath}/`]);
  if (result === undefined || result.code !== 0) {
    return [];
  }
  return lines(result.stdout)
    .map((entry) => path.posix.basename(entry))
    .filter((name) => /^\d+-/.test(name));
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
