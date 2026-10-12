// Flow 419 (AC5, AC6): what the topic hears while a turn runs, and what a status question is answered with.
// Progress is a short summary the shell composes from counts and names; the model's text and a tool's
// input or output never go into a note. At most one note goes out per interval.

/** One note per this long at most. */
export const DEFAULT_PROGRESS_INTERVAL_MS = 60_000;
/** A note about a tool-heavy stretch comes after this many tool calls since the last note. */
export const DEFAULT_PROGRESS_TOOL_THRESHOLD = 8;

const TOOL_NAMES_SHOWN = 4;
const WAVE_LABELS_SHOWN = 3;

/** The part of a subagent fleet event the notes read; the shell's own event type fits it. */
export type WaveEvent = { kind: "upsert"; id: string; label?: string; status: string } | { kind: "remove"; id: string } | { kind: "log"; id: string };

export interface ProgressOptions {
  intervalMs?: number;
  toolThreshold?: number;
  now?: () => number;
  send: (text: string) => void;
  /** Test seam. */
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface TurnSnapshot {
  running: boolean;
  elapsedMs: number;
  toolCalls: number;
  lastTool?: string;
  /** Subagents of the open wave that have not finished. */
  waveRunning: number;
}

type Pending = { priority: number; build: () => string };

const ACTIVE = new Set(["queued", "running", "blocked"]);

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export class ProgressNotes {
  private readonly intervalMs: number;
  private readonly threshold: number;
  private readonly now: () => number;
  private readonly send: (text: string) => void;
  private readonly setTimer: (run: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private startedAt: number | undefined;
  private toolCalls = 0;
  private lastTool: string | undefined;
  private sinceNote = 0;
  private namesSinceNote = new Set<string>();
  private lastNoteAt: number | undefined;
  private lastNoteWindowStart: number | undefined;
  private pending: Pending | undefined;
  private timer: unknown;
  private readonly wave = new Map<string, { status: string; label: string }>();
  private waveOpen = false;

  constructor(options: ProgressOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.threshold = Math.max(1, options.toolThreshold ?? DEFAULT_PROGRESS_TOOL_THRESHOLD);
    this.now = options.now ?? Date.now;
    this.send = options.send;
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /** A turn starts: the counts begin again. The time of the last note is kept so the interval spans turns. */
  begin(): void {
    this.dropPending();
    this.startedAt = this.now();
    this.toolCalls = 0;
    this.lastTool = undefined;
    this.sinceNote = 0;
    this.namesSinceNote.clear();
    this.wave.clear();
    this.waveOpen = false;
    this.lastNoteWindowStart = this.startedAt;
  }

  /** The turn ended or remote control went off: nothing is held back for later. */
  end(): void {
    this.dropPending();
    this.startedAt = undefined;
    this.wave.clear();
    this.waveOpen = false;
  }

  /** Remote control went off: even the interval is forgotten. */
  reset(): void {
    this.end();
    this.lastNoteAt = undefined;
  }

  tool(name?: string): void {
    if (this.startedAt === undefined) return;
    this.toolCalls += 1;
    this.sinceNote += 1;
    if (name !== undefined && name.length > 0) {
      this.lastTool = name;
      this.namesSinceNote.add(name);
    }
    if (this.sinceNote >= this.threshold) this.post({ priority: 1, build: () => this.toolNote() });
  }

  /** A subagent changed state. The first one to start opens a wave and the last one to finish closes it. */
  subagent(event: WaveEvent): void {
    if (this.startedAt === undefined) return;
    if (event.kind === "upsert") {
      this.wave.set(event.id, { status: event.status, label: event.label ?? event.id });
      if (!this.waveOpen && ACTIVE.has(event.status)) {
        this.waveOpen = true;
        this.post({ priority: 2, build: () => this.waveStartNote() });
        return;
      }
    } else if (event.kind === "remove") {
      this.wave.delete(event.id);
    } else {
      return;
    }
    if (this.waveOpen && this.activeCount() === 0) {
      const done = [...this.wave.values()].filter((one) => one.status === "done").length;
      const failed = [...this.wave.values()].filter((one) => one.status === "failed").length;
      this.waveOpen = false;
      this.wave.clear();
      this.post({ priority: 3, build: () => this.waveEndNote(done, failed) });
    }
  }

  snapshot(): TurnSnapshot {
    const running = this.startedAt !== undefined;
    return {
      running,
      elapsedMs: running ? this.now() - (this.startedAt as number) : 0,
      toolCalls: this.toolCalls,
      ...(this.lastTool === undefined ? {} : { lastTool: this.lastTool }),
      waveRunning: this.activeCount(),
    };
  }

  private activeCount(): number {
    let count = 0;
    for (const one of this.wave.values()) if (ACTIVE.has(one.status)) count += 1;
    return count;
  }

  private elapsed(): string {
    return formatElapsed(this.startedAt === undefined ? 0 : this.now() - this.startedAt);
  }

  private toolNote(): string {
    const names = [...this.namesSinceNote];
    const shown = names.slice(0, TOOL_NAMES_SHOWN).join(", ");
    const more = names.length > TOOL_NAMES_SHOWN ? ` and ${names.length - TOOL_NAMES_SHOWN} more` : "";
    const window = this.lastNoteWindowStart === undefined ? "" : ` in the last ${formatElapsed(this.now() - this.lastNoteWindowStart)}`;
    const used = shown.length > 0 ? ` (${shown}${more})` : "";
    return `Still working: ${this.sinceNote} tool calls${window}${used}. ${this.elapsed()} into this turn.`;
  }

  private waveStartNote(): string {
    const labels = [...this.wave.values()].map((one) => one.label).slice(0, WAVE_LABELS_SHOWN);
    const total = this.activeCount();
    const more = total > labels.length ? ` and ${total - labels.length} more` : "";
    return `A subagent wave started: ${total} running${labels.length > 0 ? ` (${labels.join(", ")}${more})` : ""}. ${this.elapsed()} into this turn.`;
  }

  private waveEndNote(done: number, failed: number): string {
    const failedPart = failed > 0 ? `, ${failed} failed` : "";
    return `The wave finished: ${done} done${failedPart}. ${this.elapsed()} into this turn.`;
  }

  private post(next: Pending): void {
    if (!this.enabled) return;
    const at = this.now();
    if (this.lastNoteAt === undefined || at - this.lastNoteAt >= this.intervalMs) {
      this.emit(next);
      return;
    }
    // Inside the interval: keep the weightier note and send it when the interval ends.
    if (this.pending === undefined || next.priority >= this.pending.priority) this.pending = next;
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        const held = this.pending;
        this.pending = undefined;
        if (held !== undefined && this.startedAt !== undefined) this.emit(held);
      }, this.lastNoteAt + this.intervalMs - at);
    }
  }

  private emit(note: Pending): void {
    const text = note.build();
    this.lastNoteAt = this.now();
    this.lastNoteWindowStart = this.lastNoteAt;
    this.sinceNote = 0;
    this.namesSinceNote.clear();
    this.pending = undefined;
    try {
      this.send(text);
    } catch {
      // a note that cannot be sent is not worth stopping the turn for
    }
  }

  private dropPending(): void {
    this.pending = undefined;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}

// ---- a status question ---------------------------------------------------------------

const STATUS_PATTERNS: readonly RegExp[] = [
  /^(status|progress|update)( (update|report|check))?( please| pls)?$/,
  /^(what'?s|what is|whats) (the )?(current )?(status|progress|going on|happening|up)( (now|right now|here))?$/,
  /^how('?s| is) (it|that|this|the (run|review|task|work|build)) (going|progressing|doing)( so far| now)?$/,
  /^(are you|r u) (still )?(working|running|busy|alive|there|done|finished|stuck)( yet| now)?$/,
  /^(is it|are we) (done|finished|ready|stuck)( yet)?$/,
  /^what are you (doing|working on)( now| right now)?$/,
  /^where are (you|we)( now| at)?$/,
  /^(any )?(news|progress|updates?)$/,
  /^still (working|running|there|alive)$/,
  /^(статус|прогресс|как дела|как успехи|как идёт|как идет|как продвигается( работа)?|что там|что нового|что делаешь|что происходит|что сейчас происходит)( (сейчас|там|уже))*$/,
  /^(ты )?(тут|жив|ещё работаешь|еще работаешь|работаешь|завис|завис(ла)?|закончил|закончила|готов|готово)( (там|уже|ещё|еще|сейчас))*$/,
];

/** A short plain line that only asks how the run is going. Anything longer or wider goes to the model. */
export function isStatusQuestion(line: string): boolean {
  const text = line
    .trim()
    .toLowerCase()
    .replace(/[?!.…]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length === 0 || text.length > 60) return false;
  return STATUS_PATTERNS.some((pattern) => pattern.test(text));
}

export interface StatusFacts {
  /** A model turn is writing now. */
  turnRunning: boolean;
  snapshot: TurnSnapshot;
  /** Lines from this topic waiting for their turn. */
  topicWaiting: number;
  /** Everything waiting in the shell's queue, when the host says. */
  queued?: number;
  /** Approvals and questions waiting for an answer in the topic. */
  openPrompts: number;
  mode?: string;
}

/** The answer to a status question, from the session's own state. */
export function describeStatus(facts: StatusFacts): string {
  const lines: string[] = [];
  const { snapshot } = facts;
  if (facts.turnRunning && snapshot.running) {
    const tools = snapshot.toolCalls === 0 ? "no tool calls yet" : `${snapshot.toolCalls} tool call${snapshot.toolCalls === 1 ? "" : "s"}${snapshot.lastTool === undefined ? "" : `, last: ${snapshot.lastTool}`}`;
    lines.push(`Working: this turn has run for ${formatElapsed(snapshot.elapsedMs)}, ${tools}.`);
  } else if (facts.turnRunning) {
    lines.push("Working: a turn is running.");
  } else {
    lines.push("Busy: the shell is occupied with a command or its queue; no model turn is writing right now.");
  }
  if (snapshot.waveRunning > 0) lines.push(`Subagents: ${snapshot.waveRunning} still running.`);
  const queued = Math.max(facts.queued ?? 0, facts.topicWaiting);
  if (queued > 0) {
    lines.push(`Queue: ${queued} message${queued === 1 ? "" : "s"} waiting${facts.topicWaiting > 0 ? ` (${facts.topicWaiting} from this topic)` : ""}.`);
  }
  if (facts.openPrompts > 0) {
    lines.push(`Waiting for you: ${facts.openPrompts} approval or question open in this topic.`);
  }
  if (facts.mode !== undefined) lines.push(`Mode: ${facts.mode}.`);
  return lines.join("\n");
}
