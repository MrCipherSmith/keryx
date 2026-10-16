import { createHash } from "node:crypto";
import { evidenceVectorKey, type EvidenceVectorIdentity } from "./hybrid";

export interface EvidenceVectorRecord {
  readonly contentHash: string; readonly key: string; readonly values: readonly number[];
}
export interface EvidenceVectorSnapshot {
  readonly schemaVersion: 1; readonly identity: Readonly<EvidenceVectorIdentity>;
  readonly records: readonly EvidenceVectorRecord[]; readonly sha256: string;
}
const MAX_BYTES = 256 * 1024 * 1024;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keys = (value: object) => Object.keys(value).sort().join(",");
function identityCopy(value: EvidenceVectorIdentity): EvidenceVectorIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      keys(value) !== "adapter,dimensions,model,project,revision,sanitizer") throw Error("invalid evidence vector identity");
  evidenceVectorKey(value, "0".repeat(64));
  return { project: value.project, adapter: value.adapter, model: value.model,
    revision: value.revision, dimensions: value.dimensions, sanitizer: value.sanitizer };
}
function cap(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BYTES) throw Error("invalid evidence vector byte cap");
}
/** Pure immutable generation member. No disk/network/model load or query writes. */
export function createEvidenceVectorSnapshot(identity: EvidenceVectorIdentity,
  input: readonly EvidenceVectorRecord[], maxBytes = MAX_BYTES): EvidenceVectorSnapshot {
  cap(maxBytes);
  const copied = identityCopy(identity);
  if (!Array.isArray(input) || input.length > 100000 || input.length * copied.dimensions * 8 > maxBytes)
    throw Error("evidence vector budget exceeded");
  const seen = new Set<string>();
  const records = Array.from(input, record => {
    if (!record || typeof record !== "object" || Array.isArray(record) || keys(record) !== "contentHash,key,values" ||
        record.key !== evidenceVectorKey(copied, record.contentHash) || seen.has(record.key) ||
        !Array.isArray(record.values) || record.values.length !== copied.dimensions ||
        Array.from(record.values).some((value: unknown) => typeof value !== "number" || !Number.isFinite(value)) ||
        !record.values.some((value: unknown) => typeof value === "number" && value !== 0)) throw Error("invalid evidence vector record");
    seen.add(record.key);
    return Object.freeze({ contentHash: record.contentHash, key: record.key, values: Object.freeze([...record.values]) });
  }).sort((a, b) => a.key.localeCompare(b.key));
  const body = { schemaVersion: 1 as const, identity: Object.freeze(copied), records: Object.freeze(records) };
  const snapshot = Object.freeze({ ...body, sha256: digest(body) });
  if (Buffer.byteLength(JSON.stringify(snapshot)) > maxBytes) throw Error("evidence vector budget exceeded");
  return snapshot;
}
/** Reconstruct untrusted data; checksum alone is not authority. */
export function readEvidenceVectorSnapshot(value: unknown, expected: EvidenceVectorIdentity,
  maxBytes = MAX_BYTES): EvidenceVectorSnapshot {
  cap(maxBytes);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      keys(value) !== "identity,records,schemaVersion,sha256") throw Error("invalid evidence vector snapshot");
  const input = value as EvidenceVectorSnapshot;
  if (input.schemaVersion !== 1 || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256))
    throw Error("invalid evidence vector snapshot");
  const approved = identityCopy(expected);
  const snapshot = createEvidenceVectorSnapshot(input.identity, input.records, maxBytes);
  if (JSON.stringify(snapshot.identity) !== JSON.stringify(approved) || snapshot.sha256 !== input.sha256)
    throw Error("incompatible or corrupt evidence vectors");
  return snapshot;
}
/** Reuse sanitized embeddings, never stale citation metadata. */
export function reusableEvidenceVectors(snapshot: EvidenceVectorSnapshot | undefined,
  expected: EvidenceVectorIdentity, contentHashes: readonly string[]): readonly EvidenceVectorRecord[] {
  if (!Array.isArray(contentHashes) || contentHashes.length > 100000) throw Error("evidence vector budget exceeded");
  const wanted = new Set(contentHashes.map(hash => evidenceVectorKey(expected, hash)));
  if (!snapshot) return Object.freeze([]);
  let checked: EvidenceVectorSnapshot;
  try { checked = readEvidenceVectorSnapshot(snapshot, expected); }
  catch { return Object.freeze([]); }
  return Object.freeze(checked.records.filter(record => wanted.has(record.key)));
}
