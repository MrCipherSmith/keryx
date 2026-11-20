import { closeSync, constants, fstatSync, lstatSync, readSync, type BigIntStats, type Stats } from "node:fs";
import path from "node:path";
import { dlopen, FFIType } from "bun:ffi";

type PosixLibrary = {
  symbols: {
    openat: (directoryFd: number, name: Uint8Array, flags: number, mode: number) => number;
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

/** Caller owns the returned descriptor; each component is opened relative to its pinned parent. */
export function openDescriptorChain(
  workspaceRoot: string,
  absolutePath: string,
  options: Omit<DescriptorReadOptions, "beforeOpen" | "backend"> & { directory?: boolean } = {},
): number {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  const components = relativePath.split(path.sep);
  if (!relativePath || path.isAbsolute(relativePath) || components.some((component) => !component || component.includes("\0") || component === "." || component === "..")) {
    throw new DescriptorReadError("invalid-path", "safe source path is not workspace-relative");
  }
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new DescriptorReadError("too-large", "safe source byte limit is invalid");
  }
  const libc = loadPosixLibrary();
  if (!libc || !Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW) ||
      (options.requireRegularFile && !Number.isInteger(constants.O_NONBLOCK))) {
    libc?.close();
    throw new DescriptorReadError("unavailable", "safe descriptor source reads are unavailable on this platform");
  }
  const opened: number[] = [];
  try {
    const rootStat = lstatSync(workspaceRoot, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new DescriptorReadError("race", "safe source owner root changed");
    }
    if (options.expectedRootIdentity !== undefined && !sameIdentity(options.expectedRootIdentity, rootStat)) {
      throw new DescriptorReadError("race", "safe source owner root changed");
    }
    const parent = openAt(libc, atFdcwd, workspaceRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    opened.push(parent);
    if (!sameIdentity(rootStat, fstatSync(parent, { bigint: true }))) {
      throw new DescriptorReadError("race", "safe source owner root changed");
    }
    let directoryFd = parent;
    for (const component of components.slice(0, -1)) {
      directoryFd = openAt(libc, directoryFd, component, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      opened.push(directoryFd);
    }
    const name = components.at(-1);
    if (!name) throw new DescriptorReadError("invalid-path", "safe source path has no final component");
    const target = lstatSync(absolutePath, { bigint: true });
    if (options.requireRegularFile && !target.isFile()) throw new DescriptorReadError("not-regular", "safe source is not a regular file");
    const expected = options.expectedTargetIdentity ?? target;
    const finalFlags = constants.O_RDONLY | constants.O_NOFOLLOW |
      (options.directory ? constants.O_DIRECTORY : 0) | (options.requireRegularFile ? constants.O_NONBLOCK : 0);
    const file = openAt(libc, directoryFd, name, finalFlags);
    opened.push(file);
    const actual = fstatSync(file, { bigint: true });
    if (!sameIdentity(expected, actual)) throw new DescriptorReadError("race", "safe source target changed");
    if (options.requireRegularFile && !actual.isFile()) throw new DescriptorReadError("not-regular", "safe source is not a regular file");
    opened.pop(); // Transfer the verified leaf to the caller; ancestors are closed below.
    return file;
  } catch (error) {
    if (error instanceof DescriptorReadError) throw error;
    throw new DescriptorReadError("open-failed", "safe descriptor source open failed");
  } finally {
    for (const fd of opened.reverse()) libc.symbols.close(fd);
    libc.close();
  }
}

export function readDescriptorChain(
  workspaceRoot: string,
  absolutePath: string,
  options: Omit<DescriptorReadOptions, "beforeOpen" | "backend"> = {},
): Buffer {
  const fd = openDescriptorChain(workspaceRoot, absolutePath, options);
  try {
    return readAll(fd, fstatSync(fd), options.maxBytes);
  } catch (error) {
    if (error instanceof DescriptorReadError) throw error;
    throw new DescriptorReadError("read-failed", "safe descriptor source read failed");
  } finally {
    closeSync(fd);
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

function loadPosixLibrary(): PosixLibrary | undefined {
  for (const candidate of libcCandidates) {
    try {
      return dlopen(candidate, {
        openat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        close: { args: [FFIType.i32], returns: FFIType.i32 },
      }) as unknown as PosixLibrary;
    } catch { /* try the next known system libc path */ }
  }
  return undefined;
}

function openAt(libc: PosixLibrary, directoryFd: number, component: string, flags: number): number {
  const fd = libc.symbols.openat(directoryFd, Buffer.from(`${component}\0`), flags, 0);
  if (fd < 0) throw new DescriptorReadError("open-failed", "safe descriptor source open failed");
  return fd;
}

function sameIdentity(left: DescriptorIdentity | Pick<BigIntStats, "dev" | "ino">, right: BigIntStats): boolean {
  return BigInt(left.dev) === right.dev && BigInt(left.ino) === right.ino;
}

function readAll(fd: number, descriptor: Stats, maxBytes?: number): Buffer {
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
    let length: number;
    try { length = readSync(fd, chunk, 0, chunk.length, null); }
    catch { throw new DescriptorReadError("read-failed", "safe descriptor source read failed"); }
    if (!length) return Buffer.concat(chunks);
    total += length;
    chunks.push(chunk.subarray(0, length));
  }
}
