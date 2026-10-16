import { lstatSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readDescriptorChain, type DescriptorIdentity } from "../lib/descriptor-read";

/** Owner capability only; never serialize this closure or accept it from tool input. */
export function createFileConfirmation(input: {
  root: string; relativePath: string; maxBytes: number; rootIdentity: DescriptorIdentity;
  targetIdentity: DescriptorIdentity; versionHash: string; signal?: AbortSignal;
}): () => boolean {
  const root = input.root, target = path.join(root, input.relativePath), maxBytes = input.maxBytes;
  const rootIdentity = { dev: input.rootIdentity.dev, ino: input.rootIdentity.ino };
  const targetIdentity = { dev: input.targetIdentity.dev, ino: input.targetIdentity.ino };
  const versionHash = input.versionHash, signal = input.signal;
  return () => {
    try {
      if (signal?.aborted) return false;
      const before = lstatSync(target);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes ||
          before.dev !== targetIdentity.dev || before.ino !== targetIdentity.ino) return false;
      const bytes = readDescriptorChain(root, target, {
        maxBytes, requireRegularFile: true, expectedRootIdentity: rootIdentity, expectedTargetIdentity: targetIdentity,
      });
      const after = lstatSync(target), owner = lstatSync(root);
      return !signal?.aborted && owner.isDirectory() && !owner.isSymbolicLink() &&
        owner.dev === rootIdentity.dev && owner.ino === rootIdentity.ino &&
        after.isFile() && !after.isSymbolicLink() && after.nlink === 1 &&
        after.dev === before.dev && after.ino === before.ino && bytes.length === before.size &&
        after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs &&
        createHash("sha256").update(bytes).digest("hex") === versionHash;
    } catch { return false; }
  };
}
// Scanner revalidation, ledger, retention, deadline and reader pins remain the delivery owner's duties.
