import { describe, expect, it } from 'vitest';
import { decodeRevisionFile, mergeEvents, parseRevisionChanges, safeExternalUrl } from '../src/features/context-model';

describe('revision text input', () => {
  it('preserves UTF-8 content, executable mode and deletion payloads', () => {
    const changes = parseRevisionChanges(JSON.stringify([{ path: 'src/hello.ts', content: 'Привет 🌍', mode: '100755' }, { path: 'old.txt', deleted: true }]));
    expect(changes[0]?.mode).toBe('100755');
    expect(new TextDecoder().decode(Uint8Array.from(atob(changes[0]!.contentBase64!), c => c.charCodeAt(0)))).toBe('Привет 🌍');
    expect(changes[1]).toEqual({ path: 'old.txt', deleted: true });
  });
  it('accepts empty text content and defaults a regular file mode', () => {
    expect(parseRevisionChanges('[{"path":"empty.txt","content":""}]')).toEqual([{ path: 'empty.txt', contentBase64: '', mode: '100644' }]);
  });
  it('rejects malformed shapes, duplicates, unsafe paths and unsupported modes', () => {
    for (const input of ['{}', '[null]', '[{"path":"../escape","content":"x"}]', '[{"path":".git/config","content":"x"}]', '[{"path":"x","content":"a","mode":"120000"}]', '[{"path":"x","content":"a"},{"path":"x","deleted":true}]']) {
      expect(() => parseRevisionChanges(input)).toThrow();
    }
  });
});

describe('untrusted revision previews', () => {
  it('returns source as text without turning markup into HTML', () => {
    expect(decodeRevisionFile(btoa('<script>alert(1)</script>'))).toMatchObject({ kind: 'text', text: '<script>alert(1)</script>', truncated: false });
  });
  it('does not interpret invalid UTF-8 or NUL bytes as text', () => {
    expect(decodeRevisionFile(btoa('\0binary'))).toMatchObject({ kind: 'binary' });
    expect(decodeRevisionFile('/w==')).toMatchObject({ kind: 'binary' });
  });
  it('rejects unsafe external navigation schemes and credentials', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeExternalUrl('https://user:secret@example.com')).toBeUndefined();
    expect(safeExternalUrl('https://github.com/org/repo/pull/1')).toBe('https://github.com/org/repo/pull/1');
  });
});

it('merges cursor pages by immutable event sequence without duplication', () => {
  const event = (sequence: number) => ({ sequence, projectId: 'p', type: 'revision-created', actorId: 'agent:connector', entityId: 'r', createdAt: '2026-10-26T00:00:00Z' });
  expect(mergeEvents([[event(1), event(2)], [event(2), event(3)]]).map(item => item.sequence)).toEqual([3, 2, 1]);
});
