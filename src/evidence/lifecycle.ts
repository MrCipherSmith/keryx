import { createHash } from "node:crypto";
import { EvidenceWriterBusyError, type EvidenceStorage } from "./storage";
import { createSessionEvidenceOwner, isSessionEvidenceId } from "../session/evidence-revocation";
export interface EvidenceSourceScope { kind: "file" | "session-archive"; id: string }
interface Ledger { version: 1; revision: number; revoked: string[]; epoch: number; clearing: boolean }
const cap = 300000;
function key(source: EvidenceSourceScope) {
  if (!source || !["file", "session-archive"].includes(source.kind) || typeof source.id !== "string" ||
      !source.id || source.id.length > 4096 || source.id.includes("\\") ||
      Array.from(source.id).some(char => char.charCodeAt(0) < 32) || source.id.startsWith("/") ||
      source.id.split("/").some(part => !part || part === "." || part === "..") ||
      (source.kind === "session-archive" && !isSessionEvidenceId(source.id))) throw new Error("invalid evidence source scope");
  return createHash("sha256").update(JSON.stringify([source.kind, source.id])).digest("hex");
}
/** Internal runtime API; no raw paths or excerpts are persisted in the ledger. */
export function createEvidenceLifecycle(store: EvidenceStorage, options: { create?: boolean } = {}) {
  let failed = false, closed = false, revision = 0, epoch = 0;
  const observed = new Set<string>();
  const readers = new Set<{ keys: string[]; controller: AbortController; close: () => void }>();
  function poison() { failed = true; for (const reader of readers) reader.controller.abort(); }
  function read(snapshot?: Buffer): Ledger {
    if (failed || closed) throw new Error("evidence lifecycle unavailable");
    try {
      const bytes = snapshot ?? store.read("ledger.json", cap);
      if (!bytes) throw new Error("evidence ledger missing");
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid evidence ledger");
      const ledger = value as Ledger;
      if (!["revision,revoked,version", "clearing,epoch,revision,revoked,version"].includes(Object.keys(ledger).sort().join(",")) || ledger.version !== 1 ||
          !Number.isSafeInteger(ledger.revision) || ledger.revision < revision || !Array.isArray(ledger.revoked) ||
          ledger.revoked.length > 4096 || ledger.revoked.some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)) ||
          new Set(ledger.revoked).size !== ledger.revoked.length) throw new Error("invalid evidence ledger");
      if (Object.keys(ledger).length === 3) { ledger.epoch = 0; ledger.clearing = false; }
      if (!Number.isSafeInteger(ledger.epoch) || ledger.epoch < epoch || typeof ledger.clearing !== "boolean") throw new Error("evidence epoch rollback");
      if ([...observed].some(item => !ledger.revoked.includes(item))) throw new Error("evidence tombstone rollback");
      for (const item of ledger.revoked) observed.add(item);
      revision = ledger.revision; epoch = ledger.epoch; return ledger;
    } catch (error) { if (!(error instanceof EvidenceWriterBusyError)) poison(); throw error; }
  }
  store.withWriter(() => {
    let ledger = store.read("ledger.json", cap);
    const marker = store.read("ledger-initialized", 1);
    if (marker && marker.toString() !== "1") throw new Error("invalid ledger initialization marker");
    if (options.create === false && (!ledger || !marker)) throw new Error("evidence lifecycle initialization incomplete");
    if (!ledger) {
      if (marker) throw new Error("initialized evidence ledger missing");
      ledger = Buffer.from(JSON.stringify({ version: 1, revision: 0, revoked: [] }));
      store.writeAtomic("ledger.json", ledger);
    }
    // Validate existing bytes before repairing the marker; read-only callers never repair.
    read(ledger);
    if (!marker) store.writeAtomic("ledger-initialized", Buffer.from("1"));
  });
  const lifecycle = {
    currentEpoch() { const ledger = read(); if (ledger.clearing) throw new Error("evidence namespace clearing"); return ledger.epoch; },
    beginReaders(sources: readonly EvidenceSourceScope[], expectedEpoch?: number) {
      if (!Array.isArray(sources) || sources.length > 100000) throw new Error("invalid evidence reader scopes");
      const sourceKeys = [...new Set(sources.map(key))];
      const readerEpoch = expectedEpoch ?? lifecycle.currentEpoch();
      const check = () => { const ledger = read(); if (ledger.clearing || ledger.epoch !== readerEpoch) throw new Error("evidence namespace invalidated"); if (sourceKeys.some(k => ledger.revoked.includes(k))) throw new Error("evidence source revoked"); };
      check();
      const release = store.pinReaders();
      if (!release) throw new Error("evidence readers draining");
      const controller = new AbortController(); let ended = false;
      const entry = { keys: sourceKeys, controller, close: () => {
        if (!ended) { ended = true; readers.delete(entry); controller.abort(); release(); }
      } };
      try { check(); readers.add(entry); } catch (error) { entry.close(); throw error; }
      return Object.freeze({
        signal: controller.signal,
        checkpoint() { if (ended || controller.signal.aborted) throw new Error("evidence reader closed"); check(); },
        /** Writer lease serializes the final synchronous handoff with revocation. */
        deliver<T>(handoff: () => T): T {
          if (ended || controller.signal.aborted) throw new Error("evidence reader cancelled");
          if (Object.prototype.toString.call(handoff) === "[object AsyncFunction]") throw new Error("evidence handoff must be synchronous");
          try {
            return store.withWriter(() => {
              check();
              const result = handoff();
              if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("evidence handoff must be synchronous");
              return result;
            });
          } catch (error) { controller.abort(); throw error; }
        },
        close: entry.close,
      });
    },
    beginReader(source: EvidenceSourceScope) { return lifecycle.beginReaders([source]); },
    async revokeAndDrain(source: EvidenceSourceScope, timeoutMs = 5000): Promise<void> {
      const sourceKey = key(source);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("invalid evidence drain deadline");
      try {
        store.withWriter(() => {
          const ledger = read();
          if (!ledger.revoked.includes(sourceKey)) {
            if (ledger.revoked.length >= 4096 || ledger.revision === Number.MAX_SAFE_INTEGER) throw new Error("evidence ledger capacity exceeded");
            const next = { ...ledger, revision: ledger.revision + 1, revoked: [...ledger.revoked, sourceKey] };
            const bytes = Buffer.from(JSON.stringify(next));
            if (bytes.length > cap) throw new Error("evidence ledger byte capacity exceeded");
            store.writeAtomic("ledger.json", bytes); revision = next.revision; observed.add(sourceKey);
          }
        });
      } catch (error) { if (!(error instanceof EvidenceWriterBusyError)) poison(); throw error; }
      // P1 conservatively drops the whole derived namespace; P2 may collect selectively.
      await lifecycle.clearDerived(timeoutMs);
    },
    /** Opportunistic post-reindex GC. Pins across processes defer deletion without invalidating readers. */
    collectSuperseded(): "collected" | "deferred" {
      const release = store.pinReaders(true);
      if (!release) return "deferred";
      try {
        return store.withWriter(() => {
          const ledger = read();
          if (ledger.clearing) throw new Error("evidence namespace clearing");
          const current = store.read("CURRENT", 4096);
          if (!current) throw new Error("evidence CURRENT missing during collection");
          const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(current));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid evidence CURRENT");
          const pointer = value as { schemaVersion: number; generation: string; sha256: string };
          if (Object.keys(pointer).sort().join(",") !== "generation,schemaVersion,sha256" || pointer.schemaVersion !== 1 ||
              typeof pointer.generation !== "string" || !/^gen-[a-f0-9]{64}\.json$/.test(pointer.generation) ||
              typeof pointer.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pointer.sha256)) throw new Error("invalid evidence CURRENT");
          const bytes = store.read(pointer.generation, 256 * 1024 * 1024);
          if (!bytes || createHash("sha256").update(bytes).digest("hex") !== pointer.sha256) throw new Error("evidence active generation corrupt");
          store.purgeDerived(10000, pointer.generation);
          return "collected";
        });
      } finally { release(); }
    },
    async clearDerived(timeoutMs = 5000, shouldClear: () => boolean = () => true): Promise<boolean> {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("invalid evidence drain deadline");
      const deadline = performance.now() + timeoutMs;
      let clearingEpoch = 0;
      try {
        const selected = store.withWriter(() => {
          const ledger = read();
          // Decide against the latest CURRENT while publication is excluded.
          const decision = shouldClear();
          if (decision === false) return false;
          if (decision !== true) throw new Error("invalid evidence clear decision");
          if (ledger.revision >= Number.MAX_SAFE_INTEGER - 1 || ledger.epoch === Number.MAX_SAFE_INTEGER) throw new Error("evidence ledger capacity exceeded");
          clearingEpoch = ledger.epoch + 1;
          store.writeAtomic("ledger.json", Buffer.from(JSON.stringify({ ...ledger, revision: ledger.revision + 1, epoch: clearingEpoch, clearing: true })));
          epoch = clearingEpoch; revision = ledger.revision + 1;
          store.remove("CURRENT");
          return true;
        });
        if (!selected) return false;
      } catch (error) { if (!(error instanceof EvidenceWriterBusyError)) poison(); throw error; }
      for (const reader of readers) reader.controller.abort();
      while (true) {
        const ledger = read();
        if (ledger.epoch !== clearingEpoch || !ledger.clearing) throw new Error("evidence clear superseded");
        const release = store.pinReaders(true);
        if (release) {
          try {
            store.withWriter(() => {
              const current = read();
              if (current.epoch !== clearingEpoch || !current.clearing) throw new Error("evidence clear superseded");
              store.purgeDerived();
              if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("evidence ledger capacity exceeded");
              store.writeAtomic("ledger.json", Buffer.from(JSON.stringify({ ...current, revision: current.revision + 1, clearing: false })));
              revision = current.revision + 1;
            });
            return true;
          } finally { release(); }
        }
        if (performance.now() >= deadline) throw new Error("evidence reader drain timed out; invalidation retained");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    close() { if (!closed) { for (const reader of [...readers]) reader.close(); closed = true; } },
  };
  const sessionOwner = createSessionEvidenceOwner({
    projectRoot: store.projectRoot,
    revokeAndDrain: scope => lifecycle.revokeAndDrain({ kind: scope.sourceKind, id: scope.sessionId }),
  });
  return Object.freeze({ ...lifecycle, sessionOwner });
}
