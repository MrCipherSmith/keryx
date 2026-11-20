import { execFile } from "node:child_process";
import { isUtf8 } from "node:buffer";
import path from "node:path";
import { promisify } from "node:util";
import { revisionOperand } from "../lib/git-revision";
import { CONTEXT_FILE_DENYLIST } from "../lib/subagent-context";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";

const git = promisify(execFile);
// eslint-disable-next-line no-control-regex -- Reject control characters in paths before passing them to Git.
const controlCharacters = /[\x00-\x1f\x7f]/;
export const safeSourcePath = (file: string) =>
  !!file && file.length <= 4096 && !file.includes("\\") && !file.includes(":") && !controlCharacters.test(file) &&
  !path.isAbsolute(file) && !file.split("/").some(segment => !segment || segment === "." || segment === ".." || segment === ".git") &&
  !CONTEXT_FILE_DENYLIST.test(file);

/** Reads a repository blob as data. Neither workspace files nor symlink targets are opened. */
export async function readPinnedReviewSource(cwd: string, head: string, file: string, bytes: number, signal?: AbortSignal) {
  if (!safeSourcePath(file) || !/^[0-9a-f]{40}$/i.test(head)) return;
  const options = { cwd, env: { ...withoutGitDiscoveryOverrides(process.env), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" }, timeout: 8000, signal };
  const { stdout: entry } = await git("git", ["--literal-pathspecs", "ls-tree", "--full-tree", "-z",
    ...revisionOperand(head), "--", file], { ...options, maxBuffer: Buffer.byteLength(file) + 80 });
  const blob = /^100(?:644|755) blob ([0-9a-f]{40})\t/.exec(entry)?.[1];
  if (!blob) return;
  const { stdout: body } = await git("git", ["cat-file", "blob", ...revisionOperand(blob)],
    { ...options, encoding: "buffer", maxBuffer: bytes });
  return !body.includes(0) && isUtf8(body) ? body : "binary";
}

export async function findPinnedReviewSources(cwd: string, head: string, query: string, signal?: AbortSignal) {
  if (!/^[0-9a-f]{40}$/.test(head) || query.length < 2 || query.length > 180) return [];
  const { stdout } = await git("git", ["ls-tree", "-r", "-z", "--full-tree", ...revisionOperand(head)], {
    cwd, env: { ...withoutGitDiscoveryOverrides(process.env), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    signal, timeout: 8000, maxBuffer: 12 * 1024 * 1024,
  });
  const term = query.toLowerCase();
  return stdout.split("\0").flatMap(entry => {
    const file = /^100(?:644|755) blob [0-9a-f]{40}\t(.+)$/u.exec(entry)?.[1];
    return file && file.toLowerCase().includes(term) && safeSourcePath(file) ? [file] : [];
  }).slice(0, 80);
}

export async function searchPinnedReviewSources(cwd: string, head: string, query: string, signal?: AbortSignal) {
  if (!/^[0-9a-f]{40}$/.test(head) || query.length < 2 || query.length > 180 || /[\r\n\0]/.test(query)) return [];
  const options = { cwd, env: { ...withoutGitDiscoveryOverrides(process.env), GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    signal, timeout: 8000, maxBuffer: 12 * 1024 * 1024 };
  try {
    const { stdout } = await git("git", ["grep", "-I", "-l", "-z", "-F", "-i", "-e", query, head, "--"], options);
    const prefix = head + ":";
    return stdout.split("\0").filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length)).filter(safeSourcePath).slice(0, 80);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}
