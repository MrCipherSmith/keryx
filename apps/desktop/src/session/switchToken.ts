/**
 * Session-switch token and the single owner of "a switch is in flight". Every switch (load, new,
 * start-up) takes a fresh value synchronously, before its first await; a continuation whose value is
 * no longer current drops its result, and only the current switch may end the in-flight state.
 */
export class SwitchToken {
  private seq = 0;
  /** The switch in flight; 0 when none. */
  private active = 0;

  get switching(): boolean {
    return this.active !== 0;
  }

  begin(): number {
    this.seq += 1;
    this.active = this.seq;
    return this.seq;
  }

  isCurrent(seq: number): boolean {
    return seq === this.seq;
  }

  /** End switch `seq`. False, and nothing changes, when a newer switch has taken over. */
  finish(seq: number): boolean {
    if (seq !== this.seq) return false;
    this.active = 0;
    return true;
  }

  /** A restart: every outstanding token goes stale and nothing is in flight. */
  reset(): void {
    this.seq += 1;
    this.active = 0;
  }
}

/**
 * Updates that arrive while a session/new is in flight name a session the client does not know yet
 * (keryx may report the new session's hook notices before it replies). They are held here and the
 * ones for the returned id are replayed once the reply arrives; the rest are dropped.
 */
export class NewSessionBuffer<U> {
  private owner = 0;
  private held: Array<{ sessionId: string; update: U }> = [];

  constructor(private readonly limit = 1000) {}

  /** Start holding for the session/new of switch `seq`. */
  open(seq: number): void {
    this.owner = seq;
    this.held = [];
  }

  /** Hold an update for an unknown session. False when no session/new is pending. */
  offer(sessionId: string, update: U): boolean {
    if (this.owner === 0) return false;
    if (this.held.length < this.limit) this.held.push({ sessionId, update });
    return true;
  }

  /** Stop holding and return the updates for `sessionId`; empty unless switch `seq` still owns the buffer. */
  take(seq: number, sessionId: string): U[] {
    if (seq !== this.owner) return [];
    const out = this.held.filter((h) => h.sessionId === sessionId).map((h) => h.update);
    this.close(seq);
    return out;
  }

  /** Stop holding for switch `seq`; a newer owner keeps its buffer. Without `seq`, always. */
  close(seq?: number): void {
    if (seq !== undefined && seq !== this.owner) return;
    this.owner = 0;
    this.held = [];
  }
}
