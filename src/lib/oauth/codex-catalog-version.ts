import { join } from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "../config-dir";

export const CODEX_VERSION_REGISTRY_URL = "https://registry.npmjs.org/@openai%2Fcodex/latest";
export const CODEX_VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const CACHE_FILE = "codex-catalog-version.json";
const RESPONSE_LIMIT_BYTES = 64 * 1024;

interface VersionCache { version: string; fetchedAt: number }

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

function loadCache(file: string, now: number): VersionCache | undefined {
  try {
    const content = readConfigFile(file);
    if (!content.ok) return undefined;
    const cache: unknown = JSON.parse(content.text);
    if (typeof cache !== "object" || cache === null) return undefined;
    const record = cache as Record<string, unknown>;
    if (!validVersion(record.version) || typeof record.fetchedAt !== "number"
      || !Number.isFinite(record.fetchedAt) || record.fetchedAt < 0 || record.fetchedAt > now) return undefined;
    return { version: record.version, fetchedAt: record.fetchedAt };
  } catch { return undefined; }
}

async function readMetadata(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > RESPONSE_LIMIT_BYTES) return undefined;
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

/** OAuth returns credentials, not a catalog version. Discover the official stable
 * Codex release without installing it or sending subscription credentials to npm.
 * Revalidate daily; an unavailable registry can use the last discovered version.
 * Without a discovered version, fail explicitly rather than guessing one. */
export async function resolveCodexCatalogVersion(
  fetchFn: typeof fetch,
  opts: { configDir?: string; signal?: AbortSignal; now?: () => number; forceRefresh?: boolean } = {},
): Promise<string | undefined> {
  if (opts.signal?.aborted) return undefined;
  const now = (opts.now ?? Date.now)();
  const file = join(keryxConfigDir(opts.configDir), CACHE_FILE);
  const cached = loadCache(file, now);
  if (!opts.forceRefresh && cached !== undefined && now - cached.fetchedAt < CODEX_VERSION_CACHE_TTL_MS) return cached.version;
  try {
    const timeout = AbortSignal.timeout(2_000);
    const response = await fetchFn(CODEX_VERSION_REGISTRY_URL, {
      headers: { Accept: "application/json" }, credentials: "omit", redirect: "error",
      signal: opts.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]),
    });
    if (response.ok) {
      const body = await readMetadata(response);
      if (typeof body === "object" && body !== null && "name" in body && body.name === "@openai/codex"
        && "version" in body && validVersion(body.version) && !opts.signal?.aborted) {
        const version = body.version;
        try {
          ensureKeryxConfigDir(opts.configDir);
          writeOwnerOnlyFileAtomic(file, JSON.stringify({ version, fetchedAt: now }));
        } catch { /* Cache persistence must not discard a valid live result. */ }
        return version;
      }
    }
  } catch { /* Never expose remote bodies or transport errors. */ }
  return opts.signal?.aborted ? undefined : cached?.version;
}
