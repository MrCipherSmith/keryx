import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "./config-dir";

export interface StoredSearchProvider {
  fields: Record<string, string>;
  status: "connected" | "disconnected";
  lastTestedAt?: string;
}

export interface SearchConfig {
  activeProviderId?: string;
  providers?: Record<string, StoredSearchProvider>;
}

interface SearchCredentialStore {
  schemaVersion: 1;
  credentials: Record<string, string>;
}

export function searchConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "search-providers.json");
}

export function searchCredentialPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "search-credentials.json");
}

function readJson(file: string): unknown | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const read = readConfigFile(file);
    return read.ok ? JSON.parse(read.text) : undefined;
  } catch {
    return undefined;
  }
}

export function loadSearchConfig(dir?: string): SearchConfig {
  const value = readJson(searchConfigPath(dir));
  return value !== null && typeof value === "object" ? value as SearchConfig : {};
}

export function saveSearchConfig(patch: SearchConfig, dir?: string): void {
  try {
    ensureKeryxConfigDir(dir);
    const current = loadSearchConfig(dir);
    writeOwnerOnlyFile(searchConfigPath(dir), `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
  } catch {
    // Configuration is best effort; callers surface connection failures separately.
  }
}

function loadCredentialStore(dir?: string): SearchCredentialStore {
  const value = readJson(searchCredentialPath(dir));
  if (value === null || typeof value !== "object") return { schemaVersion: 1, credentials: {} };
  const record = value as Partial<SearchCredentialStore>;
  return record.schemaVersion === 1 && record.credentials && typeof record.credentials === "object"
    ? { schemaVersion: 1, credentials: record.credentials as Record<string, string> }
    : { schemaVersion: 1, credentials: {} };
}

/** Read only at the adapter-to-transport boundary; never expose this in TUI state or logs. */
export function readSearchCredential(providerId: string, dir?: string): string | undefined {
  const value = loadCredentialStore(dir).credentials[providerId];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function saveSearchCredential(providerId: string, credential: string, dir?: string): void {
  try {
    ensureKeryxConfigDir(dir);
    const store = loadCredentialStore(dir);
    writeOwnerOnlyFile(searchCredentialPath(dir), `${JSON.stringify({ schemaVersion: 1, credentials: { ...store.credentials, [providerId]: credential } }, null, 2)}\n`);
  } catch {
    // Never throw a credential value into a caller-visible error.
  }
}
