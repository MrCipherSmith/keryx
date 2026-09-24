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
const BUNDLE_MANIFEST_NAME = "bundle.json";

// R1-F10: caps applied BEFORE decompression/reading, not only after —
// otherwise a hostile bundle can make the process allocate hundreds of MB to
// GB decompressing/reading before the entry/byte caps below ever get a
// chance to refuse it. A compressed archive over this size is refused
// outright without attempting `gunzipSync`; the decompressed output itself
// is separately capped via `maxOutputLength` so a small, highly-compressed
// input (a "gzip bomb") cannot inflate past the same total-bytes budget the
// tar parser enforces per-entry. A directory source has no compression to
// bound, so its own walk is capped on entry count and total bytes as it
// goes (see `openBundle`'s directory branch), matching the archive's caps.
// These are the production defaults every real caller gets; tests may
// inject smaller `BundleLimits` to exercise refusal without allocating
// hundreds of MB.
export const DEFAULT_BUNDLE_LIMITS: Required<BundleLimits> = {
  maxEntries: 10_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCompressedBytes: 32 * 1024 * 1024,
  // R3-F19: `bundle.json` itself is capped in the reader, independent of the
  // whole-archive size caps above — a manifest this small never needs the
  // expensive JSON.parse + full schema validation `parseManifest` runs to
  // discover it is oversized; refusing on the RAW BYTE LENGTH here is O(1).
  // 8 MiB is generous headroom over a realistic 10,000-entry manifest
  // (~1 MiB at ~100 bytes/entry).
  maxManifestBytes: 8 * 1024 * 1024,
};

export interface BundleSource {
  kind: "directory" | "archive";
  manifestBytes: Buffer;
  /** Every regular file except `bundle.json`, keyed by bundle-relative POSIX path. */
  files: ReadonlyMap<string, Buffer>;
}

/**
 * Archive/directory-read caps, injectable so tests can exercise refusal
 * behavior without inflating hundreds of MB. Any field left unset falls
 * back to today's production constant — production callers that pass no
 * `limits` at all get exactly the previous, unchanged behavior.
 */
export interface BundleLimits {
  /** Cap on a `.tar.gz` file's on-disk (compressed) size, checked before reading it. */
  maxCompressedBytes?: number;
  /** Cap on total regular-file bytes across an archive or directory bundle. `bundle.json` itself is excluded (R3-F22) — see `maxManifestBytes`. */
  maxTotalBytes?: number;
  /** Cap on the number of regular-file entries in an archive or directory bundle. `bundle.json` itself is excluded (R3-F22) — the archive and manifest entry caps must agree, or a valid bundle at exactly the boundary (e.g. 10,000 content entries) becomes unopenable. */
  maxEntries?: number;
  /** Cap on `bundle.json`'s own raw byte size (R3-F19), checked independently of `maxTotalBytes`/`maxEntries` and before it is ever `JSON.parse`d. */
  maxManifestBytes?: number;
}

interface ResolvedLimits {
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
  maxManifestBytes: number;
}

function resolveLimits(limits?: BundleLimits): ResolvedLimits {
  const maxTotalBytes = limits?.maxTotalBytes ?? DEFAULT_BUNDLE_LIMITS.maxTotalBytes;
  return {
    maxCompressedBytes: limits?.maxCompressedBytes ?? DEFAULT_BUNDLE_LIMITS.maxCompressedBytes,
    // Same headroom-over-total relationship as the default, so an injected
    // small `maxTotalBytes` yields a correspondingly small decompressed cap.
    maxDecompressedBytes: maxTotalBytes + 8 * 1024 * 1024,
    maxTotalBytes,
    maxEntries: limits?.maxEntries ?? DEFAULT_BUNDLE_LIMITS.maxEntries,
    maxManifestBytes: limits?.maxManifestBytes ?? DEFAULT_BUNDLE_LIMITS.maxManifestBytes,
  };
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

/**
 * R2-I4: a ustar size/checksum field is meant to hold an unsigned octal
 * value; `Number.parseInt(raw, 8)` on a crafted field starting with `-`
 * happily returns a negative number instead of refusing, which a caller
 * doing `Math.ceil(size / BLOCK)` or size-cap arithmetic on must not have to
 * defend against separately. Negative (and non-finite) parses fold to `0`.
 */
function readOctal(buf: Buffer, start: number, len: number): number {
  const raw = buf.subarray(start, start + len).toString("ascii").replace(/\0.*$/, "").trim();
  if (raw.length === 0) return 0;
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function readCString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8");
}

/** Parse a ustar tar buffer fully in memory. Refuses anything not a plain file/dir it wrote itself. */
function parseUstar(
  tar: Buffer,
  limits: ResolvedLimits,
): ArchiveResult<{ files: Map<string, Buffer>; manifestBytes: Buffer | null }> {
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

    // R3-I2: a directory member is identified by its ustar TYPEFLAG alone
    // ("5"), never by the name merely ending in "/" — this repo's own writer
    // (`buildHeader`) always sets the correct typeflag for a directory it
    // produces, so relying on the name suffix only let a SYMLINK member
    // named with a trailing slash (`rules/` with typeflag "2") be silently
    // treated as an empty directory instead of falling through to the
    // unsupported-entry-type refusal below, where every other symlink
    // member already lands.
    const isDir = typeflag === "5";
    const isRegular = typeflag === "0" || typeflag === "\0" || typeflag === "";
    const isManifestEntry = !isDir && name === BUNDLE_MANIFEST_NAME;

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

    // R3-F22: `bundle.json` is excluded from the entry-count/total-bytes
    // caps below — those caps and `manifest.ts`'s own `contents.length` cap
    // must agree at the boundary, or a bundle with exactly `maxEntries`
    // content entries (valid per the manifest cap) becomes unopenable
    // because the archive also carries `bundle.json` as its own entry.
    // `bundle.json` gets its OWN, independent size cap instead (R3-F19).
    if (isManifestEntry) {
      if (size > limits.maxManifestBytes) {
        return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveTooLarge, path: name, message: `bundle.json is ${size} bytes, over the ${limits.maxManifestBytes}-byte manifest cap` } };
      }
    } else {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveTooLarge, message: `archive has more than ${limits.maxEntries} entries` } };
      }
      totalBytes += size;
      if (totalBytes > limits.maxTotalBytes) {
        return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveTooLarge, message: `archive exceeds ${limits.maxTotalBytes} bytes total` } };
      }
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

    if (isManifestEntry) {
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
export async function openBundle(
  bundlePath: string,
  limits?: BundleLimits,
): Promise<ArchiveResult<BundleSource>> {
  const resolved = resolveLimits(limits);
  let stat;
  try {
    stat = await lstat(bundlePath);
  } catch {
    return { ok: false, refusal: { reason: BUNDLE_REFUSAL.notABundle, message: `no such path: ${bundlePath}` } };
  }

  if (stat.isDirectory()) {
    const files = new Map<string, Buffer>();
    let manifestBytes: Buffer | null = null;
    let entryCount = 0;
    let totalBytes = 0;

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
        // R1-F10/R3-F22: cap entry count and total bytes as the walk goes,
        // BEFORE reading the file's contents — matching the archive
        // branch's caps, so a directory source cannot be used to bypass the
        // same limits. `bundle.json` is excluded here too, with its own
        // independent size cap (R3-F19), so the directory and archive
        // sources agree at the entry-count boundary.
        if (rel === BUNDLE_MANIFEST_NAME) {
          if (entryStat.size > resolved.maxManifestBytes) {
            return { reason: BUNDLE_REFUSAL.archiveTooLarge, path: rel, message: `bundle.json is ${entryStat.size} bytes, over the ${resolved.maxManifestBytes}-byte manifest cap` };
          }
          manifestBytes = await readFile(abs);
          continue;
        }
        entryCount += 1;
        if (entryCount > resolved.maxEntries) {
          return { reason: BUNDLE_REFUSAL.archiveTooLarge, message: `bundle directory has more than ${resolved.maxEntries} entries` };
        }
        totalBytes += entryStat.size;
        if (totalBytes > resolved.maxTotalBytes) {
          return { reason: BUNDLE_REFUSAL.archiveTooLarge, message: `bundle directory exceeds ${resolved.maxTotalBytes} bytes total` };
        }
        const bytes = await readFile(abs);
        files.set(rel, bytes);
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
    // R1-F10: refuse an oversized compressed input BEFORE reading it fully
    // into memory or attempting to decompress it.
    if (stat.size > resolved.maxCompressedBytes) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveTooLarge, message: `${bundlePath} is ${stat.size} bytes, over the ${resolved.maxCompressedBytes}-byte compressed-size cap` } };
    }
    const raw = await readFile(bundlePath);
    let tar: Buffer;
    try {
      tar = gunzipSync(raw, { maxOutputLength: resolved.maxDecompressedBytes });
    } catch {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.archiveInvalid, message: "not a valid gzip stream, or it decompresses past the size cap" } };
    }
    const parsed = parseUstar(tar, resolved);
    if (!parsed.ok) return parsed;
    if (parsed.value.manifestBytes === null) {
      return { ok: false, refusal: { reason: BUNDLE_REFUSAL.notABundle, message: `${bundlePath} has no bundle.json at its root` } };
    }
    return { ok: true, value: { kind: "archive", manifestBytes: parsed.value.manifestBytes, files: parsed.value.files } };
  }

  return { ok: false, refusal: { reason: BUNDLE_REFUSAL.notABundle, message: `${bundlePath} is neither a directory nor a file` } };
}
