import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { copyText } from "../lib/format";
import { Icon } from "./Icon";

export interface ToastInput {
  level: "ok" | "error" | "info";
  title: string;
  body?: string;
  /** Monospace detail (stdout/stderr); errors stay until dismissed. */
  detail?: string;
}

interface Toast extends ToastInput {
  id: number;
}

const ToastContext = createContext<(t: ToastInput) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (t: ToastInput) => {
      const id = next.current++;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);
      if (t.level !== "error") window.setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-relevant="additions">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.level}`} role={t.level === "error" ? "alert" : "status"}>
            <span className="toast-icon">
              <Icon name={t.level === "ok" ? "circleCheck" : t.level === "error" ? "alert" : "info"} size={16} />
            </span>
            <div className="toast-main">
              <div className="toast-title">{t.title}</div>
              {t.body ? <div className="toast-body">{t.body}</div> : null}
              {t.detail ? <pre className="toast-detail">{t.detail}</pre> : null}
            </div>
            <div className="toast-actions">
              {t.detail ? (
                <button className="icon-btn" onClick={() => void copyText(t.detail ?? "")} aria-label="Copy output" title="Copy output">
                  <Icon name="copy" size={14} />
                </button>
              ) : null}
              <button className="icon-btn" onClick={() => dismiss(t.id)} aria-label="Dismiss" title="Dismiss">
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
