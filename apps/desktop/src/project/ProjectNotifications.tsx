import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Spinner, useEscape, useFocusTrap } from "../components/ui";
import { absoluteTime, basename, errMessage } from "../lib/format";
import type { ProjectNotice, useProjectDiagnostics } from "../platform/projectDiagnostics";

interface Props {
  diagnostics: ReturnType<typeof useProjectDiagnostics>;
  onOpen: (notice: ProjectNotice) => Promise<void>;
}

export function ProjectNotifications({ diagnostics, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  useFocusTrap(panel, open);
  useEscape(open ? () => setOpen(false) : null, open);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside, true);
    return () => window.removeEventListener("pointerdown", closeOutside, true);
  }, [open]);

  const openNotice = async (notice: ProjectNotice) => {
    setError("");
    if (notice.target === "retry") {
      await diagnostics.scan("refresh");
      return;
    }
    try {
      await onOpen(notice);
      diagnostics.acknowledge(notice);
      setOpen(false);
    } catch (failure) {
      setError(errMessage(failure));
    }
  };

  return <div className="project-notifications" ref={container}>
    <button className="icon-btn" title="Project notifications"
      aria-label={diagnostics.unread ? `Project notifications, ${diagnostics.unread} unread` : "Project notifications"}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setError(""); setOpen(!open); }}>
      <Icon name="bell" size={16} />
      {diagnostics.unread > 0 ? <span className="project-notifications-dot" aria-hidden="true" /> : null}
    </button>
    {open ? <section className="project-notifications-panel" ref={panel} id={id} role="dialog"
      aria-label="Project notifications" tabIndex={-1}>
      <header>
        <h2>Project notifications</h2>
        <button className="icon-btn" aria-label="Check projects again" title="Check projects again"
          disabled={diagnostics.scanning} onClick={() => void diagnostics.scan("refresh")}><Icon name="refresh" /></button>
      </header>
      {diagnostics.scanning ? <div className="loading-row" role="status"><Spinner /> Checking projects…</div> : null}
      {error || diagnostics.error ? <p className="field-error" role="alert">{error || diagnostics.error}</p> : null}
      <div className="project-notifications-list">
        {diagnostics.notices.length === 0 && !diagnostics.scanning ? <p>No project notifications.</p> : null}
        {diagnostics.notices.map((notice) => {
          const time = new Date(notice.checkedAt).toISOString();
          const action = notice.target === "setup" ? "Open setup" : notice.target === "desktop" ? "Open Desktop settings" : "Retry check";
          return <div className="project-notification" key={notice.key}>
            <button className="project-notification-open" disabled={notice.target === "retry" && diagnostics.scanning}
              onClick={() => void openNotice(notice)}>
              <strong title={notice.cwd}>{basename(notice.cwd)}</strong>
              <time dateTime={time}>Checked {absoluteTime(time)}</time>
              <span>{notice.message}</span>
              <span className="project-notification-action">{action} <Icon name="arrowRight" size={12} /></span>
            </button>
            <button className="icon-btn" title="Dismiss notification" aria-label={`Dismiss ${basename(notice.cwd)} notification: ${notice.message}`}
              onClick={() => {
                diagnostics.acknowledge(notice, true);
                const refresh = panel.current?.querySelector<HTMLButtonElement>("header button:not(:disabled)");
                (refresh ?? panel.current)?.focus();
              }}><Icon name="x" size={14} /></button>
          </div>;
        })}
      </div>
    </section> : null}
  </div>;
}
