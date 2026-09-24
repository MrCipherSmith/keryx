// Flow 313 (W4 portability), T6 — the bundle's on-disk container: a directory
// with `bundle.json` at its root, or a deterministic `.tar.gz` of the same
// tree. Writing is a minimal ustar implementation (regular files and
// directories only, fixed mtime/uid/gid, sorted entries) — not a general tar
// writer, and deliberately narrower than one: a bundle carries no symlinks,
// hardlinks, or device nodes, so the reader refuses anything it does not
// itself know how to produce. Reading is fully in-memory: `openBundle` never
// extracts to a temp file, so `inspect`/`verify` on an untrusted archive never
// touches disk.

import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";

import { BUNDLE_REFUSAL, type BundleRefusal } from "./types";

const BLOCK = 512;
const MAX_ENTRIES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const BUNDLE_MANIFEST_NAME = "bundle.json";

export interface BundleSource {
  kind: "directory" | "archive";
  manifestBytes: Buffer;
  /** Every regular file except `bundle.json`, keyed by bundle-relative POSIX path. */
  files: ReadonlyMap<string, Buffer>;
}

export type ArchiveResult<T> = { ok: true; value: T } | { ok: false; refusal: BundleRefusal };

interface UstarEntry {
  name: string;
  isDirectory: boolean;
  bytes?: Buffer;
}

function octal(value: number, width: number): Buffer {
  const str = value.toString(8).padStart(width - 1, "0");
  const buf = Buffer.alloc(width);
  buf.write(str, 0, "ascii");
  buf[width - 1] = 0;
  return buf;
}

function nameField(name: string): ArchiveResult<{ name: Buffer; prefix: Buffer }> {
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length <= 100) {
    const nameBuf = Buffer.alloc(100);
    nameBytes.copy(nameBuf);
    return { ok: true, value: { name: nameBuf, prefix: Buffer.alloc(155) } };
  }
  // Split on the last '/' that lets both halves fit ustar's prefix(155)/name(100).
  const slash = name.lastIndexOf("/");
  if (slash > 0) {
    const prefix = name.slice(0, slash);
    const rest = name.slice(slash + 1);
    const prefixBytes = Buffer.from(prefix, "utf8");
    const restBytes = Buffer.from(rest, "utf8");
    if (prefixBytes.length <= 155 && restBytes.length <= 100) {
      const nameBuf = Buffer.alloc(100);
      restBytes.copy(nameBuf);
      const prefixBuf = Buffer.alloc(155);
      prefixBytes.copy(prefixBuf);
      return { ok: true, value: { name: nameBuf, prefix: prefixBuf } };
    }
  }
  return {
    ok: false,
    refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, path: name, message: `path too long for ustar: ${name}` },
  };
}

function buildHeader(entry: UstarEntry, size: number): ArchiveResult<Buffer> {
  const named = nameField(entry.name);
  if (!named.ok) return named;
  const header = Buffer.alloc(BLOCK);
  named.value.name.copy(header, 0);
  octal(entry.isDirectory ? 0o755 : 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108); // uid
  octal(0, 8).copy(header, 116); // gid
  octal(size, 12).copy(header, 124);
  octal(0, 12).copy(header, 136); // mtime
  header.write("        ", 148, "ascii"); // chksum placeholder (8 spaces)
  header[156] = entry.isDirectory ? 0x35 /* '5' */ : 0x30 /* '0' */;
  header.write("ustar", 257, "ascii");
  header[262] = 0;
  header.write("00", 263, "ascii");
  named.value.prefix.copy(header, 345);

  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += header[i] as number;
  const chk = Buffer.alloc(8);
  chk.write(sum.toString(8).padStart(6, "0"), 0, "ascii");
  chk[6] = 0;
  chk[7] = 0x20;
  chk.copy(header, 148);
  return { ok: true, value: header };
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % BLOCK;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(BLOCK - rem)]);
}

/**
 * Deterministic ustar tar, gzip-compressed: sorted entries, fixed
 * mtime/uid/gid/mode, regular files and directories only.
 */
export function buildBundleArchive(
  files: ReadonlyMap<string, Buffer>,
  manifestBytes: Buffer,
): ArchiveResult<Buffer> {
  const entries: UstarEntry[] = [];
  const dirs = new Set<string>();
  const sortedPaths = [...files.keys()].sort();
  for (const p of sortedPaths) {
    let dir = path.dirname(p);
    const segs: string[] = [];
    while (dir !== "." && dir !== "/" && dir !== "") {
      segs.unshift(dir);
      dir = path.dirname(dir);
    }
    for (const d of segs) dirs.add(d);
  }
  for (const d of [...dirs].sort()) {
    entries.push({ name: `${d}/`, isDirectory: true });
  }
  entries.push({ name: BUNDLE_MANIFEST_NAME, isDirectory: false, bytes: manifestBytes });
  for (const p of sortedPaths) {
    entries.push({ name: p, isDirectory: false, bytes: files.get(p) as Buffer });
  }

  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const size = entry.bytes?.length ?? 0;
    const header = buildHeader(entry, size);
    if (!header.ok) return header;
    chunks.push(header.value);
    if (entry.bytes && entry.bytes.length > 0) {
      chunks.push(pad(entry.bytes));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive marker
  const tar = Buffer.concat(chunks);
  return { ok: true, value: gzipSync(tar, { level: 9 }) };
}

function readOctal(buf: Buffer, start: number, len: number): number {
  const raw = buf.subarray(start, start + len).toString("ascii").replace(/\0.*$/, "").trim();
  if (raw.length === 0) return 0;
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readCString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

/** Parse a ustar tar buffer fully in memory. Refuses anything not a plain file/dir it wrote itself. */
function parseUstar(tar: Buffer): ArchiveResult<{ files: Map<string, Buffer>; manifestBytes: Buffer | null }> {
  const files = new Map<string, Buffer>();
  let manifestBytes: Buffer | null = null;
  let offset = 0;
  let entryCount = 0;
  let totalBytes = 0;
  const seen = new Set<string>();

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) {
      offset += BLOCK;
      continue; // end-of-archive padding block
    }

    const storedChecksum = readOctal(header, 148, 8);
    const checked = Buffer.from(header);
    checked.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < BLOCK; i += 1) sum += checked[i] as number;
    if (sum !== storedChecksum) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, message: "ustar header checksum mismatch" } };
    }

    const prefix = readCString(header, 345, 155);
    const nameRaw = readCString(header, 0, 100);
    const name = prefix.length > 0 ? `${prefix}/${nameRaw}` : nameRaw;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);

    if (path.isAbsolute(name) || name.split("/").includes("..") || name.length === 0) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, path: name, message: `unsafe entry name: ${name}` } };
    }

    const isDir = typeflag === "5" || name.endsWith("/");
    const isRegular = typeflag === "0" || typeflag === "\0" || typeflag === "";

    offset += BLOCK;

    if (isDir) {
      // directories carry no data blocks
      continue;
    }
    if (!isRegular) {
      return {
        ok: false,
        refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, path: name, message: `unsupported tar entry type "${typeflag}" for ${name}` },
      };
    }

    entryCount += 1;
    if (entryCount > MAX_ENTRIES) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveTooLarge, message: `archive has more than ${MAX_ENTRIES} entries` } };
    }
    totalBytes += size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveTooLarge, message: `archive exceeds ${MAX_TOTAL_BYTES} bytes total` } };
    }
    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + size > tar.length) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, path: name, message: `truncated entry data for ${name}` } };
    }
    const data = Buffer.from(tar.subarray(offset, offset + size));
    offset += dataBlocks;

    if (seen.has(name)) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, path: name, message: `duplicate archive entry: ${name}` } };
    }
    seen.add(name);

    if (name === BUNDLE_MANIFEST_NAME) {
      manifestBytes = data;
    } else {
      files.set(name, data);
    }
  }

  return { ok: true, value: { files, manifestBytes } };
}

/**
 * Open a bundle at `bundlePath` (a directory or a `.tar.gz`/`.tgz` archive).
 * Read-only, in-memory for archives; a directory source is walked with
 * `lstat` and refuses any symlink.
 */
export async function openBundle(bundlePath: string): Promise<ArchiveResult<BundleSource>> {
  let stat;
  try {
    stat = await lstat(bundlePath);
  } catch {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.notABundle, message: `no such path: ${bundlePath}` } };
  }

  if (stat.isDirectory()) {
    const files = new Map<string, Buffer>();
    let manifestBytes: Buffer | null = null;

    async function walk(dir: string, relPrefix: string): Promise<BundleRefusal | null> {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, entry.name);
        const rel = relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name;
        const entryStat = await lstat(abs);
        if (entryStat.isSymbolicLink()) {
          return { reason: BUNDLE_REFUSAL.symlinkRefused, path: rel, message: `${rel} is a symlink; bundles may not contain symlinks` };
        }
        if (entryStat.isDirectory()) {
          const refusal = await walk(abs, rel);
          if (refusal) return refusal;
          continue;
        }
        if (!entryStat.isFile()) {
          return { reason: BUNDLE_REFUSAL.archiveInvalid, path: rel, message: `${rel} is not a regular file` };
        }
        const bytes = await readFile(abs);
        if (rel === BUNDLE_MANIFEST_NAME) {
          manifestBytes = bytes;
        } else {
          files.set(rel, bytes);
        }
      }
      return null;
    }

    const refusal = await walk(bundlePath, "");
    if (refusal) return { ok: false, refusal };
    if (manifestBytes === null) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.notABundle, message: `${bundlePath} has no bundle.json at its root` } };
    }
    return { ok: true, value: { kind: "directory", manifestBytes, files } };
  }

  if (stat.isFile()) {
    const raw = await readFile(bundlePath);
    let tar: Buffer;
    try {
      tar = gunzipSync(raw);
    } catch {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, message: "not a valid gzip stream" } };
    }
    const parsed = parseUstar(tar);
    if (!parsed.ok) return parsed;
    if (parsed.value.manifestBytes === null) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.notABundle, message: `${bundlePath} has no bundle.json at its root` } };
    }
    return { ok: true, value: { kind: "archive", manifestBytes: parsed.value.manifestBytes, files: parsed.value.files } };
  }

  return { ok: false, refusal: { reason: BUNDLE_REFUSAL.notABundle, message: `${bundlePath} is neither a directory nor a file` } };
}
