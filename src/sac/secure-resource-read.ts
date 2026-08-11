import { constants } from "node:fs";
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

const atFdcwd = process.platform === "darwin" ? -2 : -100;
const libcCandidates = process.platform === "darwin"
  ? ["/usr/lib/libSystem.B.dylib"]
  : process.platform === "linux"
    ? ["/lib/aarch64-linux-gnu/libc.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6"]
    : [];

/**
 * Reads a workspace-relative file through a descriptor chain. Every directory
 * component is opened from its already-trusted parent with O_NOFOLLOW, so an
 * attacker cannot redirect a later component by replacing an intermediate
 * directory after containment has been checked.
 *
 * SAC is deliberately fail-closed on hosts where its Bun/POSIX descriptor
 * bridge is unavailable. A pathname re-check followed by a normal open is not
 * an equivalent security boundary.
 */
export function readWorkspaceFileNoFollow(workspaceRoot: string, absolutePath: string): Buffer {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  const components = relativePath.split(path.sep);
  if (!relativePath || path.isAbsolute(relativePath) || components.some((component) => !component || component === "." || component === "..")) {
    throw new Error("safe source path is not workspace-relative");
  }

  const libc = loadPosixLibrary();
  if (!libc || !Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error("safe descriptor source reads are unavailable on this platform");
  }
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const opened: number[] = [];
  try {
    let parent = openAt(libc, atFdcwd, workspaceRoot, directoryFlags);
    opened.push(parent);
    for (const component of components.slice(0, -1)) {
      parent = openAt(libc, parent, component, directoryFlags);
      opened.push(parent);
    }
    const name = components.at(-1);
    if (!name) throw new Error("safe source path has no final component");
    const file = openAt(libc, parent, name, fileFlags);
    opened.push(file);
    return readAll(libc, file);
  } finally {
    for (const fd of opened.reverse()) libc.symbols.close(fd);
    libc.close();
  }
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
  const name = Buffer.from(`${component}\0`);
  const fd = libc.symbols.openat(directoryFd, name, flags, 0);
  if (fd < 0) throw new Error("safe source descriptor open failed");
  return fd;
}

function readAll(libc: PosixLibrary, fd: number): Buffer {
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const read = libc.symbols.read(fd, ptr(chunk), chunk.length);
    if (read < 0n) throw new Error("safe source descriptor read failed");
    if (read === 0n) return Buffer.concat(chunks);
    const length = Number(read);
    if (!Number.isSafeInteger(length) || length > chunk.length) throw new Error("safe source descriptor read returned an invalid length");
    chunks.push(chunk.subarray(0, length));
  }
}
