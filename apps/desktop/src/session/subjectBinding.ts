import type { SessionFlags, SessionSubject } from "../acp/types";

/** Said in the session when keryx answered the binding without a subject: an older keryx that cannot store it. */
export const SUBJECT_NOT_SAVED = "This keryx did not save the pull request binding: the session works, but the card will not find it again. Update keryx to keep the binding.";

export interface SubjectBindingDeps {
  /** `_keryx/session_flags` with `subject`; throws while keryx has not stored the new session yet. */
  write: (sessionId: string, subject: SessionSubject) => Promise<SessionFlags | null | undefined>;
  /** The flags keryx answered, as stored; the binding stays pending (shown) until a returned promise settles. */
  onFlags: (sessionId: string, flags: SessionFlags) => void | Promise<unknown>;
  /** A warning in that session's transcript. */
  onNotice: (sessionId: string, text: string) => void;
  /** The pending bindings changed. */
  onChange: (pending: ReadonlyMap<string, SessionSubject>) => void;
}

/**
 * Subject bindings waiting for keryx to store a new session, like the pending flow link: tried at once,
 * kept quietly when keryx does not have the session yet, tried again after the session's turn.
 * A reply without `subject` comes from a keryx that ignores the key: the binding is dropped with a notice.
 */
export class PendingSubjects {
  private readonly pending = new Map<string, SessionSubject>();

  constructor(private readonly deps: SubjectBindingDeps) {}

  get(sessionId: string): SessionSubject | undefined {
    return this.pending.get(sessionId);
  }

  bind(sessionId: string, subject: SessionSubject): Promise<void> {
    this.pending.set(sessionId, subject);
    this.changed();
    return this.apply(sessionId);
  }

  /** Try the pending binding of `sessionId`, if any. Never throws. */
  async apply(sessionId: string): Promise<void> {
    const subject = this.pending.get(sessionId);
    if (!subject) return;
    let flags: SessionFlags;
    try {
      flags = (await this.deps.write(sessionId, subject)) ?? {};
    } catch {
      return; // not stored yet: tried again after its turn
    }
    // A newer bind for the same session replaced this one while the request ran: that one decides.
    if (this.pending.get(sessionId) !== subject) return;
    try {
      await this.deps.onFlags(sessionId, flags);
    } finally {
      if (this.pending.get(sessionId) === subject) {
        this.pending.delete(sessionId);
        this.changed();
      }
    }
    if (!flags.subject) this.deps.onNotice(sessionId, SUBJECT_NOT_SAVED);
  }

  private changed() {
    this.deps.onChange(new Map(this.pending));
  }
}
