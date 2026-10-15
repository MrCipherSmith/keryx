import { constants, fstatSync, lstatSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";

type PosixLibrary = {
  symbols: {
    openat: (directoryFd: number, name: Uint8Array, flags: number, mode: number) => number;
    read: (fd: number, buffer: ReturnType<typeof ptr>, length: number) => bigint;
    close: (fd: number) => number;
  };
  close(): void;
};

export type DescriptorReadCode =
  | "unavailable"
  | "invalid-path"
  | "not-found"
  | "not-regular"
  | "too-large"
  | "race"
  | "open-failed"
  | "read-failed";

export class DescriptorReadError extends Error {
  constructor(readonly code: DescriptorReadCode, message: string) {
    super(message);
    this.name = "DescriptorReadError";
  }
}

export type DescriptorIdentity = Pick<Stats, "dev" | "ino">;
export interface DescriptorReadOptions {
  maxBytes?: number;
  requireRegularFile?: boolean;
  expectedRootIdentity?: DescriptorIdentity;
  expectedTargetIdentity?: DescriptorIdentity;
  beforeOpen?: () => Promise<void> | void;
  backend?: "descriptor" | "unsupported";
}

const atFdcwd = process.platform === "darwin" ? -2 : -100;
const libcCandidates = process.platform === "darwin"
  ? ["/usr/lib/libSystem.B.dylib"]
  : process.platform === "linux"
    ? ["/lib/aarch64-linux-gnu/libc.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6"]
    : [];
const READ_CHUNK_BYTES = 64 * 1024;
// Retain native bindings, never per-operation file/directory descriptors.
let cachedPosixLibrary: PosixLibrary | undefined;
type DirectoryLibrary = { symbols: Record<string, (...args: number[]) => number>; close(): void };
let cachedDirectoryLibrary: DirectoryLibrary | undefined;

/** Open and read a canonical path through an O_NOFOLLOW descriptor chain. */
export function readDescriptorChain(
  workspaceRoot: string,
  absolutePath: string,
  options: Omit<DescriptorReadOptions, "beforeOpen" | "backend"> = {},
): Buffer {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  const components = relativePath.split(path.sep);
  if (!relativePath || path.isAbsolute(relativePath) || components.some((component) => !component || component === "." || component === "..")) {
    throw new DescriptorReadError("invalid-path", "safe source path is not workspace-relative");
  }
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new DescriptorReadError("too-large", "safe source byte limit is invalid");
  }
  const libc = loadPosixLibrary();
  if (!libc || !Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw new DescriptorReadError("unavailable", "safe descriptor source reads are unavailable on this platform");
  }
  const opened: number[] = [];
  try {
    const rootStat = lstatSync(workspaceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new DescriptorReadError("race", "safe source owner root changed");
    }
    if (options.expectedRootIdentity !== undefined && !sameIdentity(options.expectedRootIdentity, rootStat)) {
      throw new DescriptorReadError("race", "safe source owner root changed");
    }
    const parent = openAt(libc, atFdcwd, workspaceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    opened.push(parent);
    if (!sameIdentity(rootStat, fstatSync(parent))) {
      throw new DescriptorReadError("race", "safe source owner root changed");
    }
    let directoryFd = parent;
    for (const component of components.slice(0, -1)) {
      directoryFd = openAt(libc, directoryFd, component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push(directoryFd);
    }
    const name = components.at(-1);
    if (!name) throw new DescriptorReadError("invalid-path", "safe source path has no final component");
    const expected = options.expectedTargetIdentity ?? statSync(absolutePath);
    const finalFlags = constants.O_RDONLY | constants.O_NOFOLLOW | (options.requireRegularFile ? (constants.O_NONBLOCK ?? 0) : 0);
    const file = openAt(libc, directoryFd, name, finalFlags);
    opened.push(file);
    const actual = fstatSync(file);
    if (!sameIdentity(expected, actual)) throw new DescriptorReadError("race", "safe source target changed");
    if (options.requireRegularFile && !actual.isFile()) throw new DescriptorReadError("not-regular", "safe source is not a regular file");
    return readAll(libc, file, actual, options.maxBytes);
  } catch (error) {
    if (error instanceof DescriptorReadError) throw error;
    throw new DescriptorReadError("open-failed", "safe descriptor source open failed");
  } finally {
    for (const fd of opened.reverse()) libc.symbols.close(fd);
  }
}

export async function readDescriptorChainAsync(
  workspaceRoot: string,
  absolutePath: string,
  options: DescriptorReadOptions = {},
): Promise<Buffer> {
  if (options.backend === "unsupported") {
    throw new DescriptorReadError("unavailable", "safe descriptor source reads are unavailable on this platform");
  }
  await options.beforeOpen?.();
  return readDescriptorChain(workspaceRoot, absolutePath, options);
}

/** Bounded enumeration through an O_NOFOLLOW chain; names are not read capabilities. */
export function listDescriptorDirectory(root: string, relative: string, options: {
  expectedRootIdentity: DescriptorIdentity; maxEntries: number; checkpoint: () => void;
}): { name: string; kind: "file" | "directory" | "other" }[] {
  const parts = relative ? relative.split("/") : [];
  if (parts.some(p => !p || p === "." || p === ".." || p.includes("\\") || p.includes("\0")) ||
      !Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0) {
    throw new DescriptorReadError("invalid-path", "invalid directory inventory request");
  }
  const libc = loadPosixLibrary();
  if (!libc || !Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw new DescriptorReadError("unavailable", "descriptor directory inventory unavailable");
  }
  const opened: number[] = [];
  try {
    options.checkpoint();
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sameIdentity(rootStat, options.expectedRootIdentity))
      throw new DescriptorReadError("race", "inventory owner root changed");
    let fd = openAt(libc, atFdcwd, root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    opened.push(fd);
    if (!sameIdentity(rootStat, fstatSync(fd))) throw new DescriptorReadError("race", "inventory owner root changed");
    for (const part of parts) {
      options.checkpoint();
      fd = openAt(libc, fd, part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push(fd);
    }
    const entries: { name: string; kind: "file" | "directory" | "other" }[] = [];
    enumerateDirectoryFd(fd, options, entries);
    if (!sameIdentity(lstatSync(root), rootStat)) throw new DescriptorReadError("race", "inventory owner root changed");
    return entries;
  } finally { for (const fd of opened.reverse()) libc.symbols.close(fd); }
}
function enumerateDirectoryFd(fd: number, options: { maxEntries: number; checkpoint: () => void },
  entries: { name: string; kind: "file" | "directory" | "other" }[]) {
  const darwin = process.platform === "darwin";
  const readSymbol = darwin && process.arch !== "arm64" ? "readdir$INODE64" : "readdir";
  const errnoSymbol = darwin ? "__error" : "__errno_location";
  let library = cachedDirectoryLibrary;
  for (const candidate of library ? [] : libcCandidates) {
    try {
      library = dlopen(candidate, {
        dup: { args: [FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
        fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
        closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
        [readSymbol]: { args: [FFIType.ptr], returns: FFIType.ptr },
        [errnoSymbol]: { args: [], returns: FFIType.ptr },
      }) as unknown as DirectoryLibrary;
      cachedDirectoryLibrary = library;
      break;
    } catch { /* no path-based fallback */ }
  }
  if (!library) throw new DescriptorReadError("unavailable", "native directory enumeration unavailable");
  let duplicate = -1, directory = 0;
  try {
    duplicate = library.symbols.dup!(fd);
    if (duplicate < 0) throw new DescriptorReadError("open-failed", "directory descriptor duplication failed");
    directory = library.symbols.fdopendir!(duplicate);
    if (!directory) throw new DescriptorReadError("open-failed", "directory descriptor enumeration failed");
    duplicate = -1;
    const errnoPointer = library.symbols[errnoSymbol]!();
    if (!errnoPointer) throw new DescriptorReadError("unavailable", "directory errno unavailable");
    const errno = new DataView(toArrayBuffer(errnoPointer, 0, 4));
    const nameOffset = darwin ? 21 : 19;
    for (;;) {
      options.checkpoint();
      errno.setInt32(0, 0, true);
      const entry = library.symbols[readSymbol]!(directory);
      if (!entry) {
        if (errno.getInt32(0, true)) throw new DescriptorReadError("read-failed", "directory enumeration failed");
        break;
      }
      const header = new DataView(toArrayBuffer(entry, 0, nameOffset));
      const recordLength = header.getUint16(16, true);
      if (recordLength <= nameOffset || recordLength > 4096) throw new DescriptorReadError("read-failed", "invalid directory record");
      const nameBytes = new Uint8Array(toArrayBuffer(entry, nameOffset, recordLength - nameOffset));
      const end = nameBytes.indexOf(0);
      if (end < 1) throw new DescriptorReadError("read-failed", "invalid directory name");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes.subarray(0, end));
      if (name === "." || name === "..") continue;
      if (name.includes("/")) throw new DescriptorReadError("read-failed", "invalid directory name");
      if (entries.length >= options.maxEntries) throw new DescriptorReadError("too-large", "directory inventory budget exceeded");
      const type = header.getUint8(darwin ? 20 : 18);
      if (type === 0) throw new DescriptorReadError("unavailable", "unknown directory entry type");
      entries.push({ name, kind: type === 8 ? "file" : type === 4 ? "directory" : "other" });
    }
  } finally {
    if (directory) library.symbols.closedir!(directory);
    else if (duplicate >= 0) library.symbols.close!(duplicate);
  }
}
function loadPosixLibrary(): PosixLibrary | undefined {
  if (cachedPosixLibrary) return cachedPosixLibrary;
  for (const candidate of libcCandidates) {
    try {
      cachedPosixLibrary = dlopen(candidate, {
        openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
      }) as unknown as PosixLibrary;
      return cachedPosixLibrary;
    } catch { /* try the next known system libc path */ }
  }
  return undefined;
}

function openAt(libc: PosixLibrary, directoryFd: number, component: string, flags: number): number {
  const fd = libc.symbols.openat(directoryFd, Buffer.from(`${component}\0`), flags, 0);
  if (fd < 0) throw new DescriptorReadError("open-failed", "safe descriptor source open failed");
  return fd;
}

function sameIdentity(left: DescriptorIdentity, right: DescriptorIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readAll(libc: PosixLibrary, fd: number, descriptor: Stats, maxBytes?: number): Buffer {
  if (maxBytes !== undefined && descriptor.size > maxBytes) throw new DescriptorReadError("too-large", "safe source exceeds the byte limit");
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const remaining = maxBytes === undefined ? READ_CHUNK_BYTES : maxBytes - total;
    if (remaining === 0) {
      if (maxBytes !== undefined && fstatSync(fd).size > maxBytes) {
        throw new DescriptorReadError("too-large", "safe source exceeds the byte limit");
      }
      return Buffer.concat(chunks);
    }
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const read = libc.symbols.read(fd, ptr(chunk), chunk.length);
    if (read < 0n) throw new DescriptorReadError("read-failed", "safe descriptor source read failed");
    if (read === 0n) return Buffer.concat(chunks);
    const length = Number(read);
    if (!Number.isSafeInteger(length) || length > chunk.length) throw new DescriptorReadError("read-failed", "safe descriptor source read returned an invalid length");
    total += length;
    chunks.push(chunk.subarray(0, length));
  }
}
