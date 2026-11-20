import { closeSync, fstatSync, opendirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { openDescriptorChain } from "../lib/descriptor-read";

function openArtifact(file: string, directory = false): number {
  if (path.resolve(file) !== file || file.includes("\0")) throw new Error("Expected a canonical artifact path");
  return openDescriptorChain(path.parse(file).root, file, { directory, requireRegularFile: !directory });
}

// Skip links, named pipes and huge JSON files. Only names supplied by Keryx
// below are opened; manifest-provided paths cannot nominate a local file.
export function readKnown(file: string, limit: number, preview: boolean | "tail" = false) {
  let fd: number | undefined;
  try {
    fd = openArtifact(file);
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

/** Search an allowed artifact in chunks without loading its full body into the review context. */
export function findKnownExcerpt(file: string, query: string, limit: number): string {
  let fd: number | undefined;
  try {
    fd = openArtifact(file);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "";
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder("utf8");
    const match = query.toLowerCase();
    const before = Math.min(180, limit / 4);
    let offset = 0, shown = "", discarded = false;
    while (offset < stat.size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytes) break;
      offset += bytes;
      shown += decoder.write(buffer.subarray(0, bytes));
      if (offset === stat.size) shown += decoder.end();
      const index = shown.toLowerCase().indexOf(match);
      if (index >= 0) {
        const start = Math.max(0, index - before);
        const end = start + limit;
        return (discarded || start > 0 ? "… " : "") + shown.slice(start, end) +
          (end < shown.length || offset < stat.size ? " …" : "");
      }
      const carry = 2 * match.length + before;
      if (shown.length > carry) {
        shown = shown.slice(-carry);
        discarded = true;
      }
    }
    return "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function* artifactDirectories(root: string, limit = Infinity): Generator<string> {
  let fd: number | undefined, dir;
  try {
    fd = openArtifact(root, true);
    const identity = fstatSync(fd, { bigint: true });
    // Node opens directory iterators by path. Use the OS identity of the held directory, never reopen its project path.
    const reference = process.platform === "darwin" ? `/.vol/${identity.dev}/${identity.ino}` :
      process.platform === "linux" ? `/proc/self/fd/${fd}` : undefined;
    if (!reference) return;
    const stat = statSync(reference, { bigint: true });
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) return;
    dir = opendirSync(reference);
    let count = 0;
    for (let entry = dir.readSync(); entry && count < limit; entry = dir.readSync()) {
      count++;
      if (entry.isDirectory()) yield path.join(root, entry.name);
    }
  } catch {
    return;
  } finally {
    try { dir?.closeSync(); } finally { if (fd !== undefined) closeSync(fd); }
  }
}
