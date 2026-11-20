import { memo, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { basename, copyText } from "../lib/format";
import { localImage } from "../platform/commands";
import { splitImagePaths, withImagePaths } from "./chatImages";

function SentImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void localImage(path).then((url) => { if (active) setSrc(url); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [path]);
  return src && !failed ? (
    <img className="sent-image" src={src} alt="Pasted image" onError={() => setFailed(true)} />
  ) : <span className="sent-image-label">{failed ? "Image no longer available" : "Loading image…"} · {basename(path)}</span>;
}

export const UserMessage = memo(function UserMessage({ message, onEdit }: {
  message: string;
  onEdit?: (text: string) => boolean;
}) {
  const { text, paths } = splitImagePaths(message);
  const [draft, setDraft] = useState<string | null>(null);
  const toast = useToast();
  const copy = async () => {
    const ok = await copyText(text || paths.join("\n"));
    toast({ level: ok ? "ok" : "error", title: ok ? "Message copied" : "Could not copy message" });
  };
  return (
    <div className="turn-user with-actions">
      <div className="user-msg">
        {paths.length ? <div className="sent-images">{paths.map((path, i) => <SentImage key={`${i}:${path}`} path={path} />)}</div> : null}
        {draft === null ? text : (
          <form className="user-msg-edit" onSubmit={(e) => {
            e.preventDefault();
            if ((draft.trim() || paths.length) && onEdit?.(withImagePaths(draft.trim(), paths))) setDraft(null);
          }}>
            <textarea aria-label="Edit sent message" autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.stopPropagation(); setDraft(null); } }} />
            <div className="user-msg-actions">
              <button type="button" className="btn btn-sm" aria-label="Cancel editing" onClick={() => setDraft(null)}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={!onEdit || (!draft.trim() && !paths.length)}>Send as new message</button>
            </div>
          </form>
        )}
      </div>
      {draft === null ? (
        <div className="user-msg-actions" role="group" aria-label="Message actions">
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Edit message" title="Edit and resend"
            disabled={!onEdit} onClick={() => setDraft(text)}><Icon name="pencil" size={14} /></button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Copy message" title="Copy message"
            onClick={() => void copy()}><Icon name="copy" size={14} /></button>
        </div>
      ) : null}
    </div>
  );
});
