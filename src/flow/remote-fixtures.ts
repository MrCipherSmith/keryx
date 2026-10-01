// Test fixtures for flow 384: a temporary git repository, and remote-tracking
// refs holding flow folders this clone never had locally. Built with plumbing
// and a throwaway index, so the work tree and the real index stay untouched and
// no network or second clone is needed.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...IDENTITY, ...env },
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  }
  return out.trim();
}

/** A fresh `git init` directory with `.metaproject/` present. */
export async function gitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await git(root, ["init", "-q"]);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

/** Commit everything in the work tree. */
export async function commitAll(root: string, message = "seed"): Promise<void> {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", message]);
}

/**
 * Create `refs/remotes/<name>` at a commit whose tree holds exactly
 * `.metaproject/flows/<dir>/flow.json` for each folder in `dirs`.
 */
export async function addRemoteRef(root: string, name: string, dirs: string[]): Promise<void> {
  const scratch = await mkdtemp(path.join(tmpdir(), "keryx-remote-fixture-"));
  const blobFile = path.join(scratch, "flow.json");
  await writeFile(blobFile, "{}\n", "utf8");
  const blob = await git(root, ["hash-object", "-w", blobFile]);
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  for (const dir of dirs) {
    await git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},.metaproject/flows/${dir}/flow.json`], env);
  }
  const tree = await git(root, ["write-tree"], env);
  const commit = await git(root, ["commit-tree", tree, "-m", `remote ${name}`], env);
  await git(root, ["update-ref", `refs/remotes/${name}`, commit]);
}
