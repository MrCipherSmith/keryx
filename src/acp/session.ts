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
import { createSession, listSessions, openSession, resolveProjectRoot, type SessionHandle } from "../session";
import type { AcpClientCapabilities } from "./protocol";

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
  /**
   * The capabilities the client advertised on `initialize`, snapshotted at
   * session-creation time. T9-T13 branch on `fs`/`terminal` here (AC6): "with
   * `fs` advertised, file reads/writes go through `fs/read_text_file` /
   * `fs/write_text_file`; without it, the harness uses its own tools." T7/T8
   * only record it — nothing in this dispatch reads it yet.
   */
  readonly clientCapabilities: AcpClientCapabilities | undefined;
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

  /** Creates a new durable keryx session bound to `resolveProjectRoot(cwd)` and registers it. */
  create(cwd: string, clientCapabilities: AcpClientCapabilities | undefined): AcpSessionState {
    const resolvedRoot = resolveProjectRoot(cwd);
    const handle = createSession({
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
      clientCapabilities,
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
   */
  load(sessionId: string, cwd: string, clientCapabilities: AcpClientCapabilities | undefined): AcpSessionState | undefined {
    const resolvedRoot = resolveProjectRoot(cwd);
    const known = listSessions(cwd, this.options.dataDir).some((summary) => summary.id === sessionId);
    if (!known) {
      return undefined;
    }
    const opened = openSession({
      cwd,
      resumeId: sessionId,
      ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
      provider: this.options.providerId,
      model: this.options.modelId,
    });
    const state: AcpSessionState = {
      sessionId: opened.handle.summary.id,
      requestedCwd: cwd,
      resolvedRoot,
      handle: opened.handle,
      // Mutated in place by `runAgentTurn` from here on, same contract as
      // `create()` — a loaded session's later `session/prompt` calls continue
      // this exact array, not a fresh empty one.
      history: opened.history,
      clientCapabilities,
    };
    this.sessions.set(state.sessionId, state);
    return state;
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
