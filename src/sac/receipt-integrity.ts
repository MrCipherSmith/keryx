import { createHash } from "node:crypto";
import { validateAccessReceiptDocument } from "./index";

export type AccessReceiptPreviousHash = "GENESIS" | string;

export type IntegrityLinkedAccessReceipt = Readonly<{
  schemaVersion: "1.0";
  id: string;
  workspaceId: string;
  actor: string;
  action: "overview" | "fwk" | "resource";
  decision: "allowed" | "denied" | "budget-exhausted" | "stale";
  recordedAt: string;
  cost: Readonly<{ tokens?: number; toolCalls: number; elapsedMs: number }>;
  contextAssembly: Readonly<{
    traceRef: string;
    configurationRevision: string;
    selected: readonly string[];
    omittedOptional: readonly string[];
  }>;
  policy: Readonly<{ ref: string; revision: string }>;
  resourceRef?: string;
  outcome?: "unknown" | "useful" | "not-useful";
  integrity: Readonly<{
    recordHash: string;
    previousRecordHash: AccessReceiptPreviousHash;
  }>;
}>;

export type AccessReceiptBody = Omit<IntegrityLinkedAccessReceipt, "integrity">;

export type AccessReceiptLedgerVerification =
  | Readonly<{ ok: true; headHash: string; verifiedCount: number }>
  | Readonly<{
      ok: false;
      firstInvalidIndex: number;
      validPrefixLength: number;
      reason:
        | "invalid-record-shape"
        | "record-hash-mismatch"
        | "predecessor-mismatch"
        | "duplicate-record-hash";
    }>;

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function bodyOf(receipt: IntegrityLinkedAccessReceipt): AccessReceiptBody {
  const { integrity: _integrity, ...body } = receipt;
  return body as AccessReceiptBody;
}

/**
 * Reproduce the receipt writer's v1 record hash. Object insertion order is part
 * of the v1 JSONL contract, so this intentionally does not sort keys.
 */
export function hashAccessReceipt(
  body: AccessReceiptBody,
  previousRecordHash: AccessReceiptPreviousHash,
): string {
  return sha256(JSON.stringify({ ...body, integrity: { previousRecordHash } }));
}

export function sealAccessReceipt(
  input: AccessReceiptBody,
  previousRecordHash: AccessReceiptPreviousHash,
): IntegrityLinkedAccessReceipt {
  const { integrity: _unexpectedIntegrity, ...body } = input as AccessReceiptBody & {
    integrity?: unknown;
  };
  const recordHash = hashAccessReceipt(body as AccessReceiptBody, previousRecordHash);
  return {
    ...(body as AccessReceiptBody),
    integrity: { previousRecordHash, recordHash },
  };
}

/** Verify one receipt's closed schema and record hash without assuming it is genesis. */
export function verifyAccessReceiptRecord(receipt: IntegrityLinkedAccessReceipt): boolean {
  return validateAccessReceiptDocument(receipt).valid
    && hashAccessReceipt(bodyOf(receipt), receipt.integrity.previousRecordHash) === receipt.integrity.recordHash;
}

/** Verify the complete ordered ledger; a valid prefix is never mistaken for a valid ledger. */
export function verifyAccessReceiptLedger(
  receipts: readonly IntegrityLinkedAccessReceipt[],
): AccessReceiptLedgerVerification {
  let expectedPrevious: AccessReceiptPreviousHash = "GENESIS";
  const hashes = new Set<string>();
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    if (!validateAccessReceiptDocument(receipt).valid) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "invalid-record-shape" };
    }
    if (hashes.has(receipt.integrity.recordHash)) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "duplicate-record-hash" };
    }
    if (receipt.integrity.previousRecordHash !== expectedPrevious) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "predecessor-mismatch" };
    }
    if (!verifyAccessReceiptRecord(receipt)) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "record-hash-mismatch" };
    }
    hashes.add(receipt.integrity.recordHash);
    expectedPrevious = receipt.integrity.recordHash;
  }
  return { ok: true, headHash: expectedPrevious, verifiedCount: receipts.length };
}
