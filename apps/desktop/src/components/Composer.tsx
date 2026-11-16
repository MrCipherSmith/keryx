import { useEffect, useMemo, useRef, useState } from "react";
import type { AvailableCommand } from "../acp/types";

interface Props {
  busy: boolean;
  disabled: boolean;
  commands: AvailableCommand[];
  onSend: (text: string) => void;
  onStop: () => void;
  /** Text to put in the composer (never sent automatically); a new nonce re-applies it. */
  draft?: { text: string; nonce: number } | null;
}

export function Composer({ busy, disabled, commands, onSend, onStop, draft }: Props) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const matches = useMemo(() => {
    if (dismissed || !text.startsWith("/") || /\s/.test(text)) return [];
    const q = text.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
  }, [text, commands, dismissed]);

  useEffect(() => setSel(0), [text]);
  useEffect(() => {
    if (!draft) return;
    setText(draft.text);
    area.current?.focus();
  }, [draft]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  useEffect(() => {
    if (!disabled) area.current?.focus();
  }, [disabled]);

  const complete = (c: AvailableCommand) => {
    setText(`/${c.name} `);
    setDismissed(false);
  };

  const send = () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    onSend(t);
    setText("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (matches.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + matches.length) % matches.length); return; }
      const chosen = matches[sel];
      if (chosen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text !== `/${chosen.name}`))) {
        e.preventDefault();
        complete(chosen);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      {matches.length > 0 ? (
        <ul className="slash" role="listbox">
          {matches.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "sel" : ""}
              onMouseDown={(e) => { e.preventDefault(); complete(c); }}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc">{c.description}</span>
              {c.input?.hint ? <span className="slash-hint">{c.input.hint}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="composer-row">
        <textarea
          ref={area}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? "keryx is not running" : "Message keryx   (Enter to send, Shift+Enter for a new line, / for commands)"}
          onChange={(e) => { setText(e.target.value); setDismissed(false); }}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button className="btn btn-stop" onClick={onStop} title="Stop the current turn">Stop</button>
        ) : (
          <button className="btn btn-primary" onClick={send} disabled={disabled || !text.trim()}>Send</button>
        )}
      </div>
    </div>
  );
}
