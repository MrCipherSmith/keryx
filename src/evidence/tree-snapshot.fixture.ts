import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

/** Relative path -> "kind:size:sha256" for every entry under `directory`, recursively. */
export async function snapshotTree(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    const entries = (await readdir(path.join(directory, relative))).sort();
    for (const name of entries) {
      const rel = relative ? `${relative}/${name}` : name, full = path.join(directory, rel);
      const info = await lstat(full);
      if (info.isDirectory()) { out[rel] = "dir"; await walk(rel); }
      else if (info.isSymbolicLink()) out[rel] = `link:${await readlink(full)}`;
      else {
        const bytes = await readFile(full);
        out[rel] = `file:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
      }
    }
  };
  await walk("");
  return out;
}
