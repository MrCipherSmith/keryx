import { constants, fstatSync, lstatSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { dlopen, FFIType, ptr } from "bun:ffi";

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
    libc.close();
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
        read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
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
