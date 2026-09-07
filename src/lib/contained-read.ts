import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DescriptorReadError, readDescriptorChainAsync, type DescriptorIdentity, type DescriptorReadOptions } from "./descriptor-read";

export type ContainedReadCode =
  | "CONTAINED_READ_UNAVAILABLE"
  | "CONTAINED_READ_OUTSIDE"
  | "CONTAINED_READ_NOT_FOUND"
  | "CONTAINED_READ_NOT_REGULAR"
  | "CONTAINED_READ_TOO_LARGE"
  | "CONTAINED_READ_RACE"
  | "CONTAINED_READ_FAILED";

export class ContainedReadError extends Error {
  constructor(readonly code: ContainedReadCode, message: string) {
    super(message);
    this.name = "ContainedReadError";
  }
}

export interface ContainedReadOptions {
  maxBytes?: number;
  requireRegularFile?: boolean;
  backend?: DescriptorReadOptions["backend"];
  hooks?: { beforeOpen?: () => Promise<void> | void };
}

export const DEFAULT_CONTAINED_READ_MAX_BYTES = 8 * 1024 * 1024;

/** Read one regular file while keeping the owner root pinned to its identity. */
export async function readContainedFile(
  ownerRoot: string,
  candidatePath: string,
  options: ContainedReadOptions = {},
): Promise<Buffer> {
  if (options.backend === "unsupported") {
    throw new ContainedReadError("CONTAINED_READ_UNAVAILABLE", "safe descriptor source reads are unavailable on this platform");
  }
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)) {
    throw new ContainedReadError("CONTAINED_READ_TOO_LARGE", "contained source byte limit is invalid");
  }
  const maxBytes = options.maxBytes ?? DEFAULT_CONTAINED_READ_MAX_BYTES;
  let rootReal: string;
  let targetReal: string;
  let rootIdentity: DescriptorIdentity;
  let targetIdentity: DescriptorIdentity;
  try {
    const rootStat = await lstat(ownerRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new ContainedReadError("CONTAINED_READ_RACE", "contained source owner root changed");
    rootIdentity = rootStat;
    rootReal = await realpath(ownerRoot);
    targetReal = await realpath(candidatePath);
    const targetStat = await stat(targetReal);
    if (options.requireRegularFile !== false && !targetStat.isFile()) {
      throw new ContainedReadError("CONTAINED_READ_NOT_REGULAR", "contained source is not a regular file");
    }
    targetIdentity = targetStat;
  } catch (error) {
    if (error instanceof ContainedReadError) throw error;
    throw new ContainedReadError("CONTAINED_READ_NOT_FOUND", "contained source is unavailable");
  }
  if (!isInside(rootReal, targetReal)) throw new ContainedReadError("CONTAINED_READ_OUTSIDE", "contained source is outside its owner root");
  try {
    const descriptorOptions: DescriptorReadOptions = {
      maxBytes,
      requireRegularFile: options.requireRegularFile ?? true,
      expectedRootIdentity: rootIdentity,
      expectedTargetIdentity: targetIdentity,
    };
    if (options.backend !== undefined) descriptorOptions.backend = options.backend;
    if (options.hooks?.beforeOpen !== undefined) descriptorOptions.beforeOpen = options.hooks.beforeOpen;
    return await readDescriptorChainAsync(rootReal, targetReal, descriptorOptions);
  } catch (error) {
    throw mapDescriptorError(error);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function mapDescriptorError(error: unknown): ContainedReadError {
  if (!(error instanceof DescriptorReadError)) return new ContainedReadError("CONTAINED_READ_FAILED", "contained source read failed");
  const code: ContainedReadCode = error.code === "unavailable"
    ? "CONTAINED_READ_UNAVAILABLE"
    : error.code === "not-regular"
      ? "CONTAINED_READ_NOT_REGULAR"
      : error.code === "too-large"
        ? "CONTAINED_READ_TOO_LARGE"
        : error.code === "race"
          ? "CONTAINED_READ_RACE"
          : error.code === "invalid-path"
            ? "CONTAINED_READ_OUTSIDE"
            : "CONTAINED_READ_FAILED";
  const message = code === "CONTAINED_READ_UNAVAILABLE"
    ? "safe descriptor source reads are unavailable on this platform"
    : code === "CONTAINED_READ_NOT_REGULAR"
      ? "contained source is not a regular file"
      : code === "CONTAINED_READ_TOO_LARGE"
        ? "contained source exceeds the byte limit"
        : code === "CONTAINED_READ_RACE"
          ? "contained source changed during secure open"
          : "contained source read failed";
  return new ContainedReadError(code, message);
}
