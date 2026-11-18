import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AvailableCommand, ConfigOption, ConfigSelectGroup, ConfigSelectOption, SessionModeState } from "../acp/types";
import { MOD } from "../lib/prefs";
import { Icon, type IconName } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { flattenGroups, groupCommands } from "../acp/commands";
import { adoptNoSessionDraft, draftOf, withDraft, type Drafts } from "./drafts";

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
  /** Open the mode or model picker (the /mode and /model commands). */
  openMenu(kind: "mode" | "model"): void;
}

interface Props {
  /** The session the draft belongs to; each session keeps its own draft. */
  sessionId: string | null;
  busy: boolean;
  /** Why sending is impossible right now; null when it is possible. */
  disabledReason: string | null;
  commands: AvailableCommand[];
  modes: SessionModeState | null;
  model: ConfigOption | undefined;
  sendKey: "enter" | "mod-enter";
  /**
   * Everything the user submits: a command line, plain text, or text for the queue while a turn runs.
   * True when it was handled; the draft is cleared only then (a refused command keeps it).
   */
  onSend: (text: string) => boolean | Promise<boolean>;
  onStop: () => void;
  onMode: (id: string) => void;
  onModel: (configId: string, value: string) => void;
  /** Open the Providers dialog (the provider picker's last item, the same as /connect). */
  onProviders?: () => void;
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

/** The provider a model option belongs to: keryx writes `<provider>/<model>` and describes it with the provider id. */
function providerOf(o: ConfigSelectOption): string {
  if (o.description && o.value.startsWith(`${o.description}/`)) return o.description;
  const i = o.value.indexOf("/");
  return i > 0 ? o.value.slice(0, i) : "";
}

function modelChoices(option: ConfigOption | undefined): ConfigSelectOption[] {
  return (option?.options ?? []).flatMap((o) => (isGroup(o) ? o.options : [o]));
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { sessionId, busy, disabledReason, commands, modes, model, sendKey, onSend, onStop, onMode, onModel, onProviders },
  ref,
) {
  const [drafts, setDrafts] = useState<Drafts>({});
  // A prefill made before the first session exists waits in the no-session slot; the session inherits it.
  useLayoutEffect(() => setDrafts((d) => adoptNoSessionDraft(d, sessionId)), [sessionId]);
  const text = draftOf(drafts, sessionId);
  const setText = (t: string) => setDrafts((d) => withDraft(d, sessionId, t));
  const textRef = useRef(text);
  textRef.current = text;
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [menu, setMenu] = useState<"mode" | "provider" | "model" | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const modeBtn = useRef<HTMLButtonElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const providerBtn = useRef<HTMLButtonElement>(null);
  // The model each provider last ran in this window; picking that provider again returns to it.
  const lastModel = useRef(new Map<string, string>());
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
    openMenu: (kind) => setMenu(kind),
  }));

  // `/` opens the palette over every advertised command, grouped; a space ends the name and closes it.
  const groups = useMemo(() => {
    if (dismissed || !text.startsWith("/") || /\s/.test(text)) return [];
    return groupCommands(commands, text.slice(1));
  }, [text, commands, dismissed]);
  const matches = useMemo(() => flattenGroups(groups), [groups]);

  useEffect(() => setSel(0), [text]);
  useEffect(() => {
    document.getElementById(`slash-opt-${sel}`)?.scrollIntoView?.({ block: "nearest" });
  }, [sel, matches]);
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

  const send = async () => {
    // A command line is trimmed; other text keeps a leading space, which is what makes "/x" text for the model.
    const t = text.startsWith("/") ? text.trim() : text.replace(/^[\r\n]+/, "").trimEnd();
    if (!t.trim() || disabled) return;
    const ok = await onSend(t);
    if (ok && textRef.current === text) setText("");
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
      const exact = matches.some((c) => `/${c.name}` === text);
      if (chosen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !exact))) {
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
      void send();
    } else if (sendKey === "enter" && mod) {
      e.preventDefault();
      void send();
    }
  };

  const choices = useMemo(() => modelChoices(model), [model]);
  const providers = useMemo(() => [...new Set(choices.map(providerOf).filter(Boolean))], [choices]);
  const currentChoice = choices.find((c) => c.value === model?.currentValue);
  const currentProvider = currentChoice ? providerOf(currentChoice) : "";
  if (currentProvider && currentChoice) lastModel.current.set(currentProvider, currentChoice.value);
  const pickProvider = (p: string) => {
    if (!model || p === currentProvider) return;
    const own = choices.filter((c) => providerOf(c) === p);
    const remembered = own.find((c) => c.value === lastModel.current.get(p));
    const target = remembered ?? own[0];
    if (target) onModel(model.id, target.value);
  };
  const providerItems: MenuItem[] = [
    { kind: "header", id: "h", label: "Provider" },
    ...providers.map<MenuItem>((p) => ({ id: p, label: p, checked: p === currentProvider, onSelect: () => pickProvider(p) })),
  ];
  if (onProviders) {
    providerItems.push(
      { kind: "separator", id: "providers-sep" },
      { id: "providers", label: "Add or manage providers…", icon: "plus", onSelect: onProviders },
    );
  }

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
    ? choices
        .filter((x) => !currentProvider || providerOf(x) === currentProvider)
        .map<MenuItem>((x) => ({
          id: x.value,
          label: x.name,
          description: x.description ?? undefined,
          checked: x.value === model.currentValue,
          onSelect: () => onModel(model.id, x.value),
        }))
    : [];

  const sendHint = sendKey === "enter" ? "Return to send · Shift+Return for a new line" : `${MOD}Return to send`;

  return (
    <div className={`composer${disabled ? " is-disabled" : ""}${busy ? " is-busy" : ""}`}>
      {matches.length > 0 ? (
        <ul className="slash-pop" role="listbox" aria-label="Slash commands">
          {groups.map((g) => (
            <li key={g.group} role="presentation" className="slash-group-wrap">
              <div className="slash-group">{g.group}</div>
              <ul role="presentation">
                {g.items.map((c) => {
                  const i = matches.indexOf(c);
                  return (
                    <li
                      key={c.name}
                      id={`slash-opt-${i}`}
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
                      {c.input?.hint ? <span className="slash-hint">{c.input.hint}</span> : null}
                      <span className="slash-desc truncate">{c.description}</span>
                    </li>
                  );
                })}
              </ul>
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
        placeholder={disabledReason ?? (busy ? "keryx is working. Enter queues your next message" : "Ask keryx, or type / for commands")}
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
            ref={providerBtn}
            className="chip-btn"
            onClick={() => setMenu(menu === "provider" ? null : "provider")}
            aria-haspopup="menu"
            aria-expanded={menu === "provider"}
            aria-label="Provider"
            disabled={disabled}
            title="Provider for this session"
          >
            <Icon name="globe" size={13} />
            <span className="truncate chip-model">{currentProvider || "provider"}</span>
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
          <button className="send-btn" onClick={() => void send()} disabled={disabled || !text.trim()} title="Send" aria-label="Send">
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
      {menu === "provider" ? <Menu anchor={providerBtn.current} items={providerItems} onClose={() => setMenu(null)} placement="above" label="Provider" width={260} /> : null}
      {menu === "model" ? <Menu anchor={modelBtn.current} items={modelItems} onClose={() => setMenu(null)} placement="above" label="Model" width={300} /> : null}
    </div>
  );
});
