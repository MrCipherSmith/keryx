import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { AvailableCommand, ConfigOption, ConfigSelectGroup, ConfigSelectOption, SessionModeState } from "../acp/types";
import { MOD } from "../lib/prefs";
import { Icon, type IconName } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
}

interface Props {
  busy: boolean;
  /** Why sending is impossible right now; null when it is possible. */
  disabledReason: string | null;
  commands: AvailableCommand[];
  modes: SessionModeState | null;
  model: ConfigOption | undefined;
  sendKey: "enter" | "mod-enter";
  onSend: (text: string) => void;
  onStop: () => void;
  onMode: (id: string) => void;
  onModel: (configId: string, value: string) => void;
}

const MODE_ICON: Record<string, IconName> = { ask: "shield", trust: "shieldCheck", auto: "sparkle" };

function isGroup(o: ConfigSelectOption | ConfigSelectGroup): o is ConfigSelectGroup {
  return "group" in o && Array.isArray((o as ConfigSelectGroup).options);
}

function modelName(option: ConfigOption): string {
  for (const o of option.options) {
    if (isGroup(o)) {
      const hit = o.options.find((x) => x.value === option.currentValue);
      if (hit) return hit.name;
    } else if (o.value === option.currentValue) return o.name;
  }
  return option.currentValue;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { busy, disabledReason, commands, modes, model, sendKey, onSend, onStop, onMode, onModel },
  ref,
) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [menu, setMenu] = useState<"mode" | "model" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const modeBtn = useRef<HTMLButtonElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const disabled = disabledReason !== null;

  useImperativeHandle(ref, () => ({
    focus: () => area.current?.focus(),
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = area.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(t.length, t.length);
      });
    },
  }));

  const matches = useMemo(() => {
    if (dismissed || !text.startsWith("/") || /\s/.test(text)) return [];
    const q = text.slice(1).toLowerCase();
    return commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
  }, [text, commands, dismissed]);

  useEffect(() => setSel(0), [text]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);
  useEffect(() => {
    if (!disabled) area.current?.focus();
  }, [disabled]);

  const complete = (c: AvailableCommand) => {
    setText(`/${c.name} `);
    setDismissed(false);
    area.current?.focus();
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
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + matches.length) % matches.length);
        return;
      }
      const chosen = matches[sel];
      if (chosen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text !== `/${chosen.name}`))) {
        e.preventDefault();
        complete(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Escape" && busy) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key !== "Enter") return;
    const mod = e.metaKey || e.ctrlKey;
    if (sendKey === "enter" ? !e.shiftKey && !mod : mod) {
      e.preventDefault();
      send();
    } else if (sendKey === "enter" && mod) {
      e.preventDefault();
      send();
    }
  };

  const currentMode = modes?.availableModes.find((m) => m.id === modes.currentModeId);
  const modeItems: MenuItem[] = [
    { kind: "header", id: "h", label: "Permission mode for this session" },
    ...(modes?.availableModes ?? []).map<MenuItem>((m) => ({
      id: m.id,
      label: m.name,
      description: m.description ?? undefined,
      checked: m.id === modes?.currentModeId,
      onSelect: () => m.id !== modes?.currentModeId && onMode(m.id),
    })),
  ];
  const modelItems: MenuItem[] = model
    ? model.options.flatMap<MenuItem>((o) =>
        isGroup(o)
          ? [
              { kind: "header", id: `g-${o.group}`, label: o.name },
              ...o.options.map<MenuItem>((x) => ({
                id: `${o.group}-${x.value}`,
                label: x.name,
                description: x.description ?? undefined,
                checked: x.value === model.currentValue,
                onSelect: () => onModel(model.id, x.value),
              })),
            ]
          : [
              {
                id: o.value,
                label: o.name,
                description: o.description ?? undefined,
                checked: o.value === model.currentValue,
                onSelect: () => onModel(model.id, o.value),
              },
            ],
      )
    : [];

  const sendHint = sendKey === "enter" ? "Return to send · Shift+Return for a new line" : `${MOD}Return to send`;

  return (
    <div className={`composer${disabled ? " is-disabled" : ""}${busy ? " is-busy" : ""}`}>
      {matches.length > 0 ? (
        <ul className="slash-pop" role="listbox" aria-label="Slash commands">
          {matches.map((c, i) => (
            <li
              key={c.name}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "is-sel" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(c);
              }}
              onMouseMove={() => i !== sel && setSel(i)}
            >
              <span className="slash-name">/{c.name}</span>
              <span className="slash-desc truncate">{c.description}</span>
              {c.input?.hint ? <span className="slash-hint">{c.input.hint}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={area}
        rows={1}
        value={text}
        disabled={disabled}
        aria-label="Message keryx"
        placeholder={disabledReason ?? (busy ? "keryx is working — you can draft the next message" : "Ask keryx, or type / for commands")}
        onChange={(e) => {
          setText(e.target.value);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="composer-bar">
        {modes && modes.availableModes.length > 0 ? (
          <button
            ref={modeBtn}
            className={`chip-btn mode-${modes.currentModeId}`}
            onClick={() => setMenu(menu === "mode" ? null : "mode")}
            aria-haspopup="menu"
            aria-expanded={menu === "mode"}
            disabled={disabled}
            title={`${currentMode?.description ?? "Permission mode"} — applies to this session only; it is not saved as the project default.`}
          >
            <Icon name={MODE_ICON[modes.currentModeId] ?? "shield"} size={13} />
            {currentMode?.name ?? modes.currentModeId}
            <Icon name="chevronDown" size={11} />
          </button>
        ) : null}
        {model ? (
          <button
            ref={modelBtn}
            className="chip-btn"
            onClick={() => setMenu(menu === "model" ? null : "model")}
            aria-haspopup="menu"
            aria-expanded={menu === "model"}
            disabled={disabled}
            title="Model for this session"
          >
            <Icon name="sparkle" size={13} />
            <span className="truncate chip-model">{modelName(model)}</span>
            <Icon name="chevronDown" size={11} />
          </button>
        ) : null}
        <div className="grow" />
        <span className="composer-hint truncate">{disabled ? (text ? disabledReason : "") : busy ? "esc to stop" : sendHint}</span>
        {busy ? (
          <button className="send-btn is-stop" onClick={onStop} title="Stop the current turn (Esc)" aria-label="Stop">
            <Icon name="stop" size={12} strokeWidth={0} className="filled" />
          </button>
        ) : (
          <button className="send-btn" onClick={send} disabled={disabled || !text.trim()} title="Send" aria-label="Send">
            <Icon name="arrowUp" size={16} strokeWidth={2.25} />
          </button>
        )}
      </div>
      {menu === "mode" ? (
        <Menu
          anchor={modeBtn.current}
          items={modeItems}
          onClose={() => setMenu(null)}
          placement="above"
          label="Permission mode"
          width={320}
          footer="Applies to this session only. The project default does not change."
        />
      ) : null}
      {menu === "model" ? <Menu anchor={modelBtn.current} items={modelItems} onClose={() => setMenu(null)} placement="above" label="Model" width={300} /> : null}
    </div>
  );
});
