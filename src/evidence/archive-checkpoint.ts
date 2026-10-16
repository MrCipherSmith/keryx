import { createHash } from "node:crypto";
/** Optimization metadata only; never source authority or excerpt content. */
export interface ArchiveCheckpoint {
  schemaVersion: 1; dev: string; ino: string; completeBytes: number; prefixHash: string;
}
const MAX_BYTES = 8 * 1024 * 1024;
type Identity = { dev: number; ino: number };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function identityValid(identity: Identity) {
  return Number.isSafeInteger(identity.dev) && identity.dev >= 0 && Number.isSafeInteger(identity.ino) && identity.ino >= 0;
}
export function isArchiveCheckpoint(value: unknown): value is ArchiveCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as ArchiveCheckpoint;
  return Object.keys(state).sort().join(",") === "completeBytes,dev,ino,prefixHash,schemaVersion" &&
    state.schemaVersion === 1 && typeof state.dev === "string" && /^(0|[1-9][0-9]{0,15})$/.test(state.dev) &&
    typeof state.ino === "string" && /^(0|[1-9][0-9]{0,15})$/.test(state.ino) &&
    Number.isSafeInteger(Number(state.dev)) && Number.isSafeInteger(Number(state.ino)) &&
    Number.isSafeInteger(state.completeBytes) && state.completeBytes >= 0 && state.completeBytes <= MAX_BYTES &&
    typeof state.prefixHash === "string" && /^[a-f0-9]{64}$/.test(state.prefixHash);
}
export function createArchiveCheckpoint(bytes: Buffer, identity: Identity): Readonly<ArchiveCheckpoint> {
  if (bytes.length > MAX_BYTES || !identityValid(identity)) throw Error("invalid archive checkpoint source");
  const completeBytes = bytes.lastIndexOf(10) + 1;
  return Object.freeze({ schemaVersion: 1, dev: String(identity.dev), ino: String(identity.ino),
    completeBytes, prefixHash: hash(bytes.subarray(0, completeBytes)) });
}
/** Must use fresh descriptor-read bytes, not checkpoint alone. */
export function canAppendArchive(bytes: Buffer, identity: Identity, previous: unknown): boolean {
  if (bytes.length > MAX_BYTES || !identityValid(identity) || !isArchiveCheckpoint(previous)) return false;
  const end = previous.completeBytes;
  return previous.dev === String(identity.dev) && previous.ino === String(identity.ino) &&
    end <= bytes.length && (end === 0 || bytes[end - 1] === 10) && hash(bytes.subarray(0, end)) === previous.prefixHash;
}
