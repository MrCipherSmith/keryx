import { createHash } from "node:crypto";

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

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z][a-z0-9-]{2,63}$/;
const subjectPattern = /^(?:user|team|service|agent):[a-z0-9][a-z0-9._-]{0,127}$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const workspacePathPattern = /^\.\/(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const utcPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStrictUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = utcPattern.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

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

function hasReceiptShape(receipt: IntegrityLinkedAccessReceipt): boolean {
  if (!isRecord(receipt)
    || !hasExactKeys(receipt, [
      "schemaVersion", "id", "workspaceId", "actor", "action", "decision", "recordedAt",
      "cost", "contextAssembly", "policy", "integrity",
    ], ["resourceRef", "outcome"])
    || receipt.schemaVersion !== "1.0"
    || !idPattern.test(receipt.id)
    || !idPattern.test(receipt.workspaceId)
    || !subjectPattern.test(receipt.actor)
    || !["overview", "fwk", "resource"].includes(receipt.action)
    || !["allowed", "denied", "budget-exhausted", "stale"].includes(receipt.decision)
    || !isStrictUtcTimestamp(receipt.recordedAt)) return false;

  if (!isRecord(receipt.cost)
    || !hasExactKeys(receipt.cost, ["toolCalls", "elapsedMs"], ["tokens"])
    || (receipt.cost.tokens !== undefined && !isNonNegativeInteger(receipt.cost.tokens))
    || !isNonNegativeInteger(receipt.cost.toolCalls)
    || !isNonNegativeInteger(receipt.cost.elapsedMs)) return false;

  const assembly = receipt.contextAssembly;
  if (!isRecord(assembly)
    || !hasExactKeys(assembly, ["traceRef", "configurationRevision", "selected", "omittedOptional"])
    || !workspacePathPattern.test(assembly.traceRef)
    || !revisionPattern.test(assembly.configurationRevision)
    || !Array.isArray(assembly.selected)
    || !assembly.selected.every((entry) => typeof entry === "string" && workspacePathPattern.test(entry))
    || !Array.isArray(assembly.omittedOptional)
    || !assembly.omittedOptional.every((entry) => typeof entry === "string" && workspacePathPattern.test(entry))) return false;

  if (!isRecord(receipt.policy)
    || !hasExactKeys(receipt.policy, ["ref", "revision"])
    || !workspacePathPattern.test(receipt.policy.ref)
    || !revisionPattern.test(receipt.policy.revision)) return false;

  if (!isRecord(receipt.integrity)
    || !hasExactKeys(receipt.integrity, ["recordHash", "previousRecordHash"])
    || !hashPattern.test(receipt.integrity.recordHash)
    || (receipt.integrity.previousRecordHash !== "GENESIS" && !hashPattern.test(receipt.integrity.previousRecordHash))) return false;

  if ((receipt.action === "resource") !== (typeof receipt.resourceRef === "string")) return false;
  if (receipt.resourceRef !== undefined && !workspacePathPattern.test(receipt.resourceRef)) return false;
  return receipt.outcome === undefined || ["unknown", "useful", "not-useful"].includes(receipt.outcome);
}

/** Verify the complete ordered ledger; a valid prefix is never mistaken for a valid ledger. */
export function verifyAccessReceiptLedger(
  receipts: readonly IntegrityLinkedAccessReceipt[],
): AccessReceiptLedgerVerification {
  let expectedPrevious: AccessReceiptPreviousHash = "GENESIS";
  const hashes = new Set<string>();
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    if (!hasReceiptShape(receipt)) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "invalid-record-shape" };
    }
    if (hashes.has(receipt.integrity.recordHash)) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "duplicate-record-hash" };
    }
    if (receipt.integrity.previousRecordHash !== expectedPrevious) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "predecessor-mismatch" };
    }
    if (hashAccessReceipt(bodyOf(receipt), receipt.integrity.previousRecordHash) !== receipt.integrity.recordHash) {
      return { ok: false, firstInvalidIndex: index, validPrefixLength: index, reason: "record-hash-mismatch" };
    }
    hashes.add(receipt.integrity.recordHash);
    expectedPrevious = receipt.integrity.recordHash;
  }
  return { ok: true, headHash: expectedPrevious, verifiedCount: receipts.length };
}
