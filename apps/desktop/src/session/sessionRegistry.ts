import type { RoutedUpdate } from "./reducer";
import type { TelegramTurn } from "./telegramSession";

/** What switching to a session takes. */
export type SwitchPlan =
  /** The window holds it: show it, no request. */
  | "show"
  /** Its session/load is already in flight: show it when that finishes. */
  | "pending"
  /** The window does not hold it (history, or released by keryx): session/load. */
  | "load";

/**
 * The window's synchronous view of the sessions it holds on one connection: what the protocol code
 * decides by, while the reducer's copy is what is rendered. Pure, no React and no I/O.
 *
 * Every session the window holds stays alive in keryx; switching only changes which one is shown.
 */
export class SessionRegistry<Turn = unknown> {
  /** Sessions keryx holds for this connection. */
  readonly held = new Set<string>();
  /** Sessions whose session/load is in flight. */
  readonly loading = new Set<string>();
  /** The running prompt turn of each session that has one. */
  readonly turns = new Map<string, Turn>();
  readonly telegramTurns = new Map<string, TelegramTurn>();
  /** `_keryx/command` requests in flight per session: keryx may ask a question while one runs. */
  readonly commands = new Map<string, number>();
  /**
   * Sessions whose free turn slot a load's caller holds for a turn it starts itself (a review, after its mode
   * switch): the window sends them no Run results and no queued prompt until a turn takes the slot or the caller
   * gives up (useAcpSession `holdForCaller` / `releaseHold`). A later load of the session, its release and a new
   * connection end the hold too.
   */
  readonly heldForCaller = new Set<string>();
  /** session/new requests in flight. */
  creating = 0;
  /** The session on screen. Survives a reset, so a restart can reload it. */
  shown: string | null = null;

  private intent = 0;
  private readonly loadIntents = new Map<string, { intent: number; scope?: AbortSignal }>();
  private orphans: RoutedUpdate[] = [];

  constructor(private readonly orphanLimit = 1000) {}

  /** A new connection: nothing is held, nothing is in flight. `shown` is kept. */
  reset(): void {
    this.held.clear();
    this.loading.clear();
    this.turns.clear();
    this.telegramTurns.clear();
    this.commands.clear();
    this.heldForCaller.clear();
    this.creating = 0;
    this.loadIntents.clear();
    this.orphans = [];
    this.intent += 1;
  }

  planSwitch(sessionId: string): SwitchPlan {
    if (this.held.has(sessionId)) return "show";
    if (this.loading.has(sessionId)) return "pending";
    return "load";
  }

  // ---- which session ends up shown -----------------------------------------

  /** Every switch the user asks for takes a fresh intent; an older new/load finishing later does not take the screen. */
  nextIntent(): number {
    this.intent += 1;
    return this.intent;
  }

  isLatest(intent: number): boolean {
    return intent === this.intent;
  }

  /** Show a held session now. */
  showLocal(sessionId: string): void {
    this.nextIntent();
    this.shown = sessionId;
  }

  /** A session/load starts, or the user asks again for one already loading: it is shown when it lands, unless the user moves on. */
  wantLoad(sessionId: string, scope?: AbortSignal): void {
    this.loadIntents.set(sessionId, { intent: this.nextIntent(), scope });
  }

  beginLoad(sessionId: string, scope?: AbortSignal): void {
    this.loading.add(sessionId);
    this.wantLoad(sessionId, scope);
  }

  /** The load succeeded: the session is held. Returns whether it should be shown. */
  loadDone(sessionId: string): boolean {
    this.loading.delete(sessionId);
    this.held.add(sessionId);
    const request = this.loadIntents.get(sessionId);
    const show = !!request && !request.scope?.aborted && this.isLatest(request.intent);
    this.loadIntents.delete(sessionId);
    if (show) this.shown = sessionId;
    return show;
  }

  loadFailed(sessionId: string): void {
    this.loading.delete(sessionId);
    this.loadIntents.delete(sessionId);
  }

  /** A session/new starts: returns its intent. */
  beginCreate(): number {
    this.creating += 1;
    return this.nextIntent();
  }

  /** The session/new of `intent` returned `sessionId`. Returns whether it should be shown. */
  created(sessionId: string, intent: number): boolean {
    this.held.add(sessionId);
    const show = this.isLatest(intent);
    if (show) this.shown = sessionId;
    return show;
  }

  /** A session/new finished, either way. */
  endCreate(): void {
    this.creating = Math.max(0, this.creating - 1);
    if (this.creating === 0) this.orphans = [];
  }

  // ---- updates and requests --------------------------------------------------

  /**
   * Where a session/update goes: to a held or loading session's state, held for a moment when it may
   * name a session/new whose reply is still on its way, or dropped.
   */
  route(u: RoutedUpdate): "apply" | "hold" | "drop" {
    if (this.held.has(u.sessionId) || this.loading.has(u.sessionId)) return "apply";
    if (this.creating > 0) {
      if (this.orphans.length < this.orphanLimit) this.orphans.push(u);
      return "hold";
    }
    return "drop";
  }

  /** The held updates that named the session a session/new just returned. */
  takeOrphans(sessionId: string): RoutedUpdate[] {
    const mine = this.orphans.filter((u) => u.sessionId === sessionId);
    if (mine.length) this.orphans = this.orphans.filter((u) => u.sessionId !== sessionId);
    return mine;
  }

  /**
   * A command is in flight for `sessionId` until the returned function is called (idempotent). The
   * count is per session, so overlapping commands do not end each other's window.
   */
  beginCommand(sessionId: string): () => void {
    this.commands.set(sessionId, (this.commands.get(sessionId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const n = (this.commands.get(sessionId) ?? 0) - 1;
      if (n > 0) this.commands.set(sessionId, n);
      else this.commands.delete(sessionId);
    };
  }

  /**
   * A permission or ask_user request may raise a dialog only for a session this window holds and
   * that has a turn running or a command in flight (a command such as /delegate asks mid-request).
   * Anything else — no string sessionId, an unknown or released session, a session doing neither —
   * is answered "cancelled" (fail closed). Returns the session, or null.
   */
  admit(params: unknown): string | null {
    const sid = (params as { sessionId?: unknown } | null | undefined)?.sessionId;
    if (typeof sid !== "string") return null;
    if (!this.held.has(sid) || !(this.turns.has(sid) || this.telegramTurns.has(sid) || this.commands.has(sid))) return null;
    return sid;
  }

  /** keryx released the session (idle cap). True when the window held it. */
  release(sessionId: string): boolean {
    this.turns.delete(sessionId);
    this.telegramTurns.delete(sessionId);
    this.commands.delete(sessionId);
    this.heldForCaller.delete(sessionId);
    return this.held.delete(sessionId);
  }
}
