import type { AskUserRequest, AskUserResult, PermissionOutcome, PermissionRequest } from "../acp/types";

export interface PendingPermission {
  id: number;
  sessionId: string;
  req: PermissionRequest;
  resolve: (o: PermissionOutcome) => void;
}
export interface PendingAsk {
  id: number;
  sessionId: string;
  req: AskUserRequest;
  resolve: (r: AskUserResult) => void;
}

type Entry = ({ kind: "permission" } & PendingPermission) | ({ kind: "ask" } & PendingAsk);

const CANCELLED_PERMISSION: PermissionOutcome = { outcome: "cancelled" };
const CANCELLED_ASK: AskUserResult = { outcome: "cancelled" };

/**
 * keryx's permission and ask_user requests, queued on the session that sent them. Only the shown
 * session's are put on screen; every other session keeps its own until the user switches to it.
 * Each request is answered exactly once: by the user, or with "cancelled" when its turn ends, its
 * session is released or the connection goes.
 */
export class DialogQueue {
  private entries: Entry[] = [];
  private seq = 0;

  constructor(private readonly onChange: () => void = () => {}) {}

  permission(sessionId: string, req: PermissionRequest): Promise<PermissionOutcome> {
    return new Promise((resolve) => this.push({ kind: "permission", id: ++this.seq, sessionId, req, resolve }));
  }

  ask(sessionId: string, req: AskUserRequest): Promise<AskUserResult> {
    return new Promise((resolve) => this.push({ kind: "ask", id: ++this.seq, sessionId, req, resolve }));
  }

  /** The session's dialogs in arrival order. */
  forSession(sessionId: string | null): { permissions: PendingPermission[]; asks: PendingAsk[] } {
    const permissions: PendingPermission[] = [];
    const asks: PendingAsk[] = [];
    for (const e of this.entries) {
      if (e.sessionId !== sessionId) continue;
      if (e.kind === "permission") permissions.push(e);
      else asks.push(e);
    }
    return { permissions, asks };
  }

  /** Sessions with at least one dialog waiting for the user. */
  waiting(): Set<string> {
    return new Set(this.entries.map((e) => e.sessionId));
  }

  answerPermission(p: PendingPermission, outcome: PermissionOutcome): void {
    this.settle(p.id, outcome);
  }

  answerAsk(a: PendingAsk, result: AskUserResult): void {
    this.settle(a.id, result);
  }

  /** Cancel every dialog of one session: its turn ended or was stopped, or keryx released it. */
  dropSession(sessionId: string): void {
    this.drop((e) => e.sessionId === sessionId);
  }

  /** Cancel every dialog: the connection is gone. */
  dropAll(): void {
    this.drop(() => true);
  }

  private push(e: Entry): void {
    this.entries = [...this.entries, e];
    this.onChange();
  }

  private settle(id: number, value: PermissionOutcome | AskUserResult): void {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return; // already answered or dropped
    this.entries = this.entries.filter((x) => x !== e);
    if (e.kind === "permission") e.resolve(value as PermissionOutcome);
    else e.resolve(value as AskUserResult);
    this.onChange();
  }

  private drop(match: (e: Entry) => boolean): void {
    const gone = this.entries.filter(match);
    if (gone.length === 0) return;
    this.entries = this.entries.filter((e) => !match(e));
    for (const e of gone) {
      if (e.kind === "permission") e.resolve(CANCELLED_PERMISSION);
      else e.resolve(CANCELLED_ASK);
    }
    this.onChange();
  }
}
