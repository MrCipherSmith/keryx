import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isUnattendedProtectedPath } from "../trigger/unattended";
import { reviewTool } from "./github-cli";
import { safeSourcePath } from "./pinned-source";
import type { OwnedPullRequest } from "./watcher-rebase";
import type { WatcherKey } from "./watcher-types";

const exec = promisify(execFile);
const sha = /^[a-f0-9]{40}$/;
const githubRepo = /^[a-z0-9-]+\/[\w.-]+$/i;
const pushHook = `#!/bin/sh
set -eu
count=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ "$local_sha" = "$KERYX_REPAIR_NEW" ] &&
    [ "$remote_ref" = "$KERYX_REPAIR_REF" ] &&
    [ "$remote_sha" = "$KERYX_REPAIR_OLD" ] || exit 1
  count=$((count + 1))
done
[ "$count" = 1 ]
`;

const regular = (mode: string) => mode === "100644" || mode === "100755";
export function repairPathAllowed(file: string) {
  const lower = file.toLowerCase();
  return safeSourcePath(file) && !isUnattendedProtectedPath(file) &&
    !lower.split("/").some(part => part === ".git" || part === ".github" || part === ".metaproject" ||
      part === ".gitattributes" || part === ".gitmodules" || part.startsWith(".env"));
}

export class RepairCheckout {
  private readonly gitBin: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly branchRef: string;
  private readonly headRepo: string;
  private readonly head: string;
  private readonly base: string;
  private readonly hooks: string;
  readonly cwd: string;

  private constructor(private readonly directory: string, subject: OwnedPullRequest, private readonly signal: AbortSignal) {
    const { pull, auth } = subject;
    const repo = pull.headRepository?.nameWithOwner;
    if (!repo || !githubRepo.test(repo) || repo.split("/").some(part => part === "." || part === "..") ||
        !sha.test(pull.headRefOid) || !sha.test(pull.baseRefOid)) throw new Error("GitHub returned an invalid repair target.");
    this.cwd = join(directory, "checkout");
    this.hooks = join(directory, "hooks");
    this.gitBin = reviewTool("git", auth.env);
    this.env = {
      PATH: auth.env.PATH, HOME: auth.env.HOME, XDG_CONFIG_HOME: auth.env.XDG_CONFIG_HOME,
      GH_CONFIG_DIR: auth.env.GH_CONFIG_DIR, GH_TOKEN: auth.env.GH_TOKEN, GITHUB_TOKEN: auth.env.GITHUB_TOKEN,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_EDITOR: "/usr/bin/true",
    };
    this.branchRef = "refs/heads/" + pull.headRefName;
    this.headRepo = repo;
    this.head = pull.headRefOid;
    this.base = pull.baseRefOid;
  }

  static async create(subject: OwnedPullRequest, key: WatcherKey, number: number, signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), "keryx-pr-repair-"));
    try {
      const checkout = new RepairCheckout(directory, subject, signal);
      await mkdir(checkout.cwd);
      await mkdir(checkout.hooks);
      await writeFile(join(checkout.hooks, "pre-push"), pushHook, { mode: 0o700 });
      await checkout.prepare(key, number, subject.pull.baseRefName, subject.viewerId);
      return checkout;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async dispose() {
    await rm(this.directory, { recursive: true, force: true });
  }

  private async git(args: string[], env: NodeJS.ProcessEnv = this.env, hooks = "/dev/null") {
    this.signal.throwIfAborted();
    const { stdout } = await exec(this.gitBin, [
      "-c", "core.hooksPath=" + hooks, "-c", "credential.helper=",
      "-c", "credential.https://github.com.helper=!gh auth git-credential", ...args,
    ], { cwd: this.cwd, env, signal: this.signal, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  private async prepare(key: WatcherKey, number: number, baseBranch: string, viewerId?: number) {
    const target = `https://github.com/${key.repo}.git`;
    const baseRef = "refs/heads/" + baseBranch;
    await this.git(["init", "--quiet", "--template="]);
    await this.git(["check-ref-format", this.branchRef]);
    await this.git(["check-ref-format", baseRef]);
    await this.git(["fetch", "--quiet", "--no-tags", target, `${baseRef}:refs/keryx/base`, `refs/pull/${number}/head:refs/keryx/head`]);
    const head = (await this.git(["rev-parse", "refs/keryx/head"])).trim();
    const base = (await this.git(["rev-parse", "refs/keryx/base"])).trim();
    if (head !== this.head || base !== this.base) throw new Error("The pull request advanced before the checkout was prepared.");
    await this.git(["checkout", "--quiet", "--detach", this.head]);
    // The host commits with a GitHub-safe identity. No operator email is read from Git config.
    await this.git(["config", "user.name", key.viewer]);
    const emailName = Number.isSafeInteger(viewerId) && viewerId! > 0 ? `${viewerId}+${key.viewer}` : key.viewer;
    await this.git(["config", "user.email", `${emailName}@users.noreply.github.com`]);
  }

  async mergeBase(): Promise<string[]> {
    try {
      await this.git(["merge", "--no-commit", "--no-ff", this.base]);
    } catch (error) {
      const files = (await this.git(["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
      if (!files.length) throw error;
      if (files.some(file => !repairPathAllowed(file))) throw new Error("A conflict touches a file that requires manual resolution.", { cause: error });
      return files;
    }
    return [];
  }

  async commit(message: string, conflictFiles: string[]): Promise<string | null> {
    const modified = (await this.git(["diff", "--name-only", "-z"])).split("\0").filter(Boolean);
    const untracked = (await this.git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const edits = [...new Set([...modified, ...untracked])];
    if (conflictFiles.length && edits.some(file => !conflictFiles.includes(file))) {
      throw new Error("The conflict repair changed an unrelated file.");
    }
    for (const file of edits) {
      if (!repairPathAllowed(file)) throw new Error("A repair attempted to change a protected file.");
      const info = await lstat(join(this.cwd, file)).catch(() => null);
      if (info && (!info.isFile() || info.size > 1024 * 1024)) throw new Error("A repair changed a non-regular or oversized file.");
    }
    if (edits.length > 60) throw new Error("The repair changed too many files for an automatic push.");
    if (edits.length) await this.git(["--literal-pathspecs", "add", "-A", "--", ...edits]);
    if ((await this.git(["ls-files", "--unmerged"])).trim()) throw new Error("The merge still has unresolved conflicts.");
    const delta = (await this.git(["diff", "--cached", "--raw", "-z", "--no-renames"])).split("\0");
    for (let index = 0; index + 1 < delta.length; index += 2) {
      const entry = delta[index]!;
      if (!entry.startsWith(":")) throw new Error("Git returned an invalid repair diff.");
      const [before, after] = entry.slice(1).split(" ");
      if (!(before === "000000" || regular(before ?? "")) || !(after === "000000" || regular(after ?? "")))
        throw new Error("The repair modified a symlink or submodule.");
    }
    // Git checks for remaining conflict markers. For a merge, limit the check to
    // the resolved paths so unrelated legacy whitespace in the base stays intact.
    if (conflictFiles.length || !await this.hasMerge()) {
      await this.git(["--literal-pathspecs", "diff", "--cached", "--check", "--", ...conflictFiles]);
    }
    if (!delta[0] && !await this.hasMerge()) return null;
    await this.git(["commit", "--quiet", "-m", message]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  private async hasMerge() {
    return Boolean(await this.git(["rev-parse", "--verify", "MERGE_HEAD"]).catch(() => ""));
  }

  async push(commit: string, authorize: <T>(act: () => T) => T) {
    if (!sha.test(commit)) throw new Error("Invalid repair commit.");
    await this.git(["merge-base", "--is-ancestor", this.head, commit]);
    await authorize(() => this.git(["push", "--porcelain", "--no-follow-tags", `https://github.com/${this.headRepo}.git`, `${commit}:${this.branchRef}`], {
      ...this.env, KERYX_REPAIR_OLD: this.head, KERYX_REPAIR_NEW: commit, KERYX_REPAIR_REF: this.branchRef,
    }, this.hooks));
  }
}
