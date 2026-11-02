import { useMemo } from "react";
import { useDraft } from "./drafts";

const prefix = "keryx.pending.v1:";
const maxEntryBytes = 128 * 1024;
const maxTotalBytes = 512 * 1024;
const maxEntries = 8;
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export const pendingScope = (...parts: string[]) => JSON.stringify(parts);
type PendingState<T> = { value: T | null; error: boolean };

/** Only unresolved request envelopes belong here. Never credentials or ordinary drafts. */
export function readPending<T>(scope: string, valid: (v: unknown) => v is T): T | null {
  const raw = sessionStorage.getItem(prefix + scope);
  if (raw === null) return null;
  if (bytes(raw) > maxEntryBytes) throw new Error("pending-storage");
  const entry: unknown = JSON.parse(raw);
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).sort().join() !== "scope,value,version" ||
      !("version" in entry) || entry.version !== 1 ||
      !("scope" in entry) || entry.scope !== scope ||
      !("value" in entry) || !valid(entry.value)) throw new Error("pending-storage");
  return entry.value;
}
export function writePending<T>(scope: string, value: T | null, valid: (v: unknown) => v is T) {
  const key = prefix + scope;
  if (value === null) { sessionStorage.removeItem(key); return; }
  if (!valid(value)) throw new Error("pending-storage");
  const existing = readPending(scope, valid);
  if (existing !== null && typeof existing === "object" && "operationId" in existing &&
      typeof value === "object" && value !== null && "operationId" in value &&
      existing.operationId !== value.operationId) throw new Error("pending-storage");
  const raw = JSON.stringify({ version: 1, scope, value });
  let total = bytes(raw), count = 1;
  if (total > maxEntryBytes || scope.length > 2048) throw new Error("pending-storage");
  for (let n = 0; n < sessionStorage.length; n++) {
    const other = sessionStorage.key(n);
    if (other?.startsWith(prefix) && other !== key) {
      total += bytes(sessionStorage.getItem(other) ?? ""); count++;
    }
  }
  if (total > maxTotalBytes || count > maxEntries) throw new Error("pending-storage");
  sessionStorage.setItem(key, raw);
}
export function clearPending() {
  try {
    for (let n = sessionStorage.length - 1; n >= 0; n--) {
      const key = sessionStorage.key(n);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch { /* A blocked browser store is also blocked before every mutation. */ }
}

export function usePending<T>(scope: string, valid: (v: unknown) => v is T, recover: (v: T) => T, enabled = true) {
  const loaded = useMemo<PendingState<T>>(() => {
    if (!enabled) return { value: null, error: false };
    try { const value = readPending(scope, valid); return { value: value === null ? null : recover(value), error: false }; }
    catch { return { value: null, error: true }; }
    // Validators/recovery are pure; scope is the complete stable identity.
  }, [scope, enabled]);
  const [state, setState] = useDraft<PendingState<T>>("pending:" + scope, loaded);
  const put = (value: T | null) => {
    try {
      if (enabled) writePending(scope, value, valid);
      setState({ value, error: false }); return true;
    } catch { setState({ value: state.value, error: true }); return false; }
  };
  return { ...state, put };
}
