// ACP session registry (flow 285, T8): maps an ACP `sessionId` to the keryx
// session + turn state it drives.
//
// F-6 (context.md §5): ACP's `cwd` is what the CLIENT asked for; keryx
// resolves a project root above it (`resolveProjectRoot`, git toplevel walk).
// Both are kept here, honestly, rather than reporting the requested cwd back
// as if it were what the session actually bound to — a later `session/list`
// (T10+) must report the RESOLVED root, matching what `listSessions()` will
// actually enumerate, and a caller that wants to explain the difference to an
// operator needs `requestedCwd` too.

import type { NormalizedMessage } from "../harness/provider/types";
import { listSessions, resolveProjectRoot, TranscriptUnreadableError, type SessionHandle } from "../session";
import { openLeasedSession, releaseSessionLease, type SessionLeaseHandle } from "../session/lease";
import type { AcpClientCapabilities } from "./protocol";

/**
 * Flow 387 review r2 F-021: the append-only archive of a session's original messages and
 * the cursor into the live history that has been copied so far. A shared object (not two
 * fields) because `updateHandle` copies the state with a spread; the cursor must survive it.
 * The cursor is re-pointed at the end of the history whenever the history is shortened in
 * place (overflow compaction), so a shrink never makes later messages look already copied.
 */
export interface AcpArchiveCursor {
  readonly messages: NormalizedMessage[];
  next: number;
}

/** Copies every history message past the cursor into the archive and advances the cursor. */
export function syncAcpArchive(cursor: AcpArchiveCursor, history: readonly NormalizedMessage[]): void {
  while (cursor.next < history.length) {
    const message = history[cursor.next];
    if (message !== undefined) {
      cursor.messages.push(message);
    }
    cursor.next += 1;
  }
}

export interface AcpSessionState {
  /** The ACP `sessionId` — identical to `handle.summary.id` (keryx's own session id). */
  readonly sessionId: string;
  /** The `cwd` the client sent in `session/new`, unmodified. */
  readonly requestedCwd: string;
  /** `resolveProjectRoot(requestedCwd)` — what the keryx session is actually bound to. */
  readonly resolvedRoot: string;
  readonly handle: SessionHandle;
  /**
   * Mutated in place by `runAgentTurn` across the session's whole lifetime —
   * same array reference on every `session/prompt`, mirroring how
   * `commands/shell.ts` threads its own `history` across turns.
   */
  readonly history: NormalizedMessage[];
  /** Flow 387 review r2 F-021: the originals, kept next to `history` (see {@link AcpArchiveCursor}). */
  readonly archive: AcpArchiveCursor;
  /**
   * The capabilities the client advertised on `initialize`, snapshotted at
   * session-creation time. T9-T13 branch on `fs`/`terminal` here (AC6): "with
   * `fs` advertised, file reads/writes go through `fs/read_text_file` /
   * `fs/write_text_file`; without it, the harness uses its own tools." Read by
   * `buildAcpSessionTools` (roster.ts) to decide whether read_file goes through
   * `fs/read_text_file`.
   */
  readonly clientCapabilities: AcpClientCapabilities | undefined;
  /**
   * Set by `load()` only: the provider/model the durable session last ran, as
   * its summary recorded it BEFORE this load reopened it (flow 288, T14) — so
   * a restarted agent can continue the session on it.
   */
  readonly recordedModel?: { readonly providerId: string; readonly modelId: string };
  /**
   * The session lease this connection holds (agent bus D-07), taken the same
   * way `keryx shell` takes it, so ACP and a live shell never both write one
   * transcript. Released by `releaseAll()` when the connection ends.
   */
  readonly lease: SessionLeaseHandle;
}

/**
 * `load()`'s durable session exists (it is in `listSessions()`) but its
 * transcript could not be read — `openSession` -> `loadContext` raised
 * `TranscriptUnreadableError` rather than reading back an empty conversation
 * (flow 130, `session/store.ts`). Kept distinct from `load()` returning
 * `undefined` ("no such session") so `handleSessionLoad` can answer the ACP
 * client with a specific, actionable JSON-RPC error naming the file and
 * reason, instead of the dispatcher's generic `internalError` fallback or —
 * worse — a `session/load` that silently reports a session with no messages.
 */
export class AcpSessionTranscriptUnreadableError extends Error {
  constructor(
    readonly sessionId: string,
    override readonly cause: TranscriptUnreadableError,
  ) {
    super(`session ${sessionId}: ${cause.message}`);
    this.name = "AcpSessionTranscriptUnreadableError";
  }
}

export interface AcpSessionRegistryOptions {
  readonly providerId: string;
  readonly modelId: string;
  readonly dataDir?: string;
}

/**
 * In-memory sessions for one `keryx acp` connection (one process, per the ACP
 * transport contract — a client launches a fresh agent subprocess per
 * connection). Session PERSISTENCE is `../session/store.ts`'s durable
 * per-project store, created via `createSession`/`persistHistory`; this
 * registry only remembers which durable session a live ACP `sessionId` maps
 * to for the lifetime of this process.
 */
export class AcpSessionRegistry {
  private readonly sessions = new Map<string, AcpSessionState>();

  constructor(private readonly options: AcpSessionRegistryOptions) {}

  /** Creates a new durable keryx session bound to `resolveProjectRoot(cwd)`, leases it and registers it. */
  create(cwd: string, clientCapabilities: AcpClientCapabilities | undefined): AcpSessionState {
    const resolvedRoot = resolveProjectRoot(cwd);
    // No resumeId: `openLeasedSession` creates the session (`createSession`) and leases it.
    const { handle, lease } = openLeasedSession({
      cwd: resolvedRoot,
      provider: this.options.providerId,
      model: this.options.modelId,
      ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
    });
    const state: AcpSessionState = {
      sessionId: handle.summary.id,
      requestedCwd: cwd,
      resolvedRoot,
      handle,
      history: [],
      archive: { messages: [], next: 0 },
      clientCapabilities,
      lease,
    };
    this.sessions.set(state.sessionId, state);
    return state;
  }

  get(sessionId: string): AcpSessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Loads an EXISTING durable session (flow 285, T10 — AC5): one created by
   * `session/new` earlier this connection, by an earlier `keryx acp`
   * connection, or by `keryx shell`/`keryx sessions` — the store is the same
   * one either way (`../session/store.ts`).
   *
   * `undefined` means no session with this id exists FOR THIS PROJECT.
   * `listSessions(cwd, ...)` is already project-isolated by construction (it
   * filters by `resolveProjectRoot(cwd)` internally, matching `summary.
   * projectPath` — F-6/F-7 of the flow's context.md): a session id that is
   * real but belongs to a different project is reported exactly the same as
   * one that does not exist at all, never loaded across the project boundary.
   *
   * A session another keryx instance holds (a live `keryx shell`) throws
   * `SessionLeasedError` before its transcript is read, rather than letting two
   * surfaces overwrite each other's turns.
   */
  load(sessionId: string, cwd: string, clientCapabilities: AcpClientCapabilities | undefined): AcpSessionState | undefined {
    const resolvedRoot = resolveProjectRoot(cwd);
    const summary = listSessions(cwd, this.options.dataDir).find((entry) => entry.id === sessionId);
    if (summary === undefined) {
      return undefined;
    }
    // Read before the open, which records this connection's launch model.
    const recordedModel =
      typeof summary.provider === "string" && summary.provider.length > 0 && typeof summary.model === "string" && summary.model.length > 0
        ? { providerId: summary.provider, modelId: summary.model }
        : undefined;
    let opened: ReturnType<typeof openLeasedSession>;
    try {
      opened = openLeasedSession({
        cwd,
        resumeId: sessionId,
        // An ACP client has no `--take-over` to pass, and a crashed shell's
        // lease would lock the session out of the editor for good. Only a STALE
        // holder (D-09: no heartbeat, or a dead pid) is reclaimed; a live one
        // is still refused.
        takeOver: true,
        ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
        provider: this.options.providerId,
        model: this.options.modelId,
      });
    } catch (cause) {
      // `openSession` -> `loadContext` throws rather than returning `[]` for a
      // transcript it cannot read (session/store.ts). Rethrown as a distinct,
      // ACP-domain type so `handleSessionLoad` can tell "unreadable" apart
      // from "unknown session" and answer with a specific error instead of
      // resuming into a history that looks empty.
      if (cause instanceof TranscriptUnreadableError) {
        throw new AcpSessionTranscriptUnreadableError(sessionId, cause);
      }
      throw cause;
    }
    const state: AcpSessionState = {
      sessionId: opened.handle.summary.id,
      requestedCwd: cwd,
      resolvedRoot,
      handle: opened.handle,
      // Mutated in place by `runAgentTurn` from here on, same contract as
      // `create()` — a loaded session's later `session/prompt` calls continue
      // this exact array, not a fresh empty one.
      history: opened.history,
      // Flow 387 review r2 F-021: seed from the stored archive, like shell.ts and tui-shell.ts.
      // Seeding from the context would rewrite archive.jsonl with a compacted/pruned history on
      // the first prompt. Only an empty archive (pre-archive session) falls back to the context.
      archive: {
        messages: opened.archive.length > 0 ? [...opened.archive] : [...opened.history],
        next: opened.history.length,
      },
      clientCapabilities,
      ...(recordedModel !== undefined ? { recordedModel } : {}),
      lease: opened.lease,
    };
    this.sessions.set(state.sessionId, state);
    return state;
  }

  /**
   * False once another instance took this session's lease over: the turn must
   * not be persisted. Checks the disk, so a take-over since the last heartbeat
   * is caught at the write (lease.ts `checkLost`).
   */
  canPersist(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    return state !== undefined && !state.lease.checkLost();
  }

  /** Releases every session lease this connection holds. Idempotent. */
  releaseAll(): void {
    for (const state of this.sessions.values()) {
      releaseSessionLease(state.lease);
    }
  }

  /** Replaces the stored handle (e.g. after a `persistHistory` call returns an updated one). */
  updateHandle(sessionId: string, handle: SessionHandle): void {
    const state = this.sessions.get(sessionId);
    if (state === undefined) {
      return;
    }
    this.sessions.set(sessionId, { ...state, handle });
  }
}
