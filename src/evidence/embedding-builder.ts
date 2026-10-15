import { createHash } from "node:crypto";
import { resolveCapability, type CapabilitySpec } from "../capability/seam";
import { evidenceVectorKey, type EvidenceVectorIdentity } from "./hybrid";
import type { LexicalChunk } from "./search";
import { createEvidenceVectorSnapshot, reusableEvidenceVectors, type EvidenceVectorSnapshot } from "./vector-cache";

export interface EvidenceEmbeddingRequest { readonly texts: readonly string[]; readonly signal: AbortSignal }
export interface EvidenceEmbeddingOptions {
  projectRoot: string; identity: EvidenceVectorIdentity;
  spec: CapabilitySpec<EvidenceEmbeddingRequest, readonly (readonly number[])[]>;
  remote: boolean;
  /** Owner-only attestation of corpus/provider consent AND approved network path.
   * Config/model selection is not a grant. Called before adapter resolution.
   * No text is passed to this gate; identity binds the proposed destination. */
  authorizeRemote?: (request: { readonly identity: Readonly<EvidenceVectorIdentity>;
    readonly purpose: "corpus" | "query"; readonly signal: AbortSignal }) => Promise<boolean>;
  maxBytes?: number;
}
function checkpoint(signal: AbortSignal) {
  if (signal.aborted) throw Error("evidence embedding aborted");
}
/** Dispose listeners on every outcome; late model results never escape. */
async function abortable<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  checkpoint(signal);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(Error("evidence embedding aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([cancelled, Promise.resolve().then(() => { checkpoint(signal); return action(); })]); }
  finally { signal.removeEventListener("abort", abort); }
}
/** Runtime-owned callback for immutable generation publication. Inputs MUST have
 * passed the source scanner. No download, standalone cache writes or query cache.
 * Installed local adapters must declare their pinned asset in the supplied spec. */
export function createEvidenceEmbeddingBuilder(options: EvidenceEmbeddingOptions, purpose: "corpus" | "query" = "corpus") {
  const identity = Object.freeze({ ...options.identity }), spec = Object.freeze({ ...options.spec });
  const { projectRoot, remote, authorizeRemote } = options;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  evidenceVectorKey(identity, "0".repeat(64));
  if (identity.project !== projectRoot || identity.adapter !== spec.id || typeof remote !== "boolean" ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024)
    throw Error("invalid evidence embedding configuration");
  return async (chunks: readonly LexicalChunk[], previous: EvidenceVectorSnapshot | undefined,
    signal: AbortSignal): Promise<EvidenceVectorSnapshot> => {
    checkpoint(signal);
    if (!Array.isArray(chunks) || chunks.length > 100000) throw Error("evidence embedding budget exceeded");
    const texts = new Map<string, string>();
    let bytes = 0;
    for (const chunk of chunks) {
      checkpoint(signal);
      if (!chunk || typeof chunk.text !== "string" || !chunk.text || Buffer.byteLength(chunk.text) > 16384 ||
          createHash("sha256").update(chunk.text).digest("hex") !== chunk.contentHash)
        throw Error("invalid evidence embedding input");
      bytes += Buffer.byteLength(chunk.text);
      if (bytes > maxBytes) throw Error("evidence embedding budget exceeded");
      texts.set(chunk.contentHash, chunk.text);
    }
    if (texts.size * identity.dimensions * 8 > maxBytes) throw Error("evidence embedding budget exceeded");
    const hashes = [...texts.keys()], records = [...reusableEvidenceVectors(previous, identity, hashes)];
    const cached = new Set(records.map(record => record.contentHash));
    const pending = hashes.filter(hash => !cached.has(hash));
    if (!pending.length) return createEvidenceVectorSnapshot(identity, records, maxBytes);
    if (remote && (!authorizeRemote || await abortable(signal, () => authorizeRemote(
      Object.freeze({ identity, purpose, signal }))) !== true))
      throw Error("evidence remote embedding not authorized");
    if (!remote && !spec.asset) throw Error("evidence local embedding requires a pinned asset");
    const adapter = await abortable(signal, () => resolveCapability(projectRoot, spec, signal));
    checkpoint(signal);
    if (!adapter || adapter.id !== identity.adapter) throw Error("evidence embedding unavailable");
    for (let offset = 0; offset < pending.length; offset += 32) {
      const batch = pending.slice(offset, offset + 32);
      const input = Object.freeze({ texts: Object.freeze(batch.map(hash => texts.get(hash)!)), signal });
      const values = await abortable(signal, () => adapter.run(input));
      checkpoint(signal);
      if (!Array.isArray(values) || values.length !== batch.length) throw Error("invalid evidence embedding output");
      const validated = createEvidenceVectorSnapshot(identity, batch.map((contentHash, index) => ({
        contentHash, key: evidenceVectorKey(identity, contentHash), values: values[index]!,
      })), maxBytes);
      for (const record of validated.records) records.push(record);
    }
    checkpoint(signal);
    return createEvidenceVectorSnapshot(identity, records, maxBytes);
  };
}
