import { createHash } from "node:crypto";
import path from "node:path";
import { ensureKeryxSubdir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "./config-dir";

function setupRootKey(root: string): string {
  return createHash("sha256").update(root).digest("hex");
}

function receiptPath(root: string): string {
  return path.join(keryxConfigDir(), "setup-receipts", `${setupRootKey(root)}.json`);
}

export function setupLockPath(root: string, commonDir: string | null): string {
  return commonDir
    ? path.join(commonDir, "keryx-setup.lock")
    : path.join(keryxConfigDir(), "setup-locks", `${setupRootKey(root)}.lock`);
}

export function readSetupReceipt(root: string): Record<string, unknown> | null {
  const record = readConfigFile(receiptPath(root));
  if (!record.ok) return null;
  try {
    const value = JSON.parse(record.text) as Record<string, unknown> | null;
    return value?.schemaVersion === 1 && value.root === root ? value : null;
  } catch {
    return null;
  }
}

export function writeSetupReceipt(root: string, result: Record<string, unknown>): void {
  ensureKeryxSubdir(["setup-receipts"]);
  writeOwnerOnlyFileAtomic(receiptPath(root), JSON.stringify({ ...result, schemaVersion: 1, root }));
}
