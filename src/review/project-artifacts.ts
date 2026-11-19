import { closeSync, constants, fstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import path from "node:path";

// Skip links, named pipes and huge JSON files. Only names supplied by Keryx
// below are opened; manifest-provided paths cannot nominate a local file.
export function readKnown(file: string, limit: number, preview: boolean | "tail" = false) {
  let fd: number | undefined;
  try {
    if (realpathSync(file) !== file) return;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.size > limit && !preview)) return;
    const buffer = Buffer.alloc(Math.min(limit, stat.size));
    const offset = preview === "tail" ? Math.max(0, stat.size - limit) : 0;
    const length = readSync(fd, buffer, 0, buffer.length, offset);
    return {
      text:
        (offset > 0 ? "… " : "") + buffer.toString("utf8", 0, length) +
        (stat.size > limit && !offset ? "\n\nPreview truncated. See the local project artifact." : ""),
      time: stat.mtime.toISOString(),
    };
  } catch {
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function* artifactDirectories(root: string, limit = Infinity): Generator<string> {
  let dir;
  try {
    if (realpathSync(root) !== root) return;
    dir = opendirSync(root);
    let count = 0;
    for (let entry = dir.readSync(); entry && count < limit; entry = dir.readSync()) {
      count++;
      if (entry.isDirectory()) yield path.join(root, entry.name);
    }
  } catch {
    return;
  } finally {
    dir?.closeSync();
  }
}
