// Materialize the regression reviewer's unchanged callers from the pinned PR objects.
// A Desktop checkout contains the trusted controls; reading the worktree could yield a different revision.
import { execFile } from "node:child_process";
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

export async function prepareBlastInput(cwd: string, dir: string, head: string | null, manifest: SliceManifest) {
  let radius: BlastRadius;
  try {
    radius = JSON.parse(await readFile(path.join(dir, "blast-radius.json"), "utf8"));
  } catch {
    throw new Error("The regression reviewer needs blast-radius.json for its unchanged callers.");
  }
  if (!head || !/^[0-9a-f]{40}$/i.test(head) || !Array.isArray(radius?.files)) throw new Error("Invalid pinned blast-radius input.");
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
    if (typeof file !== "string" || !file || file.includes("\\") || file.includes(":") || [...file].some(char => char.charCodeAt(0) < 32) || path.isAbsolute(file) ||
      file.split("/").some(segment => !segment || segment === "." || segment === "..") || CONTEXT_FILE_DENYLIST.test(file)) {
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
