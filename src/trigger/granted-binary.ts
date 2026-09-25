// Flow 295 (F1d, N2, N6): pinning the program a granted tool runs.
//
// A granted program holds the operator's credentials outside the sandbox, so what
// runs must be exactly what the operator confirmed:
//
//   - its basename is the program (`bins.gh` is a program named `gh`);
//   - it resolves OUTSIDE the project, so no committed `bin/` can supply it;
//   - it is not a version-manager shim (`…/shims/gh`). A shim chooses its target at run
//     time by design, so it is refused, with a pointer to `mise which` / `asdf which`;
//   - its realpath, sha256, inode and mtime are recorded and signed with the schedule.
//
// A `#!` script is ALLOWED when it resolves outside the project. The operator's own
// `~/.local/bin/gh` is such a wrapper. Its interpreter is pinned the same way: for
// `#!/usr/bin/env X`, X is resolved on PATH, and its realpath, sha256, inode and mtime
// are recorded. At run time both files are re-checked, and before every exec the inode,
// size and mtime are checked again. The script runs from an empty keryx-owned directory
// (never the project), so a project file cannot steer it. What a wrapper reads from its
// OWN global configuration (for example `~/.config/...`) is the operator's machine, and
// outside what keryx pins.

import { createHash } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** What identifies one pinned file. */
export interface FilePin {
  readonly realpath: string;
  readonly sha256: string;
  readonly ino?: number;
  readonly mtimeMs?: number;
}

/** A granted program's pin: the file itself, and the interpreter when it is a `#!` script. */
export interface BinaryPin extends FilePin {
  readonly interpreter?: FilePin & {
    /** The interpreter as the shebang names it: an absolute path, or a bare name for `#!/usr/bin/env X`. */
    readonly command: string;
  };
}

/** Cheap identity used before every exec (N6). */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

export function identityOf(file: string): FileIdentity | undefined {
  try {
    const st = statSync(file);
    return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

export function sameIdentity(a: FileIdentity, b: FileIdentity | undefined): boolean {
  return b !== undefined && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * `p`'s realpath when it exists — otherwise the realpath of its NEAREST
 * EXISTING ancestor, with the missing tail rejoined, rather than the
 * unresolved `path.resolve(p)`.
 *
 * R3 regression fix (flow 319 CI): `resolvesInsideProject` compares this
 * function's output for a project root (which exists, so it always got a
 * real, symlink-resolved path) against its output for an invocation's
 * `scriptPath` — which does NOT exist yet for a schedule that has never
 * actually been installed (`keryx trigger install` writes the timer; it
 * never creates the entry script). The plain `path.resolve(p)` fallback left
 * a symlinked ancestor UNresolved on the file side while the project-root
 * side WAS resolved — on macOS, where `/tmp`/`/var` are themselves symlinks
 * into `/private/...`, a project root under `os.tmpdir()` realpath'd to
 * `/private/var/folders/...` while a non-existent script path under the same
 * directory stayed `/var/folders/...`, so `isInside` compared two paths that
 * disagreed on a leading `/private` and never matched — silently defeating
 * the "keryx running from inside this project is refused" check (`schedules.
 * ts`'s `insideRunner`) for the exact case (a script path, not yet on disk,
 * under a project) it exists to catch. Walking up to the nearest existing
 * ancestor and rejoining the missing tail resolves the SAME symlinks a real
 * file at that path would have resolved through, without requiring the file
 * to exist first.
 */
export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return path.resolve(p); // reached the filesystem root without finding anything real
    return path.join(realOr(parent), path.basename(p));
  }
}

/**
 * Flow 295 (M1): does `file` (as given, or through its realpath) resolve inside the project?
 * The same rule decides a granted binary and the keryx the timer runs.
 */
export function resolvesInsideProject(projectRoot: string, file: string): boolean {
  const root = realOr(projectRoot);
  return isInside(root, realOr(file)) || isInside(root, path.resolve(file));
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Search PATH for an executable. */
export function resolveOnPath(program: string, pathEnv: string | undefined = process.env["PATH"]): string | undefined {
  if (path.isAbsolute(program)) return program;
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, program);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return undefined;
}

/** The `#!` line of `file`, without the `#!`, or `undefined` when it is not a script. */
export function shebangOf(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(256);
    const read = readSync(fd, head, 0, head.length, 0);
    const text = head.subarray(0, read).toString("latin1");
    if (!text.startsWith("#!")) return undefined;
    return text.slice(2).split("\n")[0]!.trim();
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The interpreter a shebang runs: the absolute path, or the bare name after `/usr/bin/env [-S] [VAR=…]`. */
export function interpreterCommand(shebang: string): string | undefined {
  const words = shebang.split(/\s+/).filter((w) => w.length > 0);
  const first = words[0];
  if (first === undefined || !path.isAbsolute(first)) return undefined;
  if (path.basename(first) !== "env") return first;
  for (const word of words.slice(1)) {
    if (word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word;
  }
  return undefined;
}

function shimReason(program: string, file: string): string | undefined {
  if (file.split(path.sep).includes("shims")) {
    return (
      `"${file}" is a version-manager shim, which picks its target at run time — point PATH at the real binary, ` +
      `e.g. the path \`mise which ${program}\` or \`asdf which ${program}\` prints`
    );
  }
  return undefined;
}

function pinFile(file: string): FilePin {
  const real = realpathSync(file);
  const st = statSync(real);
  return { realpath: real, sha256: createHash("sha256").update(readFileSync(real)).digest("hex"), ino: st.ino, mtimeMs: st.mtimeMs };
}

/**
 * Pin a granted program at confirmation time. `bin` is the path found on PATH.
 * Refuses shims, a program or interpreter inside the project, a script whose
 * interpreter cannot be resolved, and a script whose interpreter is itself a script.
 */
export function pinGrantedBinary(
  program: string,
  bin: string,
  projectRoot: string,
  pathEnv: string | undefined = process.env["PATH"],
): { readonly ok: true; readonly pin: BinaryPin } | { readonly ok: false; readonly reason: string } {
  if (path.basename(bin) !== program) return { ok: false, reason: `"${bin}" is not a program named "${program}"` };
  const root = realOr(projectRoot);
  const real = realOr(bin);
  if (isInside(root, real) || isInside(root, path.resolve(bin))) {
    return { ok: false, reason: `"${program}" resolves inside this project (${real}) — a granted program must come from outside the project` };
  }
  const shim = shimReason(program, bin) ?? shimReason(program, real);
  if (shim !== undefined) return { ok: false, reason: shim };
  let pin: FilePin;
  try {
    pin = pinFile(bin);
  } catch (error) {
    return { ok: false, reason: `${real} could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  const shebang = shebangOf(real);
  if (shebang === undefined) return { ok: true, pin };
  const command = interpreterCommand(shebang);
  const interpreterPath = command === undefined ? undefined : resolveOnPath(command, pathEnv);
  if (command === undefined || interpreterPath === undefined) {
    return { ok: false, reason: `"${bin}" is a script whose interpreter (#!${shebang}) could not be resolved` };
  }
  const interpReal = realOr(interpreterPath);
  if (isInside(root, interpReal) || isInside(root, path.resolve(interpreterPath))) {
    return { ok: false, reason: `the interpreter of "${bin}" resolves inside this project (${interpReal})` };
  }
  const interpShim = shimReason(path.basename(command), interpreterPath) ?? shimReason(path.basename(command), interpReal);
  if (interpShim !== undefined) return { ok: false, reason: `the interpreter of "${bin}": ${interpShim}` };
  if (shebangOf(interpReal) !== undefined) {
    return { ok: false, reason: `the interpreter of "${bin}" (${interpReal}) is itself a script; pin a real interpreter` };
  }
  try {
    return { ok: true, pin: { ...pin, interpreter: { command, ...pinFile(interpreterPath) } } };
  } catch (error) {
    return { ok: false, reason: `the interpreter ${interpReal} could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
}

async function checkFile(label: string, file: string, pin: FilePin): Promise<{ ok: true; identity: FileIdentity } | { ok: false; reason: string }> {
  let real: string;
  try {
    real = realpathSync(file);
  } catch {
    return { ok: false, reason: `${label} "${file}" no longer exists` };
  }
  if (real !== pin.realpath) return { ok: false, reason: `${label} "${file}" now resolves to ${real}, not ${pin.realpath} as confirmed` };
  const before = identityOf(real);
  if (before === undefined) return { ok: false, reason: `${label} ${real} cannot be read` };
  if ((pin.ino !== undefined && before.ino !== pin.ino) || (pin.mtimeMs !== undefined && before.mtimeMs !== pin.mtimeMs)) {
    return { ok: false, reason: `${label} ${real} changed since it was confirmed (inode or mtime differs)` };
  }
  let digest: string;
  try {
    digest = createHash("sha256").update(readFileSync(real)).digest("hex");
  } catch (error) {
    return { ok: false, reason: `${label} ${real} could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (digest !== pin.sha256) return { ok: false, reason: `${label} ${real} changed since it was confirmed (sha256 differs)` };
  if (!sameIdentity(before, identityOf(real))) return { ok: false, reason: `${label} ${real} changed while it was being verified` };
  return { ok: true, identity: before };
}

/** A verified file and the identity to re-check before each exec. */
export interface VerifiedFile {
  readonly file: string;
  readonly identity: FileIdentity;
}

/**
 * Re-check a pin at run time, before any model call. For a script, the interpreter is
 * resolved again on the RUNTIME PATH, because that is what `env` will run, and it must
 * be the pinned file. Returns the files to re-check before every exec.
 */
export async function verifyGrantedBinary(
  program: string,
  bin: string,
  pin: BinaryPin,
  projectRoot: string,
  pathEnv: string | undefined,
): Promise<{ readonly ok: true; readonly realpath: string; readonly files: readonly VerifiedFile[] } | { readonly ok: false; readonly reason: string }> {
  if (path.basename(bin) !== program) return { ok: false, reason: `granted binary for "${program}" is "${bin}", not a program named "${program}"` };
  const root = realOr(projectRoot);
  const real = realOr(bin);
  if (isInside(root, real) || isInside(root, path.resolve(bin))) {
    return { ok: false, reason: `granted binary "${bin}" resolves inside the project (${real}) — a project may not supply the program that holds your credentials` };
  }
  const main = await checkFile("granted binary", bin, pin);
  if (!main.ok) return main;
  const files: VerifiedFile[] = [{ file: pin.realpath, identity: main.identity }];
  const shebang = shebangOf(pin.realpath);
  if (shebang !== undefined || pin.interpreter !== undefined) {
    if (pin.interpreter === undefined) return { ok: false, reason: `granted binary ${pin.realpath} became a script after it was confirmed` };
    const command = shebang === undefined ? undefined : interpreterCommand(shebang);
    if (command !== pin.interpreter.command) {
      return { ok: false, reason: `granted script ${pin.realpath} now names interpreter "${command ?? "?"}", not "${pin.interpreter.command}"` };
    }
    const now = resolveOnPath(command, pathEnv);
    if (now === undefined) return { ok: false, reason: `the interpreter "${command}" of ${pin.realpath} is not on PATH` };
    if (isInside(root, realOr(now))) return { ok: false, reason: `the interpreter of ${pin.realpath} resolves inside the project` };
    const interp = await checkFile("the interpreter", now, pin.interpreter);
    if (!interp.ok) return interp;
    files.push({ file: pin.interpreter.realpath, identity: interp.identity });
  }
  return { ok: true, realpath: pin.realpath, files };
}
