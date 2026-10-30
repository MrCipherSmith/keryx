import type { HubEvent, RevisionChange } from '../api/types';

/** The form accepts text changes only; binary snapshots remain a CLI workflow. */
export function parseRevisionChanges(input: string): RevisionChange[] {
  const value: unknown = JSON.parse(input);
  if (!Array.isArray(value) || value.length > 5000) throw new Error('invalid-changes');
  const seen = new Set<string>();
  return value.map((raw: unknown): RevisionChange => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-changes');
    const item = raw as Record<string, unknown>;
    const path = item.path;
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.startsWith('-') || path.includes('\\') || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || seen.has(path)) throw new Error('invalid-changes');
    seen.add(path);
    if (item.deleted === true) return { path, deleted: true };
    if (typeof item.content !== 'string' || (item.mode !== undefined && item.mode !== '100644' && item.mode !== '100755')) throw new Error('invalid-changes');
    const bytes = new TextEncoder().encode(item.content);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { path, contentBase64: btoa(binary), mode: item.mode === '100755' ? '100755' : '100644' };
  });
}

export function decodeRevisionFile(content: string): { kind: 'text'; text: string; truncated: boolean; size: number } | { kind: 'binary'; size: number } {
  try {
    const bytes = Uint8Array.from(atob(content), char => char.charCodeAt(0));
    if (bytes.some(byte => byte === 0)) return { kind: 'binary', size: bytes.length };
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { kind: 'text', text: text.slice(0, 128_000), truncated: text.length > 128_000, size: bytes.length };
  } catch { return { kind: 'binary', size: Math.floor(content.length * 3 / 4) }; }
}

export function safeExternalUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
  } catch { /* An invalid server-provided link is displayed only as text. */ }
}

export function mergeEvents(pages: HubEvent[][]): HubEvent[] {
  return [...new Map(pages.flat().map(event => [event.sequence, event])).values()].sort((a, b) => b.sequence - a.sequence);
}
