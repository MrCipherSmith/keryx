// Offline Desktop cache of public child events. The parent transcript remains the source for recorded returns.
import { redactDisplayText } from "../../../../src/security/display-redaction";
import { isActiveSubagent, sortSubagents, type Subagent, type SubagentEntry } from "./activity";

const MAX_CHILDREN = 256;
const MAX_SESSIONS = 100;
const MAX_LOG_CHARS = 16384;
const OMITTED = "Earlier activity omitted";
const snapshots = new WeakMap<Subagent, Subagent>();

function publicEntry(agent: Subagent, entry: SubagentEntry): SubagentEntry | undefined {
  if (entry.kind === "text" || (entry.kind === "result" && (entry.returned || agent.runtime === "external"))) {
    if (agent.runtime === "external" && entry.kind === "result" && entry.text.startsWith("failed: ")) {
      return { kind: "system", text: "External agent failed" };
    }
    return { ...entry, text: redactDisplayText(entry.text).slice(0, entry.kind === "result" ? 9000 : 2000) };
  }
  if (entry.kind === "system" && (entry.text === "Tool failed" || entry.text === "Tool finished" || entry.text === "External agent failed" || entry.text === OMITTED)) return { ...entry };
  if (entry.kind === "tool") {
    const name = /^([a-zA-Z][\w.-]{0,80})(?::|$)/.exec(entry.text)?.[1];
    if (name) return { kind: "tool", text: name };
  }
  if (entry.kind === "result") {
    return { kind: "system", text: /^[\w.-]+ \(error\)(?: |$)/.test(entry.text) ? "Tool failed" : "Tool finished" };
  }
  return;
}

export function archivedChild(agent: Subagent): Subagent {
  const cached = snapshots.get(agent);
  if (cached) return cached;
  const entries: SubagentEntry[] = [];
  let chars = 0;
  let i = agent.entries.length - 1;
  let trimmed = agent.entriesTruncated === true;
  for (; i >= 0 && entries.length < 99 && chars < MAX_LOG_CHARS; i--) {
    const entry = publicEntry(agent, agent.entries[i]!);
    if (!entry) continue;
    if (entry.text.length > MAX_LOG_CHARS - chars) trimmed = true;
    entry.text = entry.text.slice(0, MAX_LOG_CHARS - chars);
    chars += entry.text.length;
    entries.push(entry);
  }
  if ((i >= 0 || trimmed) && entries.at(-1)?.text !== OMITTED) entries.push({ kind: "system", text: OMITTED });
  const snapshot: Subagent = {
    id: agent.id, label: redactDisplayText(agent.label).slice(0, 180), entries: entries.reverse(),
    status: isActiveSubagent(agent) ? "unknown" : agent.status,
    turn: agent.turn, startedAt: agent.startedAt, parentToolCallId: agent.parentToolCallId,
    model: agent.model?.slice(0, 180), runtime: agent.runtime, agentId: agent.agentId,
  };
  snapshots.set(agent, snapshot);
  snapshots.set(snapshot, snapshot);
  return snapshot;
}

let opening: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("keryx-subagent-history", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("sessions", { keyPath: ["project", "session"] }).createIndex("updated", "updated");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch(error => { opening = undefined; throw error; });
  }
  return opening;
}

interface Recovery {
  updated: number;
  children: Subagent[];
}

function recoveryKey(project: string, session: string) {
  return "keryx.subagent-recovery." + JSON.stringify([project, session]);
}

function readRecovery(key: string): Recovery | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as Recovery | null;
    if (value && Number.isFinite(value.updated) && Array.isArray(value.children)) return value;
  } catch { /* Restricted webviews can disable localStorage. */ }
  return undefined;
}

function clearRecovery(key: string, expected: number | undefined) {
  if (expected === undefined || readRecovery(key)?.updated !== expected) return;
  try { localStorage.removeItem(key); } catch { /* Best effort on shutdown. */ }
}

function writeRecovery(project: string, session: string, changes: readonly Subagent[]) {
  const key = recoveryKey(project, session);
  const children = new Map(readRecovery(key)?.children.map(child => [child.id, child]));
  for (const row of changes) children.set(row.id, archivedChild(row));
  // A closing window has synchronous storage only. Keep the most recent public tails under quota.
  const latest = sortSubagents([...children.values()]).slice(0, MAX_CHILDREN);
  function persist(budget: number) {
    const kept = latest.map(row => {
      const entries: SubagentEntry[] = [];
      for (let i = row.entries.length - 1; i >= 0; i--) {
        const entry = row.entries[i]!;
        if (entry.text.length + 64 > budget) {
          entries.push({ kind: "system", text: OMITTED });
          break;
        }
        budget -= entry.text.length + 64;
        entries.push(entry);
      }
      return { ...row, entries: entries.reverse() };
    });
    localStorage.setItem(key, JSON.stringify({ updated: Date.now(), children: kept }));
  }
  try { persist(128 * 1024); } catch {
    try { persist(8192); } catch { /* The committed IndexedDB history remains available. */ }
  }
}

/** A small shutdown tail supplements a committed log. Retain older evidence and mark any gap. */
export function recoverChild(saved: Subagent | undefined, tail: Subagent): Subagent {
  if (!saved?.entries.length || tail.entries[0]?.text !== OMITTED) return tail;
  const incoming = tail.entries.slice(1);
  let overlap = Math.min(incoming.length, saved.entries.length);
  while (overlap > 0 && !incoming.slice(0, overlap).every((entry, i) => {
    const other = saved.entries[saved.entries.length - overlap + i]!;
    return entry.kind === other.kind && entry.text === other.text;
  })) overlap--;
  return archivedChild({ ...tail, entries: [
    ...saved.entries, ...(overlap ? [] : [{ kind: "system", text: OMITTED }]), ...incoming.slice(overlap),
  ] });
}

export async function readSubagentHistory(project: string, session: string): Promise<readonly Subagent[]> {
  const key = recoveryKey(project, session);
  const recovery = readRecovery(key);
  try {
    const db = await database();
    const saved = await new Promise<Recovery | undefined>((resolve, reject) => {
      const req = db.transaction("sessions").objectStore("sessions").get([project, session]);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = saved?.children ?? [];
    if (!recovery) return rows;
    if (saved && saved.updated > recovery.updated) {
      clearRecovery(key, recovery.updated);
      return rows;
    }
    // Overlay only the uncommitted children, keeping the rest of the older durable parent.
    const merged = new Map(rows.map(row => [row.id, row]));
    for (const row of recovery.children) merged.set(row.id, recoverChild(merged.get(row.id), row));
    const result = [...merged.values()];
    await writeSubagentHistory(project, session, result);
    return result;
  } catch { return recovery?.children ?? []; }
}

export async function writeSubagentHistory(project: string, session: string, children: readonly Subagent[]): Promise<boolean> {
  const key = recoveryKey(project, session);
  const updated = Date.now();
  const existing = readRecovery(key)?.updated;
  try {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
      const store = tx.objectStore("sessions");
      if (!children.length) { store.delete([project, session]); return; }
      const keep = new Set(sortSubagents(children).slice(0, MAX_CHILDREN));
      store.put({ project, session, updated, children: children.filter(child => keep.has(child)).map(archivedChild) });
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_SESSIONS;
        if (excess <= 0) return;
        const oldest = store.index("updated").openCursor();
        oldest.onsuccess = () => {
          const cursor = oldest.result;
          if (!cursor || excess-- <= 0) return;
          cursor.delete();
          cursor.continue();
        };
      };
    });
    clearRecovery(key, existing);
    return true;
  } catch { return false; }
}

/** A background session may continue streaming while another tab is selected. */
export function subagentHistoryWriter(project: string) {
  const pending = new Map<string, readonly Subagent[]>();
  const seen = new Map<string, readonly Subagent[]>();
  const acknowledged = new Map<string, ReadonlySet<Subagent>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function flush(event?: Event) {
    clearTimeout(timer);
    timer = undefined;
    if (event?.type === "pagehide") {
      for (const [session, children] of seen) {
        const durable = acknowledged.get(session);
        const changes = children.filter(child => !durable?.has(child));
        if (changes.length) writeRecovery(project, session, changes);
      }
    }
    const writes = [...pending].map(async ([session, children]) => {
      if (await writeSubagentHistory(project, session, children)) acknowledged.set(session, new Set(children));
    });
    pending.clear();
    await Promise.all(writes);
  }
  return {
    track(session: string, children: readonly Subagent[]) {
      if (seen.get(session) === children || !children.length) return;
      seen.set(session, children);
      pending.set(session, children);
      timer ??= setTimeout(flush, 500);
    },
    remove(session: string) {
      acknowledged.delete(session);
      seen.delete(session);
      pending.delete(session);
      void writeSubagentHistory(project, session, []);
    },
    flush,
  };
}
