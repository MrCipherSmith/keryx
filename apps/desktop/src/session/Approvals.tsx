import { useMemo, useRef, useState } from "react";
import type { AskUserResult, PermissionOption, PermissionOutcome, ToolKind } from "../acp/types";
import type { Fatal, PendingAsk, PendingPermission } from "./useAcpSession";
import { Icon, type IconName } from "../components/Icon";
import { Dialog, Kbd } from "../components/ui";
import { DiffView, primaryInput, restInput } from "./Transcript";
import { blockText } from "./reducer";

/** Enter target: the first allow_once, else the first allow option. */
export function defaultAllow(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind.startsWith("allow"));
}
/** Esc target: the first reject_once, else the first reject option. */
export function defaultReject(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind.startsWith("reject"));
}

/** Ignore Enter this long after the dialog appears: a keystroke aimed at the composer must not approve. */
const ENTER_GUARD_MS = 300;

const KIND_COPY: Partial<Record<ToolKind, { icon: IconName; verb: string }>> = {
  execute: { icon: "terminal", verb: "run a command" },
  edit: { icon: "pencil", verb: "change a file" },
  delete: { icon: "trash", verb: "delete a file" },
  move: { icon: "move", verb: "move a file" },
  fetch: { icon: "globe", verb: "fetch from the network" },
  read: { icon: "file", verb: "read a file" },
  search: { icon: "search", verb: "search" },
};

function whyGated(modeId: string | null): string {
  if (modeId === "trust") return "Trust mode still asks for destructive, credential-touching and other escalated calls.";
  if (modeId === "auto") return "Auto mode still asks for calls that touch credentials.";
  if (modeId === "ask") return "Ask mode asks before every gated tool call.";
  return "keryx asks before running gated tools.";
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

  // Enter/Esc act only on keys that start inside this dialog, never on text fields, and never right after it opens.
  const openedAt = useRef(performance.now());
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (e.key === "Enter") {
      if (!allow || e.repeat || performance.now() - openedAt.current < ENTER_GUARD_MS) return;
      if (t?.closest('input, textarea, select, button, a, summary, [contenteditable=""], [contenteditable="true"]')) return;
      e.preventDefault();
      onAnswer(pending, { outcome: "selected", optionId: allow.optionId });
    } else if (e.key === "Escape") {
      e.preventDefault();
      onAnswer(pending, reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" });
    }
  };

  const tc = req.toolCall;
  const kind = (tc.kind ?? "other") as ToolKind;
  const copy = KIND_COPY[kind] ?? { icon: "shield" as IconName, verb: "use a tool" };
  const primary = primaryInput(tc.rawInput);
  const diffs = (tc.content ?? []).filter((c) => c.type === "diff");
  const texts = (tc.content ?? []).filter((c) => c.type === "content").map((c) => (c.type === "content" ? blockText(c.content).trim() : "")).filter(Boolean);
  const rawJson = useMemo(() => restInput(tc.rawInput), [tc.rawInput]);
  const danger = kind === "delete";

  const answer = (o: PermissionOption) => onAnswer(pending, { outcome: "selected", optionId: o.optionId });
  const label = (o: PermissionOption) => o.name;

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
                  {label(o)} <Kbd>↵</Kbd>
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
      <div className="approval-tool">
        <span className="tag">{kind}</span>
        <span className="approval-title">{tc.title ?? tc.toolCallId}</span>
      </div>
      {primary ? (
        <div className="approval-what">
          <div className="tool-label">{primary.label}</div>
          <pre className={`out-pre mono-strong${kind === "execute" ? " is-command" : ""}`}>
            {kind === "execute" ? <span className="prompt-sign">$ </span> : null}
            {primary.value}
          </pre>
        </div>
      ) : null}
      {diffs.map((d, i) => (d.type === "diff" ? <DiffView key={i} path={d.path} oldText={d.oldText} newText={d.newText} /> : null))}
      {texts.map((t, i) => (
        <pre key={i} className="out-pre">
          {t}
        </pre>
      ))}
      {rawJson ? (
        <div className="approval-what">
          <div className="tool-label">{primary ? "Other arguments" : "Tool input"}</div>
          <pre className="out-pre">{rawJson}</pre>
        </div>
      ) : null}
      <p className="approval-why">
        <Icon name="info" size={13} />
        <span>{whyGated(modeId)}</span>
      </p>
      {queued > 0 ? <p className="approval-queue">{queued} more request{queued > 1 ? "s" : ""} waiting</p> : null}
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
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.defaultPrevented) return;
    if (e.repeat || performance.now() - openedAt.current < ENTER_GUARD_MS) {
      e.preventDefault();
      return;
    }
    const t = e.target as HTMLElement | null;
    if (t?.closest("button, a, summary")) return;
    e.preventDefault();
    submit();
  };

  return (
    <Dialog
      title="keryx has a question"
      icon={meta?.irreversible ? "alert" : "chat"}
      tone={meta?.irreversible ? "warn" : "default"}
      onClose={() => onAnswer(pending, { outcome: "cancelled" })}
      focusRoot={irreversible}
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
      <p className="ask-question">{req.question}</p>
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
              <label key={o.label} className={`choice${on ? " is-on" : ""}`}>
                <input
                  type={req.multiSelect ? "checkbox" : "radio"}
                  name="ask"
                  checked={on}
                  onChange={() => toggle(o.label)}
                  data-autofocus={(recommended ? o.label === recommended : i === 0) ? true : undefined}
                />
                <span>
                  <span className="choice-label">
                    {o.label}
                    {o.label === recommended ? <span className="badge badge-ok">Recommended</span> : null}
                  </span>
                  {o.description ? <span className="choice-help">{o.description}</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
      {allowFree ? (
        <label className="field" style={{ marginTop: options.length ? 12 : 0 }}>
          <span className="field-label">{options.length > 0 ? "Or answer in your own words" : "Your answer"}</span>
          <input
            value={free}
            data-autofocus={options.length === 0 ? true : undefined}
            onChange={(e) => onFree(e.target.value)}
          />
        </label>
      ) : null}
    </Dialog>
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
  if (fatal.kind === "incompatible") {
    return (
      <Dialog
        title="This keryx is too old for the app"
        icon="alert"
        tone="warn"
        onClose={null}
        footer={
          <>
            <button className="btn btn-ghost" onClick={onContinue}>
              Continue anyway
            </button>
            <button className="btn" onClick={onSettings}>
              Choose another keryx…
            </button>
            <button className="btn btn-primary" data-autofocus onClick={onClose}>
              Close project
            </button>
          </>
        }
      >
        <p>
          It reports version <strong>{fatal.found}</strong>
          {agentVersion === null ? " (it did not report one)" : ""}; Keryx Desktop needs <strong>{fatal.required}</strong> or newer.
        </p>
        <p className="dialog-sub">Update keryx, or pick the bundled keryx in Settings — it always matches this app.</p>
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
