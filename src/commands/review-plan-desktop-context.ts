// Materialize source evidence from the pinned PR objects.
// A Desktop checkout contains the trusted controls; reading the worktree could yield a different revision.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { promisify } from "node:util";
import { writeFileAtomic } from "../lib/fs";
import { revisionOperand } from "../lib/git-revision";
import { CONTEXT_FILE_DENYLIST, SUBAGENT_CONTEXT_FILES_MAX_BYTES, SUBAGENT_CONTEXT_FILES_MAX_COUNT } from "../lib/subagent-context";
import type { SliceManifest } from "../review/slice";
import type { BlastRadius } from "../review/blast-radius";

const exec = promisify(execFile);
const pinnedHead = /^[0-9a-f]{40}$/i;
const safeSourcePath = (file: string) =>
  !!file && !file.includes("\\") && !file.includes(":") && ![...file].some(char => char.charCodeAt(0) < 32) &&
  !path.isAbsolute(file) && !file.split("/").some(segment => !segment || segment === "." || segment === "..") &&
  !CONTEXT_FILE_DENYLIST.test(file);

type SourceAttachment = { path: string; attachment: string; bytes: number };

/** Assigned files supplement mandatory diff slices. The bound is per dispatch, not per repository. */
export function createPinnedSourceInput(cwd: string, dir: string, head: string | null) {
  const saved = new Map<string, SourceAttachment>();
  const env = { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
  return async (files: string[], diffAttachments: string[], diffBytes: number) => {
    const sources: SourceAttachment[] = [];
    const omissions: string[] = [];
    let bytes = 0;
    for (const file of files) {
      const omit = (reason: string) => omissions.push(`Pinned source ${file}: ${reason}.`);
      if (!safeSourcePath(file)) { omit("path is excluded from attachments"); continue; }
      const available = SUBAGENT_CONTEXT_FILES_MAX_BYTES - diffBytes - bytes;
      if (diffAttachments.length + sources.length >= SUBAGENT_CONTEXT_FILES_MAX_COUNT || available < 1) {
        omit("attachment budget exhausted"); continue;
      }
      let source = saved.get(file);
      if (!source) {
        if (!head || !pinnedHead.test(head)) { omit("review head is unavailable"); continue; }
        let body: Buffer;
        try {
          // A symlink is stored as a Git blob too. Only regular file modes belong in source evidence.
          const { stdout: entry } = await exec("git", ["--literal-pathspecs", "ls-tree", "--full-tree", "-z", ...revisionOperand(head), "--", file],
            { cwd, env, maxBuffer: Buffer.byteLength(file) + 80 });
          const blob = /^100(?:644|755) blob ([0-9a-f]{40})\t/.exec(entry)?.[1];
          if (!blob) { omit("no regular file at review head"); continue; }
          ({ stdout: body } = await exec("git", ["cat-file", "blob", ...revisionOperand(blob)], { cwd, env, encoding: "buffer", maxBuffer: available }));
        } catch (error) {
          omit((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "does not fit the attachment budget" : "could not be read at review head");
          continue;
        }
        if (body.includes(0) || !isUtf8(body)) { omit("not UTF-8 source text"); continue; }
        // The source path names data, never an output location. Hashing also keeps paths that differ
        // only by case distinct on the default macOS filesystem.
        const output = path.join(dir, "pinned-sources", createHash("sha256").update(file).digest("hex") + ".txt");
        await mkdir(path.dirname(output), { recursive: true });
        await writeFileAtomic(output, body.toString("utf8"));
        source = { path: file, attachment: path.relative(cwd, output).split(path.sep).join("/"), bytes: body.byteLength };
        saved.set(file, source);
      }
      if (source.bytes > available) { omit("does not fit the attachment budget"); continue; }
      sources.push(source);
      bytes += source.bytes;
    }
    return { sources, omissions, bytes, attachments: [...diffAttachments, ...sources.map(source => source.attachment)] };
  };
}

export async function prepareBlastInput(cwd: string, dir: string, head: string | null, manifest: SliceManifest) {
  let radius: BlastRadius;
  try {
    radius = JSON.parse(await readFile(path.join(dir, "blast-radius.json"), "utf8"));
  } catch {
    throw new Error("The regression reviewer needs blast-radius.json for its unchanged callers.");
  }
  if (!head || !pinnedHead.test(head) || !Array.isArray(radius?.files)) throw new Error("Invalid pinned blast-radius input.");
  const files = [...new Set(radius.files.map(entry => entry.file))];
  const changed = new Set(radius.files.map(entry => entry.via));
  const attachments: string[] = [];
  let bytes = 0;
  // An unchanged caller only explains a regression together with the change it consumes.
  for (const slice of manifest.slices.filter(slice => !slice.retryOf && slice.files.some(file => changed.has(file)))) {
    const target = path.join(dir, "slices", slice.path);
    bytes += (await stat(target)).size;
    attachments.push(path.relative(cwd, target).split(path.sep).join("/"));
  }
  if (bytes > SUBAGENT_CONTEXT_FILES_MAX_BYTES || attachments.length > SUBAGENT_CONTEXT_FILES_MAX_COUNT) {
    throw new Error("The regression review's changed slices exceed the reviewer attachment budget.");
  }
  for (const file of files) {
    if (typeof file !== "string" || !safeSourcePath(file)) {
      throw new Error("The regression review cannot attach one of its required caller paths.");
    }
    const budget = SUBAGENT_CONTEXT_FILES_MAX_BYTES - bytes;
    if (attachments.length >= SUBAGENT_CONTEXT_FILES_MAX_COUNT || budget <= 0) throw new Error("The unchanged caller sources exceed the reviewer attachment budget.");
    let body: Buffer;
    try {
      ({ stdout: body } = await exec("git", ["cat-file", "blob", ...revisionOperand(`${head}:${file}`)], { cwd, encoding: "buffer", maxBuffer: budget }));
    } catch {
      throw new Error(`The pinned caller ${file} could not be read within the reviewer attachment budget.`);
    }
    if (body.includes(0) || !isUtf8(body)) throw new Error(`The pinned caller ${file} is not a text file.`);
    const target = path.join(dir, "blast-input", file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, body.toString("utf8"));
    attachments.push(path.relative(cwd, target).split(path.sep).join("/"));
    bytes += body.byteLength;
  }
  return { files, attachments, bytes };
}
