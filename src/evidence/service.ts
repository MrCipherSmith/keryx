import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { ArchiveCursorAccess } from "./archive-cursor";
import { readDescriptorChainAsync, type DescriptorIdentity } from "../lib/descriptor-read";
import { parseEvidenceConfig } from "./config";
import { createEvidenceScanner, readEvidenceArchive, readEvidenceFile, type EvidenceScanner } from "./sources";
export type { EvidenceDiagnostic, EvidenceItem, EvidenceLocator, EvidenceSearchResult } from "./types";
export { parseEvidenceConfig } from "./config";
export interface EvidenceServiceOptions {
  projectRoot: string; config?: unknown; dataDir?: string;
  scannerFactory?: (projectRoot: string, signal?: AbortSignal) => Promise<EvidenceScanner | undefined>;
}
/** Runtime-only constructor. Tool input must never be spread into these options. */
export async function createEvidenceService(options: EvidenceServiceOptions) {
  const parsed = parseEvidenceConfig(options.config);
  if (!parsed.ok) return parsed;
  const config = parsed.config, projectRoot = options.projectRoot, dataDir = options.dataDir;
  const factory = options.scannerFactory ?? createEvidenceScanner;
  const disabled = () => ({ code: "disabled" as const, diagnostics: ["disabled"] });
  const unavailable = () => ({ code: "source-unavailable" as const, diagnostics: ["source-unreadable"] });
  // Disabled construction performs no realpath, source read, scanner or network work.
  let canonical: string | undefined;
  let identity: DescriptorIdentity | undefined;
  if (config.enabled) {
    try { canonical = await realpath(projectRoot); identity = await lstat(canonical); } catch { return { ok: false as const, diagnostics: ["source-unreadable"] }; }
  }
  const scope = canonical ?? projectRoot;
  const timeout = () => ({ code: "timeout" as const, diagnostics: ["query-timeout"] });
  async function operate(kind: "file" | "archive", locator: string, signal?: AbortSignal, cursorAccess?: ArchiveCursorAccess) {
    if (!config.enabled) return disabled();
    if (kind === "archive" && !config.sessionArchives) return { code: "source-unavailable" as const, diagnostics: ["source-denied"] };
    if (signal?.aborted) return timeout();
    const controller = new AbortController(), deadline = performance.now() + config.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<ReturnType<typeof timeout>>(resolve => {
      onAbort = () => { resolve(timeout()); controller.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onAbort, config.timeoutMs);
    });
    const work = async () => {
      try {
        const current = await lstat(scope);
        if (!identity || current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink()) return unavailable();
        if (controller.signal.aborted) return timeout();
        const scan = await factory(scope, controller.signal);
        if (controller.signal.aborted || performance.now() >= deadline) return timeout();
        if (!scan) return unavailable();
        const common = { projectRoot: scope, expectedRootIdentity: identity, maxSourceBytes: config.maxSourceBytes,
          timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maxRecords: config.maxChunks,
          scanner: scan, signal: controller.signal };
        return kind === "file" ? await readEvidenceFile({ ...common, path: locator, roots: config.roots }) :
          await readEvidenceArchive({ ...common, sessionId: locator, sessionArchives: true, ...(cursorAccess ? { cursorAccess } : {}), ...(dataDir !== undefined ? { dataDir } : {}) });
      } catch { return unavailable(); }
    };
    try { return await Promise.race([work(), cancelled]); }
    finally { if (timer) clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); controller.abort(); }
  }
  const service = Object.freeze({
    readFile: (relativePath: string, signal?: AbortSignal) => operate("file", relativePath, signal),
    readArchive: (sessionId: string, signal?: AbortSignal, cursorAccess?: ArchiveCursorAccess) => operate("archive", sessionId, signal, cursorAccess),
  });
  return { ok: true as const, service };
}
/** Explicit configuration I/O only; absent means disabled, unreadable is not absent. */
export async function loadEvidenceConfig(projectRoot: string) {
  const target = path.join(projectRoot, ".metaproject/evidence.json");
  let identity;
  try { identity = await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseEvidenceConfig(undefined);
    return { ok: false as const, diagnostics: ["invalid-config"] };
  }
  try {
    const bytes = await readDescriptorChainAsync(projectRoot, target, { maxBytes: 65536, requireRegularFile: true, expectedTargetIdentity: identity });
    return parseEvidenceConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { return { ok: false as const, diagnostics: ["invalid-config"] }; }
}

export async function loadEvidenceService(options: Omit<EvidenceServiceOptions, "config">) {
  const captured = { ...options };
  const loaded = await loadEvidenceConfig(captured.projectRoot);
  if (!loaded.ok) return loaded;
  return createEvidenceService({ ...captured, config: loaded.config });
}
