import { useEffect, useRef, useState } from "react";
import type { AskUserResult, PermissionOption, PermissionOutcome } from "../acp/types";
import type { Fatal, PendingAsk, PendingPermission } from "../session/useAcpSession";

function Modal({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="overlay" role="presentation">
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Enter target: the first allow_once, else the first allow option. */
export function defaultAllow(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind.startsWith("allow"));
}
/** Esc target: the first reject_once, else the first reject option. */
export function defaultReject(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind.startsWith("reject"));
}

function summarize(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  const o = raw as Record<string, unknown>;
  for (const k of ["command", "cmd", "path", "file_path", "url", "query"]) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

export function PermissionDialog({
  pending,
  onAnswer,
}: {
  pending: PendingPermission;
  onAnswer: (p: PendingPermission, o: PermissionOutcome) => void;
}) {
  const { req } = pending;
  const options = req.options ?? [];
  const allow = defaultAllow(options);
  const reject = defaultReject(options);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const onButton = (e.target as HTMLElement | null)?.tagName === "BUTTON";
      if (e.key === "Enter" && !onButton && allow) {
        e.preventDefault();
        onAnswer(pending, { outcome: "selected", optionId: allow.optionId });
      } else if (e.key === "Escape") {
        e.preventDefault();
        onAnswer(pending, reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, allow, reject, onAnswer]);

  useEffect(() => first.current?.focus(), [pending]);

  const tc = req.toolCall;
  const detail = summarize(tc.rawInput);
  return (
    <Modal title="Permission requested">
      <p className="modal-line">
        <strong>{tc.title ?? tc.toolCallId}</strong>
        {tc.kind ? <span className="tool-kind">{tc.kind}</span> : null}
      </p>
      {detail ? <pre className="tool-pre modal-pre">{detail}</pre> : null}
      <div className="modal-actions">
        {options.map((o) => (
          <button
            key={o.optionId}
            ref={o === allow ? first : undefined}
            className={`btn ${o.kind.startsWith("allow") ? (o === allow ? "btn-primary" : "") : "btn-danger"}`}
            onClick={() => onAnswer(pending, { outcome: "selected", optionId: o.optionId })}
          >
            {o.name}
          </button>
        ))}
      </div>
      <p className="hint">Enter allows once · Esc rejects</p>
    </Modal>
  );
}

export function AskUserDialog({
  pending,
  onAnswer,
}: {
  pending: PendingAsk;
  onAnswer: (p: PendingAsk, r: AskUserResult) => void;
}) {
  const { req } = pending;
  const [picked, setPicked] = useState<string[]>([]);
  const [free, setFree] = useState("");
  const options = req.options ?? [];

  const toggle = (label: string) =>
    setPicked((p) =>
      req.multiSelect ? (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]) : [label],
    );
  const answers = [...picked, ...(free.trim() ? [free.trim()] : [])];
  const submit = () => answers.length > 0 && onAnswer(pending, { outcome: "answered", answers });

  return (
    <Modal title="keryx has a question" wide>
      <p className="modal-line">{req.question}</p>
      {options.length > 0 ? (
        <div className="ask-options">
          {options.map((o) => (
            <label key={o.label} className="ask-option">
              <input
                type={req.multiSelect ? "checkbox" : "radio"}
                name="ask"
                checked={picked.includes(o.label)}
                onChange={() => toggle(o.label)}
              />
              <span>
                <span className="ask-label">{o.label}</span>
                {o.description ? <span className="hint block">{o.description}</span> : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      <input
        className="text-input"
        placeholder={options.length > 0 ? "Or type your own answer" : "Type your answer"}
        value={free}
        autoFocus
        onChange={(e) => setFree(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          if (e.key === "Escape") { e.preventDefault(); onAnswer(pending, { outcome: "cancelled" }); }
        }}
      />
      <div className="modal-actions">
        <button className="btn" onClick={() => onAnswer(pending, { outcome: "cancelled" })}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={answers.length === 0}>Answer</button>
      </div>
    </Modal>
  );
}

export function FatalDialog({
  fatal,
  agentVersion,
  onContinue,
  onNewSession,
  onDismiss,
  onClose,
}: {
  fatal: Fatal;
  agentVersion: string | null;
  onContinue: () => void;
  onNewSession: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  if (fatal.kind === "incompatible") {
    return (
      <Modal title="Incompatible keryx">
        <p className="modal-line">
          This keryx is version <strong>{fatal.found}</strong>{agentVersion === null ? " (it did not report one)" : ""}, but Keryx
          Desktop needs <strong>{fatal.required}</strong> or newer.
        </p>
        <p className="hint">
          Update keryx, or choose a different keryx in Settings. The bundled keryx always matches this app.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={onContinue}>Continue anyway</button>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Session is in use">
      <p className="modal-line">
        Session <code>{fatal.sessionId}</code> is open in another keryx process, so it cannot be loaded here.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onDismiss}>Dismiss</button>
        <button className="btn btn-primary" onClick={onNewSession}>Start new session</button>
      </div>
    </Modal>
  );
}
