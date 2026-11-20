import { memo, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { useToast } from "../components/Toasts";
import { copyText } from "../lib/format";
import { AttachmentImage } from "./AttachmentImage";
import { replayHasFlattenedContext, type UserPromptContext } from "./userPrompt";

const NO_IMAGES: readonly string[] = [];

export const UserMessage = memo(function UserMessage({ message: text, context, onEdit }: {
  message: string;
  context?: UserPromptContext;
  onEdit?: (text: string, context?: UserPromptContext) => boolean;
}) {
  const paths = context?.images ?? NO_IMAGES;
  const unavailable = !context && replayHasFlattenedContext(text);
  const hasContext = Boolean(context?.blocks.length);
  const row = useRef<HTMLDivElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [draft, setDraft] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (draft !== null || !returnFocus.current) return;
    returnFocus.current = false;
    (editButton.current?.disabled === false ? editButton.current : row.current)?.focus();
  }, [draft]);
  const cancel = () => { returnFocus.current = true; setDraft(null); };
  const toast = useToast();
  const copy = async () => {
    const ok = await copyText(text || [...paths, ...(context?.local.map((item) => item.path) ?? [])].join("\n"));
    toast({ level: ok ? "ok" : "error", title: ok ? "Message copied" : "Could not copy message" });
  };
  return (
    <div ref={row} tabIndex={-1} className="turn-user with-actions">
      <div className="user-msg">
        {paths.length ? <div className="sent-images">{paths.map((path, i) => <AttachmentImage key={`${i}:${path}`} path={path} alt="Attached image" />)}</div> : null}
        {context?.local.map((item) => <div className="sent-image-label" key={item.path} title={item.path}>{item.kind === "folder" ? "Folder" : "File"}: {item.label}</div>)}
        {context?.pickedCount ? <div className="sent-image-label">{context.pickedCount} picked page {context.pickedCount === 1 ? "element" : "elements"}</div> : null}
        {draft === null ? text : (
          <form className="user-msg-edit" onSubmit={(e) => {
            e.preventDefault();
            if ((draft.trim() || hasContext) && (context ? onEdit?.(draft, context) : onEdit?.(draft))) setDraft(null);
          }}>
            <textarea aria-label="Edit sent message" autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && !e.nativeEvent.isComposing) { e.stopPropagation(); cancel(); } }} />
            <div className="user-msg-actions">
              <button type="button" className="btn btn-sm" aria-label="Cancel editing" onClick={cancel}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-primary" disabled={!onEdit || (!draft.trim() && !hasContext)}>Send as new message</button>
            </div>
          </form>
        )}
      </div>
      {draft === null ? (
        <div className="user-msg-actions" role="group" aria-label="Message actions">
          <button ref={editButton} type="button" className="icon-btn icon-btn-sm" aria-label="Edit message" title={unavailable ? "Cannot resend: the saved history does not preserve the original attachment blocks" : "Edit and resend"}
            disabled={!onEdit || unavailable} onClick={() => setDraft(text)}><Icon name="pencil" size={14} /></button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Copy message" title="Copy message"
            onClick={() => void copy()}><Icon name="copy" size={14} /></button>
        </div>
      ) : null}
    </div>
  );
});
