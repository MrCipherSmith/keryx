import { constants, closeSync, fstatSync, fsyncSync, lstatSync, readSync, realpathSync, writeSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";

// Process-lifetime bindings only; namespaces retain independent descriptors.
let storageLibrary: ReturnType<typeof dlopen> | undefined;

/** Private flat namespace. No source reads, async callbacks, or tool paths. */
export class EvidenceStorageAbsentError extends Error {}
/** Nonblocking contention before the writer callback or any mutation. */
export class EvidenceWriterBusyError extends Error {}
export function openEvidenceStorage(projectRoot: string, create = true) {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("evidence storage unavailable");
  const darwin = process.platform === "darwin";
  // Darwin ARM64 places variadic mode on the stack; fill x3..x7 first.
  const stackMode = darwin && process.arch === "arm64";
  const openArgs = stackMode
    ? [FFIType.i32, FFIType.cstring, ...Array(7).fill(FFIType.i32)]
    : [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.i32];
  const errnoName = darwin ? "__error" : "__errno_location";
  const candidates = darwin ? ["/usr/lib/libSystem.B.dylib"] : ["/lib/aarch64-linux-gnu/libc.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6"];
  function load() {
    for (const name of candidates) {
      try { return dlopen(name, {
        openat: { args: openArgs, returns: FFIType.i32 },
        mkdirat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
        renameat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring], returns: FFIType.i32 },
        unlinkat: { args: [FFIType.i32, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
        fdopendir: { args: [FFIType.i32], returns: FFIType.ptr },
        readdir: { args: [FFIType.ptr], returns: FFIType.ptr },
        closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [errnoName]: { args: [], returns: FFIType.ptr },
      }); } catch { /* next system libc */ }
    }
    throw new Error("evidence storage unavailable");
  }
  const lib = (storageLibrary as ReturnType<typeof load> | undefined) ?? load();
  storageLibrary = lib;
  const c = lib.symbols;
  const errno = () => { const pointer = c[errnoName]?.(); if (!pointer) throw new Error("evidence storage unavailable"); return new DataView(toArrayBuffer(pointer, 0, 4)).getInt32(0, true); };
  const z = (s: string) => Buffer.from(`${s}\0`);
  const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
  const open = (parent: number, name: string, flags: number, mode = 0) => stackMode
    ? c.openat!(parent, z(name), flags, 0, 0, 0, 0, 0, mode) as number
    : c.openat!(parent, z(name), flags, mode) as number;
  const root = realpathSync(projectRoot), expectedRoot = lstatSync(root);
  const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let rootFd = -1, dirFd = -1, leaseFd = -1, readerFd = -1, builderFd = -1, anchorFd = -1, pins = 0, closed = false, leased = false, exclusivePins = 0;
  const buildLeases = new Set<object>();
  function regular(fd: number) {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("evidence artifact not regular");
    if (st.nlink !== 1) throw new Error(`unsafe evidence link count: ${st.nlink}`);
    if ((st.mode & 0o077) !== 0) throw new Error(`unsafe evidence artifact mode: ${st.mode.toString(8)}`);
    if (process.getuid && st.uid !== process.getuid()) throw new Error("unsafe evidence artifact owner");
    return st;
  }
  function chain(create: boolean) {
    let parent = open(rootFd, ".", dirFlags);
    if (parent < 0) throw new Error("evidence root unavailable");
    try {
      for (const name of [".metaproject", "evidence"]) {
        if (create && c.mkdirat!(parent, z(name), 0o700) !== 0 && errno() !== 17) throw new Error("evidence directory unavailable");
        const next = open(parent, name, dirFlags);
        if (next < 0) {
          if (!create && errno() === 2) throw new EvidenceStorageAbsentError("evidence index absent");
          throw new Error("unsafe evidence directory");
        }
        closeSync(parent); parent = next;
      }
      const st = fstatSync(parent);
      if ((st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) throw new Error("unsafe evidence permissions");
      return parent;
    } catch (error) { closeSync(parent); throw error; }
  }
  function validate() {
    if (closed) throw new Error("evidence scope changed");
    const rootSnapshot = lstatSync(root);
    if (!same(expectedRoot, rootSnapshot) || rootSnapshot.isSymbolicLink()) throw new Error("evidence scope changed");
    for (const [name, fd] of [[".writer", leaseFd], [".readers", readerFd], [".builder", builderFd], [".locks", anchorFd]] as const) {
      if (fd < 0) continue;
      const fresh = open(dirFd, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (fresh < 0) throw new Error("evidence lock identity missing");
      try { if (!same(fstatSync(fd), regular(fresh))) throw new Error("evidence lock identity changed"); }
      finally { closeSync(fresh); }
    }
    const current = chain(false);
    try { if (!same(fstatSync(dirFd), fstatSync(current))) throw new Error("evidence directory changed"); }
    finally { closeSync(current); }
  }
  function nameCheck(name: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(name)) throw new Error("invalid evidence artifact name");
  }
  try {
    rootFd = open(darwin ? -2 : -100, root, dirFlags);
    if (rootFd < 0 || !same(expectedRoot, fstatSync(rootFd))) throw new Error("evidence root changed");
    dirFd = chain(create);
    leaseFd = open(dirFd, ".writer", constants.O_RDWR | (create ? constants.O_CREAT : 0) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    if (leaseFd < 0) throw new Error("unsafe evidence writer lease");
    regular(leaseFd);
    if (c.flock!(leaseFd, 2 | 4) !== 0) throw new Error("evidence writer busy");
    try {
      readerFd = open(dirFd, ".readers", constants.O_RDWR | (create ? constants.O_CREAT : 0) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      if (readerFd < 0) throw new Error("reader lease unavailable");
      regular(readerFd);
      builderFd = open(dirFd, ".builder", constants.O_RDWR | (create ? constants.O_CREAT : 0) | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      if (builderFd < 0) throw new Error("build lease unavailable");
      const builder = regular(builderFd), writer = fstatSync(leaseFd), reader = fstatSync(readerFd);
      const anchor = Buffer.from(JSON.stringify([writer.dev, writer.ino, reader.dev, reader.ino, builder.dev, builder.ino]));
      anchorFd = open(dirFd, ".locks", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (anchorFd < 0) {
        if (!create || errno() !== 2) throw new Error("evidence lock anchor unavailable");
        // Loss of an initialized anchor is not a fresh storage namespace.
        for (const name of ["ledger.json", "ledger-initialized"]) {
          const existing = open(dirFd, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          if (existing >= 0) { closeSync(existing); throw new Error("evidence lock anchor missing"); }
          if (errno() !== 2) throw new Error("evidence state unavailable");
        }
        const fd = open(dirFd, ".locks", constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        if (fd < 0) throw new Error("evidence lock anchor creation failed");
        try { regular(fd); let offset = 0; while (offset < anchor.length) { const n = writeSync(fd, anchor, offset, anchor.length - offset); if (!n) throw new Error("anchor write failed"); offset += n; } fsyncSync(fd); fsyncSync(dirFd); }
        finally { closeSync(fd); }
        anchorFd = open(dirFd, ".locks", constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
      if (anchorFd < 0 || regular(anchorFd).size !== anchor.length) throw new Error("invalid evidence lock anchor");
      const actual = Buffer.alloc(anchor.length);
      if (readSync(anchorFd, actual, 0, actual.length, 0) !== actual.length || !actual.equals(anchor)) throw new Error("evidence lock inode replaced");
      validate();
    } finally { c.flock!(leaseFd, 8); }
  } catch (error) {
    for (const fd of [anchorFd, builderFd, readerFd, leaseFd, dirFd, rootFd]) if (fd >= 0) closeSync(fd);
    throw error;
  }
  return Object.freeze({
    projectRoot: root,
    /** Kernel build lease independent of immediate ledger writes. */
    acquireBuild() {
      validate();
      const fd = open(dirFd, ".builder", constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (fd < 0) throw new Error("build lease unavailable");
      try {
        if (!same(regular(fd), fstatSync(builderFd))) throw new Error("build lease changed");
        if (c.flock!(fd, 2 | 4) !== 0) throw new Error("evidence build busy");
        validate();
        const token = Object.freeze({ release() {
          if (buildLeases.delete(token)) { try { c.flock!(fd, 8); } finally { closeSync(fd); } }
        } });
        buildLeases.add(token);
        return token;
      } catch (error) { closeSync(fd); throw error; }
    },
    checkBuildLease(token: object) {
      validate();
      if (!buildLeases.has(token)) throw new Error("evidence build lease required");
    },
    /** Kernel lease is released on process death, never recovered by wall-clock age. */
    withWriter<T>(work: () => T): T {
      validate();
      const current = open(dirFd, ".writer", constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (current < 0) throw new Error("writer lease unavailable");
      try { if (!same(regular(current), fstatSync(leaseFd))) throw new Error("writer lease changed"); }
      finally { closeSync(current); }
      if (leased) throw new EvidenceWriterBusyError("evidence writer busy");
      if (c.flock!(leaseFd, 2 | 4) !== 0) {
        if (errno() === (darwin ? 35 : 11)) throw new EvidenceWriterBusyError("evidence writer busy");
        throw new Error("evidence writer lease failed");
      }
      leased = true;
      try {
        validate();
        const value = work();
        if (value && typeof (value as { then?: unknown }).then === "function") throw new Error("evidence writer callback must be synchronous");
        validate(); return value;
      } finally { leased = false; c.flock!(leaseFd, 8); }
    },
    read(name: string, maxBytes: number): Buffer | undefined {
      nameCheck(name); validate();
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("invalid evidence byte cap");
      const fd = open(dirFd, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (fd < 0) { if (errno() === 2) { validate(); return undefined; } throw new Error("evidence artifact unreadable"); }
      try {
        const before = regular(fd); if (before.size > maxBytes) throw new Error("evidence artifact exceeds cap");
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, null); if (!n) throw new Error("evidence artifact changed"); offset += n; }
        const after = regular(fd);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("evidence artifact changed");
        validate(); return bytes;
      } finally { closeSync(fd); }
    },
    writeAtomic(name: string, bytes: Buffer, beforePublish?: () => void) {
      nameCheck(name); validate(); if (!leased) throw new Error("evidence writer lease required");
      const temp = `.tmp-${randomUUID()}`;
      const fd = open(dirFd, temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (fd < 0) throw new Error("evidence staging unavailable");
      let renamed = false;
      try {
        regular(fd); let offset = 0;
        while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) throw new Error("evidence write failed"); offset += n; }
        fsyncSync(fd); beforePublish?.(); validate();
        if (c.renameat!(dirFd, z(temp), dirFd, z(name)) !== 0) throw new Error("evidence publication failed");
        renamed = true; fsyncSync(dirFd); validate();
      } finally { closeSync(fd); if (!renamed) c.unlinkat!(dirFd, z(temp), 0); }
    },
    remove(name: string) {
      nameCheck(name); validate(); if (!leased) throw new Error("evidence writer lease required");
      if (c.unlinkat!(dirFd, z(name), 0) !== 0 && errno() !== 2) throw new Error("evidence removal failed");
      fsyncSync(dirFd); validate();
    },
    /** Bounded, descriptor-relative purge; never follows symlinks or recursively deletes. */
    purgeDerived(maxEntries = 10000, preserveGeneration?: string) {
      validate();
      if (!leased || !exclusivePins) throw new Error("evidence purge requires writer and exclusive reader leases");
      if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000) throw new Error("invalid evidence inventory cap");
      if (preserveGeneration !== undefined && !/^gen-[a-f0-9]{64}\.json$/.test(preserveGeneration)) throw new Error("invalid preserved evidence generation");
      const fd = open(dirFd, ".", dirFlags);
      if (fd < 0) throw new Error("evidence inventory unavailable");
      const directory = c.fdopendir!(fd);
      if (!directory) { closeSync(fd); throw new Error("evidence inventory unavailable"); }
      const names = new Set<string>();
      try {
        while (true) {
          const errnoPointer = c[errnoName]!();
          if (!errnoPointer) throw new Error("evidence errno unavailable");
          new DataView(toArrayBuffer(errnoPointer, 0, 4)).setInt32(0, 0, true);
          const entry = c.readdir!(directory);
          if (!entry) { if (errno() !== 0) throw new Error("evidence inventory failed"); break; }
          const offset = darwin ? 21 : 19;
          const header = new DataView(toArrayBuffer(entry, 0, offset));
          const length = header.getUint16(16, true);
          if (length <= offset || length > 4096) throw new Error("invalid evidence directory record");
          const bytes = Buffer.from(toArrayBuffer(entry, offset, length - offset));
          const end = bytes.indexOf(0);
          if (end < 1 || (darwin && header.getUint16(18, true) !== end)) throw new Error("invalid evidence directory name");
          const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
          if (name === "." || name === "..") continue;
          if (names.has(name) || names.size >= maxEntries) throw new Error("evidence inventory exceeds cap or changed");
          names.add(name);
        }
      } finally { c.closedir!(directory); }
      const preserved = new Set([".writer", ".readers", ".builder", ".locks", "ledger.json", "ledger-initialized"]);
      const derived = (name: string) => name === "CURRENT" || /^gen-[a-f0-9]{64}\.json$/.test(name) || /^\.tmp-[a-f0-9-]{36}$/.test(name);
      if ([...names].some(name => !preserved.has(name) && !derived(name))) throw new Error("unknown evidence artifact refuses purge");
      validate();
      for (const name of names) if (derived(name) && !(preserveGeneration && (name === "CURRENT" || name === preserveGeneration))) {
        if (c.unlinkat!(dirFd, z(name), 0) !== 0 && errno() !== 2) throw new Error("evidence purge failed");
      }
      fsyncSync(dirFd); validate();
    },
    /** Separate descriptors make shared reader pins visible across processes. */
    pinReaders(exclusive = false): (() => void) | undefined {
      validate();
      const fd = open(dirFd, ".readers", constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (fd < 0) throw new Error("reader lease unavailable");
      try {
        if (!same(regular(fd), fstatSync(readerFd))) throw new Error("reader lease changed");
        if (c.flock!(fd, (exclusive ? 2 : 1) | 4) !== 0) {
          const error = errno();
          if (error !== (darwin ? 35 : 11)) throw new Error("reader lease failed");
          closeSync(fd); return undefined;
        }
        validate();
        const current = open(dirFd, ".readers", constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (current < 0) throw new Error("reader lease changed");
        try { if (!same(fstatSync(fd), regular(current))) throw new Error("reader lease changed"); }
        finally { closeSync(current); }
        let released = false; pins++; if (exclusive) exclusivePins++;
        return () => { if (!released) { released = true; try { c.flock!(fd, 8); } finally { closeSync(fd); pins--; if (exclusive) exclusivePins--; } } };
      } catch (error) { closeSync(fd); throw error; }
    },
    close() {
      if (closed) return;
      if (leased || pins || buildLeases.size) throw new Error("evidence leases active");
      closed = true; closeSync(anchorFd); closeSync(builderFd); closeSync(readerFd); closeSync(leaseFd); closeSync(dirFd); closeSync(rootFd);
    },
  });
}
export type EvidenceStorage = ReturnType<typeof openEvidenceStorage>;
