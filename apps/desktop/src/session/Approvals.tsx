import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AskUserResult, PermissionOption, PermissionOutcome, PermissionReasons, ToolKind } from "../acp/types";
import type { Fatal, PendingAsk, PendingPermission } from "./useAcpSession";
import { Icon, type IconName } from "../components/Icon";
import { Dialog, Kbd } from "../components/ui";
import { DiffView } from "./Transcript";
import { argLabel, lineCount, primaryInput, restArgs, visibleProse, visibleText } from "./toolInput";
import { ASK_CONTROLS, askEnter, enterKeyOf, PERMISSION_CONTROLS, permissionEnter } from "./enterGuard";
import { blockText } from "./reducer";

/** Enter target: the first allow_once, else the first allow option. */
export function defaultAllow(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind.startsWith("allow"));
}
/** Esc target: the first reject_once, else the first reject option. */
export function defaultReject(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind.startsWith("reject"));
}

const KIND_COPY: Partial<Record<ToolKind, { icon: IconName; verb: string }>> = {
  execute: { icon: "terminal", verb: "run a command" },
  edit: { icon: "pencil", verb: "change a file" },
  delete: { icon: "trash", verb: "delete a file" },
  move: { icon: "move", verb: "move a file" },
  fetch: { icon: "globe", verb: "fetch from the network" },
  read: { icon: "file", verb: "read a file" },
  search: { icon: "search", verb: "search" },
};

/** Only when keryx did not say why it asks. */
function whyGated(modeId: string | null): string {
  if (modeId === "trust") return "Trust mode still asks for destructive, credential-touching and other escalated calls.";
  if (modeId === "auto") return "Auto mode still asks for calls that touch credentials.";
  if (modeId === "ask") return "Ask mode asks before every gated tool call.";
  return "keryx asks before running gated tools.";
}

/** `toolCall._meta.keryx.reasons`, keeping only well-typed fields. */
export function permissionReasons(meta: unknown): PermissionReasons {
  const raw = (meta as { keryx?: { reasons?: unknown } } | undefined)?.keryx?.reasons;
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: PermissionReasons = {};
  for (const k of ["untrustedOrigin", "credentials", "destructive", "publishLease", "hcLaunch", "hookAsk", "alwaysAsk"] as const) {
    if (r[k] === true) out[k] = true;
  }
  if (typeof r.publishLeaseDetail === "string" && r.publishLeaseDetail.trim()) out.publishLeaseDetail = r.publishLeaseDetail;
  return out;
}

/** The sentences that say why keryx asks; untrustedOrigin has its own banner. */
export function reasonLines(r: PermissionReasons): string[] {
  const out: string[] = [];
  if (r.destructive) out.push("It can delete or overwrite data, which cannot be undone.");
  if (r.credentials) out.push("It touches credentials or secrets.");
  if (r.publishLease || r.publishLeaseDetail) {
    out.push(r.publishLeaseDetail ? `It publishes outside this machine: ${visibleProse(r.publishLeaseDetail)}` : "It publishes outside this machine.");
  }
  if (r.hcLaunch) out.push("It launches another agent.");
  if (r.hookAsk) out.push("A project hook asked for your confirmation.");
  if (r.alwaysAsk) out.push("This tool is set to always ask.");
  return out;
}

/** Track which review boxes are still partly unread. */
function useUnreadBoxes() {
  const [unreadBoxes, setUnreadBoxes] = useState<ReadonlySet<string>>(() => new Set());
  const reportUnread = useCallback((id: string, isUnread: boolean) => {
    setUnreadBoxes((prev) => {
      if (prev.has(id) === isUnread) return prev;
      const next = new Set(prev);
      if (isUnread) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  return { unreadBoxes, reportUnread };
}

type ReportUnread = (id: string, isUnread: boolean) => void;

/** Report `isUnread` for `id` whenever it changes, and "read" when the box goes away. */
function useReport(id: string, isUnread: boolean, reportUnread: ReportUnread) {
  useEffect(() => reportUnread(id, isUnread), [id, isUnread, reportUnread]);
  useEffect(() => () => reportUnread(id, false), [id, reportUnread]);
}

/**
 * Whether a scroll box hides part of its content, and whether it has been scrolled to its end. It is
 * measured again whenever the box or its content changes size (a narrower window, a font that
 * finished loading, a box above it that expanded), and new content below the fold makes it unread again.
 */
function useOverflowRead(getEl: () => HTMLElement | null, deps: readonly unknown[]) {
  const [overflows, setOverflows] = useState(false);
  const [readToEnd, setReadToEnd] = useState(false);
  useLayoutEffect(() => {
    const el = getEl();
    if (!el) return;
    let lastHeight = el.scrollHeight;
    let alive = true;
    const atEnd = () => el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    const measure = () => {
      if (!alive) return;
      const over = el.scrollHeight > el.clientHeight + 1;
      setOverflows(over);
      if (el.scrollHeight > lastHeight + 1 && !atEnd()) setReadToEnd(false);
      lastHeight = el.scrollHeight;
    };
    const onScroll = () => {
      if (atEnd()) setReadToEnd(true);
    };
    measure();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    for (const child of Array.from(el.children)) ro?.observe(child);
    void document.fonts?.ready.then(measure);
    return () => {
      alive = false;
      ro?.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { overflows, readToEnd };
}

export function PermissionDialog({
  pending,
  modeId,
  queued,
  onAnswer,
}: {
  pending: PendingPermission;
  modeId: string | null;
  queued: number;
  onAnswer: (p: PendingPermission, o: PermissionOutcome) => void;
}) {
  const { req } = pending;
  const options = req.options ?? [];
  const allow = defaultAllow(options);
  const reject = defaultReject(options);
  const once = options.filter((o) => o.kind === "allow_once" || o.kind === "reject_once");
  const always = options.filter((o) => o.kind === "allow_always" || o.kind === "reject_always");

  // Boxes whose content is partly hidden; Enter does not approve until each is read to its end or expanded.
  const { unreadBoxes, reportUnread } = useUnreadBoxes();
  const contentRef = useRef<HTMLDivElement>(null);
  const [blocked, setBlocked] = useState(false);

  // The dialog body scrolls too: a call taller than the window hides its last boxes below the fold.
  const body = useOverflowRead(() => contentRef.current?.closest<HTMLElement>(".dialog-body") ?? null, []);
  useReport("dialog-body", body.overflows && !body.readToEnd, reportUnread);

  /** A blocked Enter shows where the unread part is. */
  const pointAtUnread = () => {
    setBlocked(true);
    const first = contentRef.current?.querySelector<HTMLElement>('[data-unread="true"]');
    if (first) {
      first.scrollIntoView({ block: "nearest" });
      first.querySelector<HTMLElement>("button")?.focus();
    } else {
      const bodyEl = contentRef.current?.closest<HTMLElement>(".dialog-body");
      bodyEl?.scrollBy({ top: bodyEl.clientHeight * 0.8 });
    }
  };

  // Enter/Esc act only on keys that start inside this dialog, never on text fields, and never right after it opens.
  const openedAt = useRef(performance.now());
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      if (e.nativeEvent.isComposing || e.defaultPrevented) return;
      e.preventDefault();
      onAnswer(pending, reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" });
      return;
    }
    const v = permissionEnter({ ...enterKeyOf(e, openedAt.current, PERMISSION_CONTROLS, performance.now()), allow, unread: unreadBoxes.size > 0 });
    if (v.verdict === "pass") return;
    e.preventDefault();
    if (v.verdict === "submit") onAnswer(pending, { outcome: "selected", optionId: v.option.optionId });
    else pointAtUnread();
  };

  const tc = req.toolCall;
  const kind = (tc.kind ?? "other") as ToolKind;
  const copy = KIND_COPY[kind] ?? { icon: "shield" as IconName, verb: "use a tool" };
  const primary = primaryInput(tc.rawInput);
  const diffs = (tc.content ?? []).filter((c) => c.type === "diff");
  const texts = (tc.content ?? []).filter((c) => c.type === "content").map((c) => (c.type === "content" ? blockText(c.content).trim() : "")).filter(Boolean);
  const args = useMemo(() => restArgs(tc.rawInput), [tc.rawInput]);
  const reasons = useMemo(() => permissionReasons(tc._meta), [tc._meta]);
  const why = reasonLines(reasons);
  const danger = kind === "delete" || reasons.destructive === true;
  const unread = unreadBoxes.size > 0;

  const answer = (o: PermissionOption) => onAnswer(pending, { outcome: "selected", optionId: o.optionId });
  const label = (o: PermissionOption) => visibleProse(o.name);

  return (
    <Dialog
      title={`Allow keryx to ${copy.verb}?`}
      icon={copy.icon}
      tone={danger ? "danger" : "warn"}
      onClose={null}
      ownEscape
      focusRoot
      onKeyDown={onKeyDown}
      width={560}
      footer={
        <div className="approval-foot">
          {always.length > 0 ? (
            <div className="approval-always">
              <span className="approval-always-label">For the rest of this session</span>
              {always.map((o) => (
                <button key={o.optionId} className="btn btn-sm btn-ghost" onClick={() => answer(o)}>
                  {label(o)}
                </button>
              ))}
            </div>
          ) : null}
          <div className="approval-main">
            <p className={`approval-hint${unread && blocked ? " is-blocked" : ""}`} aria-live="polite">
              {unread ? "Part of this call is not shown yet. Read every box to its end, or show all, before ↵ approves." : ""}
            </p>
            {once
              .filter((o) => o.kind === "reject_once")
              .map((o) => (
                <button key={o.optionId} className="btn" onClick={() => answer(o)}>
                  {label(o)} <Kbd>esc</Kbd>
                </button>
              ))}
            {once
              .filter((o) => o.kind === "allow_once")
              .map((o) => (
                <button key={o.optionId} className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={() => answer(o)}>
                  {label(o)} {unread ? null : <Kbd>↵</Kbd>}
                </button>
              ))}
            {once.length === 0
              ? options.map((o) => (
                  <button key={o.optionId} className="btn" onClick={() => answer(o)}>
                    {label(o)}
                  </button>
                ))
              : null}
          </div>
        </div>
      }
    >
      <div ref={contentRef} className="approval-content">
        <div className="approval-tool">
          <span className="tag">{kind}</span>
          <span className="approval-title">{visibleText(tc.title ?? tc.toolCallId)}</span>
        </div>
        {reasons.untrustedOrigin ? (
          <div className="inline-banner tone-info">
            <Icon name="shield" size={14} />
            <span>This call follows content from an untrusted source (a web page or tool output). Check what it does with care.</span>
          </div>
        ) : null}
        {primary ? (
          <div className="approval-what">
            <div className="tool-label">{primary.label}</div>
            <ReviewPre
              id="primary"
              text={primary.value}
              className={`out-pre mono-strong is-strict${kind === "execute" ? " is-command" : ""}`}
              prefix={kind === "execute" ? <span className="prompt-sign">$ </span> : null}
              reportUnread={reportUnread}
            />
          </div>
        ) : null}
        {diffs.map((d, i) =>
          d.type === "diff" ? <ReviewDiff key={i} id={`diff-${i}`} path={d.path} oldText={d.oldText} newText={d.newText} reportUnread={reportUnread} /> : null,
        )}
        {texts.map((t, i) => (
          <ReviewPre key={i} id={`content-${i}`} text={visibleText(t)} className="out-pre is-strict" reportUnread={reportUnread} />
        ))}
        {args.map((a) => (
          <div key={a.id} className="approval-what">
            <div className="tool-label">{argLabel(a, primary !== null)}</div>
            <ReviewPre id={a.id} text={a.text} className="out-pre is-strict" reportUnread={reportUnread} />
          </div>
        ))}
        {why.length > 0 ? (
          <div className="approval-why">
            <Icon name="info" size={13} />
            <ul>
              {why.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ) : reasons.untrustedOrigin ? null : (
          <p className="approval-why">
            <Icon name="info" size={13} />
            <span>{whyGated(modeId)}</span>
          </p>
        )}
        {queued > 0 ? <p className="approval-queue">{queued} more request{queued > 1 ? "s" : ""} waiting</p> : null}
      </div>
    </Dialog>
  );
}

export function AskUserDialog({ pending, onAnswer }: { pending: PendingAsk; onAnswer: (p: PendingAsk, r: AskUserResult) => void }) {
  const { req } = pending;
  const meta = req._meta?.keryx;
  const options = req.options ?? [];
  const recommended = meta?.recommended;
  // Free text only when keryx allows it; an older keryx without the extras and no options still needs a field.
  const allowFree = meta?.allowFreeform === true || (meta === undefined && options.length === 0);
  const irreversible = meta?.irreversible === true;
  // An irreversible question pre-checks nothing: one stray Enter must not pick an answer.
  const [picked, setPicked] = useState<string[]>(() =>
    !irreversible && recommended && options.some((o) => o.label === recommended) ? [recommended] : [],
  );
  const [free, setFree] = useState("");

  // The raw label is the answer sent back; only what is shown is escaped.
  const toggle = (label: string) => {
    if (!req.multiSelect) setFree("");
    setPicked((p) => (req.multiSelect ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label]));
  };
  const onFree = (v: string) => {
    setFree(v);
    // Single choice: the typed text is the answer, so the checked option must not stay shown as selected.
    if (!req.multiSelect && v.trim()) setPicked([]);
  };
  const answers = free.trim() ? (req.multiSelect ? [...picked, free.trim()] : [free.trim()]) : picked;
  const submit = () => answers.length > 0 && onAnswer(pending, { outcome: "answered", answers });

  // One Enter handler for the whole dialog: ignored right after open, on key repeat, and on buttons (they act on their own).
  const openedAt = useRef(performance.now());
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const verdict = askEnter(enterKeyOf(e, openedAt.current, ASK_CONTROLS, performance.now()));
    if (verdict === "pass") return;
    e.preventDefault();
    if (verdict === "submit") submit();
  };

  return (
    <Dialog
      title="keryx has a question"
      icon={meta?.irreversible ? "alert" : "chat"}
      tone={meta?.irreversible ? "warn" : "default"}
      onClose={() => onAnswer(pending, { outcome: "cancelled" })}
      // Nothing starts focused on an irreversible choice; a free-text-only question still focuses its field.
      focusRoot={irreversible && options.length > 0}
      onKeyDown={onKeyDown}
      width={540}
      footer={
        <>
          <button className="btn" onClick={() => onAnswer(pending, { outcome: "cancelled" })}>
            Decline <Kbd>esc</Kbd>
          </button>
          <button className={`btn ${meta?.irreversible ? "btn-danger" : "btn-primary"}`} onClick={submit} disabled={answers.length === 0}>
            Answer <Kbd>↵</Kbd>
          </button>
        </>
      }
    >
      <p className="ask-question is-prose" dir="auto">
        {visibleProse(req.question)}
      </p>
      {meta?.irreversible ? (
        <div className="inline-banner tone-warn">
          <Icon name="alert" size={14} />
          <span>Your answer leads to something that cannot be undone.</span>
        </div>
      ) : null}
      {meta?.untrustedContent ? (
        <div className="inline-banner tone-info">
          <Icon name="shield" size={14} />
          <span>This question includes content from an untrusted source (a web page or tool output). Read it with care.</span>
        </div>
      ) : null}
      {options.length > 0 ? (
        <div className="choice-list" role={req.multiSelect ? "group" : "radiogroup"} aria-label="Options">
          {options.map((o, i) => {
            const on = picked.includes(o.label);
            return (
              <label key={i} className={`choice${on ? " is-on" : ""}`}>
                <input
                  type={req.multiSelect ? "checkbox" : "radio"}
                  name="ask"
                  checked={on}
                  onChange={() => toggle(o.label)}
                  data-autofocus={(recommended ? o.label === recommended : i === 0) ? true : undefined}
                />
                <span>
                  <span className="choice-label">
                    <bdi className="is-prose">{visibleProse(o.label)}</bdi>
                    {o.label === recommended ? <span className="badge badge-ok">Recommended</span> : null}
                  </span>
                  {o.description ? (
                    <span className="choice-help is-prose" dir="auto">
                      {visibleProse(o.description)}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
      {allowFree ? (
        <label className="field" style={{ marginTop: options.length ? 12 : 0 }}>
          <span className="field-label">{options.length > 0 ? "Or answer in your own words" : "Your answer"}</span>
          <input value={free} data-autofocus={options.length === 0 ? true : undefined} onChange={(e) => onFree(e.target.value)} />
        </label>
      ) : null}
    </Dialog>
  );
}

/**
 * The line above a review box that does not fit: how long it is, whether it has been read, and a
 * Show all / Show less toggle that stays mounted (so it keeps focus).
 */
function ReviewNote({
  size,
  unread,
  expanded,
  onToggle,
}: {
  size: string;
  unread: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`review-warn${unread ? " is-unread" : ""}`} role="note">
      <Icon name={unread ? "alert" : "check"} size={13} />
      <span>
        {unread
          ? `${size}, not all shown. Scroll to the end or show all before approving with ↵.`
          : expanded
            ? `${size}, all shown.`
            : `${size} — read to the end.`}
      </span>
      <button type="button" className="link-btn" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? "Show less" : "Show all"}
      </button>
    </div>
  );
}

/** Lines of a box's text, as the note says them. */
function sizeOf(lines: number): string {
  return lines > 1 ? `${lines} lines` : "Long value";
}

/**
 * A text box in an approval. When its content does not fit, it says how long it is and reports itself
 * unread until it has been scrolled to the end or expanded; expanding counts as read.
 */
function ReviewPre({
  id,
  text,
  className,
  prefix,
  reportUnread,
}: {
  id: string;
  text: string;
  className: string;
  prefix?: ReactNode;
  reportUnread: ReportUnread;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [seen, setSeen] = useState(false);
  const { overflows, readToEnd } = useOverflowRead(() => ref.current, [text, expanded]);
  const unread = overflows && !expanded && !seen && !readToEnd;
  useReport(id, unread, reportUnread);
  const toggle = () => {
    setSeen(true);
    setExpanded((x) => !x);
  };

  return (
    <div className="review-box" data-unread={unread ? "true" : undefined}>
      {overflows || expanded ? <ReviewNote size={sizeOf(lineCount(text))} unread={unread} expanded={expanded} onToggle={toggle} /> : null}
      <pre ref={ref} className={`${className}${expanded ? " is-expanded" : ""}`}>
        {prefix}
        {text}
      </pre>
    </div>
  );
}

/** A diff in an approval: escaped like every other box, and under the same read-before-Enter rule. */
function ReviewDiff({
  id,
  path,
  oldText,
  newText,
  reportUnread,
}: {
  id: string;
  path: string;
  oldText?: string | null;
  newText: string;
  reportUnread: ReportUnread;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [seen, setSeen] = useState(false);
  const { overflows, readToEnd } = useOverflowRead(() => ref.current, [oldText, newText, expanded]);
  const unread = overflows && !expanded && !seen && !readToEnd;
  useReport(id, unread, reportUnread);
  const lines = useMemo(() => lineCount(newText) + lineCount(oldText ?? ""), [oldText, newText]);
  const toggle = () => {
    setSeen(true);
    setExpanded((x) => !x);
  };

  return (
    <div className="review-box" data-unread={unread ? "true" : undefined}>
      {overflows || expanded ? <ReviewNote size={sizeOf(lines)} unread={unread} expanded={expanded} onToggle={toggle} /> : null}
      <DiffView path={path} oldText={oldText} newText={newText} bodyRef={ref} expanded={expanded} faithful />
    </div>
  );
}

export function FatalDialog({
  fatal,
  agentVersion,
  onContinue,
  onNewSession,
  onDismiss,
  onClose,
  onSettings,
}: {
  fatal: Fatal;
  agentVersion: string | null;
  onContinue: () => void;
  onNewSession: () => void;
  onDismiss: () => void;
  onClose: () => void;
  onSettings: () => void;
}) {
  if (fatal.kind === "incompatible" || fatal.kind === "noShell") {
    return (
      <Dialog
        title="This keryx is too old for the app"
        icon="alert"
        tone="warn"
        onClose={null}
        footer={
          <>
            {fatal.kind === "incompatible" ? (
              <button className="btn btn-ghost" onClick={onContinue}>
                Continue anyway
              </button>
            ) : null}
            <button className="btn" onClick={onSettings}>
              Choose another keryx…
            </button>
            <button className="btn btn-primary" data-autofocus onClick={onClose}>
              Close project
            </button>
          </>
        }
      >
        {fatal.kind === "incompatible" ? (
          <p>
            It reports version <strong>{fatal.found}</strong>
            {agentVersion === null ? " (it did not report one)" : ""}; Keryx Desktop needs <strong>{fatal.required}</strong> or newer.
          </p>
        ) : fatal.reason === "no-profile" ? (
          <p>
            This keryx{fatal.found !== "unknown" ? ` (${fatal.found})` : ""} has no shell profile (<code className="mono">keryx acp --profile shell</code>), which
            the desktop app runs on.
          </p>
        ) : (
          <p>
            This keryx ({fatal.found}) has a shell profile, but it closes a session whenever another one opens. The desktop app keeps every
            session alive while you switch between them, so it needs a newer keryx.
          </p>
        )}
        <p className="dialog-sub">
          Update keryx (<code className="mono">npm i -g @mrciphersmith/keryx</code>), or use the bundled keryx in Settings — it always matches this app.
        </p>
      </Dialog>
    );
  }
  return (
    <Dialog
      title="This session is open somewhere else"
      icon="lock"
      tone="warn"
      onClose={onDismiss}
      footer={
        <>
          <button className="btn" onClick={onDismiss}>
            Dismiss
          </button>
          <button className="btn btn-primary" data-autofocus onClick={onNewSession}>
            Start new session
          </button>
        </>
      }
    >
      <p>
        Another keryx process holds session <code className="mono">{fatal.sessionId}</code>, so it cannot be loaded here. Close it there, or
        start a new session in this window.
      </p>
    </Dialog>
  );
}
