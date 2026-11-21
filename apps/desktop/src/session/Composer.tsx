import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AvailableCommand, ConfigOption, ConfigSelectGroup, ConfigSelectOption, SessionModeState } from "../acp/types";
import { MOD } from "../lib/prefs";
import { AttachmentImage } from "./AttachmentImage";
import { Icon, type IconName } from "../components/Icon";
import { Menu, type MenuItem } from "../components/Menu";
import { flattenGroups, groupCommands } from "../acp/commands";
import { ContextMeter } from "./ContextMeter";
import type { Usage } from "./reducer";
import { lineCommentRange, type LineComment } from "./lineComments";
import { useChatAttachments, type LocalAttachment, type SaveChatFile, type SaveChatImage } from "./chatImages";
import { adoptNoSessionDraft, draftOf, withDraft, type Drafts } from "./drafts";

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
  /** Open the mode or model picker (the /mode and /model commands). */
  openMenu(kind: "mode" | "model"): void;
  /** Attach a remark on a changed line to the next message (the Changes tab). False when it was not added. */
  addLineComment(comment: LineComment): boolean;
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
  onSend: (text: string, imagePaths: readonly string[], localAttachments: readonly LocalAttachment[], lineComments?: readonly LineComment[]) => boolean | Promise<boolean>;
  saveImage?: SaveChatImage;
  saveFile?: SaveChatFile;
  discardFile?: (path: string) => Promise<void>;
  /** Called with the saved file/image paths that went out with a message the host accepted; the host now owns them. */
  onAttachmentsSent?: (paths: readonly string[]) => void;
  loadImage?: (path: string) => Promise<string>;
  pickAttachmentFolder?: () => Promise<string | null>;
  /** Ranked project-relative paths for an `@` mention query (the caller caps the list; a bare `@` is a query too). Without it `@` does nothing. */
  searchFiles?: (query: string) => Promise<string[]>;
  onStop: () => void;
  onMode: (id: string) => void;
  onModel: (configId: string, value: string) => void;
  /** Open the Providers dialog (the provider picker's last item, the same as /connect). */
  onProviders?: () => void;
  /** Context that goes out with the next message (page elements picked in the browser panel). */
  attachments?: readonly ComposerAttachment[];
  onRemoveAttachment?: (key: number) => void;
  /** Context fill for the toolbar gauge; with `onCompact` and `onDetails` it shows its menu. */
  usage?: Usage | null;
  onCompact?: () => void;
  onDetails?: () => void;
}

export interface ComposerAttachment {
  key: number;
  label: string;
  /** Tooltip: where it came from. */
  title?: string;
}

export const COMPOSER_MAX_PX = 260;

/** An empty box stays at its CSS minimum: the wrapped placeholder must never size it. */
export function fitComposerHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  if (el.value === "") {
    el.style.height = "";
    return;
  }
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`;
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
export function providerOf(o: ConfigSelectOption): string {
  if (o.description && o.value.startsWith(`${o.description}/`)) return o.description;
  const i = o.value.indexOf("/");
  return i > 0 ? o.value.slice(0, i) : "";
}

export function modelChoices(option: ConfigOption | undefined): ConfigSelectOption[] {
  return (option?.options ?? []).flatMap((o) => (isGroup(o) ? o.options : [o]));
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { sessionId, busy, disabledReason, commands, modes, model, sendKey, onSend, saveImage, saveFile, discardFile, onAttachmentsSent, loadImage, pickAttachmentFolder, searchFiles, onStop, onMode, onModel, onProviders, attachments = [], onRemoveAttachment, usage, onCompact, onDetails },
  ref,
) {
  const [drafts, setDrafts] = useState<Drafts>({});
  // A prefill made before the first session exists waits in the no-session slot; the session inherits it.
  useLayoutEffect(() => setDrafts((d) => adoptNoSessionDraft(d, sessionId)), [sessionId]);
  const text = draftOf(drafts, sessionId);
  const setText = (t: string) => setDrafts((d) => withDraft(d, sessionId, t));
  const [sel, setSel] = useState(0);
  const listId = useId();
  const [dismissed, setDismissed] = useState(false);
  const [slashSession, setSlashSession] = useState<string | null>(null);
  useLayoutEffect(() => setSlashSession(null), [sessionId]);
  const showAllCommands = sessionId !== null && slashSession === sessionId;
  const [menu, setMenu] = useState<"add" | "mode" | "provider" | "model" | null>(null);
  const addBtn = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const modeBtn = useRef<HTMLButtonElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const providerBtn = useRef<HTMLButtonElement>(null);
  // The model each provider last ran in this window; picking that provider again returns to it.
  const lastModel = useRef(new Map<string, string>());
  const disabled = disabledReason !== null;
  const localDraft = useChatAttachments(sessionId, { saveImage, saveFile, discardFile, pickFolder: pickAttachmentFolder });
  const hasAttachments = attachments.length > 0 || localDraft.items.length > 0;
  // Saved copies the user never sent are deleted when the draft goes away (unmount or switch to another session).
  const latestItems = useRef(localDraft.items);
  const sentPaths = useRef(new Set<string>());
  const discardRef = useRef(discardFile);
  // Incremented every time a draft is dropped (session switch, unmount): a send that began earlier and is refused
  // afterwards compares it, so A -> B -> A is told apart from "never left A".
  const draftGen = useRef(0);
  const dropDraft = localDraft.drop;
  // Refs are written after commit, never during render. Effect cleanups of a session switch run before this one,
  // so at cleanup time `latestItems` still holds the old session's items.
  useEffect(() => {
    latestItems.current = localDraft.items;
    discardRef.current = discardFile;
  });
  useEffect(() => {
    if (!sessionId) return;
    return () => {
      draftGen.current += 1;
      const items = latestItems.current;
      for (const item of items) {
        const sent = sentPaths.current.has(item.path);
        sentPaths.current.delete(item.path);
        if (item.kind === "folder" || item.kind === "line-comment" || sent) continue;
        void discardRef.current?.(item.path)?.catch(() => {});
      }
      dropDraft(sessionId);
    };
  }, [sessionId, dropDraft]);

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
    addLineComment: localDraft.addLineComment,
  }));

  // `/` opens the palette over every advertised command, grouped; a space ends the name and closes it.
  const groups = useMemo(() => {
    if (disabled || menu === "add") return [];
    if (showAllCommands) return groupCommands(commands, "");
    if (dismissed || !text.startsWith("/") || /\s/.test(text)) return [];
    return groupCommands(commands, text.slice(1));
  }, [text, commands, dismissed, disabled, menu, showAllCommands]);
  const commandMatches = useMemo(() => flattenGroups(groups), [groups]);

  // `@word` ending at the caret (at the start or after whitespace) opens a file picker over the same popup.
  const [caret, setCaret] = useState(0);
  // Results are tagged with the query they answer, so a stale list is never shown or selectable.
  const [found, setFound] = useState<{ query: string; files: string[] } | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const searchRef = useRef(searchFiles);
  useEffect(() => {
    searchRef.current = searchFiles;
  });
  const slashMode = text.startsWith("/") && !/\s/.test(text);
  const mention = useMemo(() => {
    if (!searchFiles || disabled || menu === "add" || showAllCommands || slashMode || dismissed) return null;
    const m = /(^|\s)@(\S*)$/.exec(text.slice(0, Math.min(caret, text.length)));
    return m ? { start: m.index + (m[1] ?? "").length, query: m[2] ?? "" } : null;
  }, [text, caret, searchFiles, disabled, menu, showAllCommands, slashMode, dismissed]);
  const mentionQuery = mention ? mention.query : null;
  useEffect(() => {
    if (mentionQuery === null) {
      setFound((f) => (f ? null : f));
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      const search = searchRef.current;
      if (!search) return;
      search(mentionQuery).then(
        (r) => { if (!stale) setFound({ query: mentionQuery, files: r }); },
        () => { if (!stale) setFound(null); },
      );
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [mentionQuery]);
  const mentionFiles = mention && commandMatches.length === 0 && found?.query === mention.query ? found.files : [];
  const matches: ReadonlyArray<AvailableCommand | string> = mentionFiles.length > 0 ? mentionFiles : commandMatches;
  const active = Math.min(sel, matches.length - 1);

  useEffect(() => setSel(0), [text]);
  useEffect(() => {
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, matches, listId]);
  // Grow with the text up to COMPOSER_MAX_PX. Re-fit when the column's width changes too: a narrow moment (a side
  // panel opening, a drag) wraps the text, and a height measured then must not outlive it.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    fitComposerHeight(el);
    if (typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitComposerHeight(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  useEffect(() => {
    if (!disabled) area.current?.focus();
  }, [disabled]);

  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    area.current?.setSelectionRange(at, at);
  }, [text]);

  const completeMention = (path: string) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(Math.min(caret, text.length));
    const insert = `@${path} `;
    pendingCaret.current = before.length + insert.length;
    setText(`${before}${insert}${after}`);
    setCaret(before.length + insert.length);
    area.current?.focus();
  };

  const complete = (c: AvailableCommand) => {
    const suffix = showAllCommands ? (text.startsWith("/") ? text.match(/\s[\s\S]*/)?.[0] ?? " " : ` ${text}`) : " ";
    setText(`/${c.name}${suffix}`);
    setSlashSession(null);
    setDismissed(false);
    area.current?.focus();
  };

  const send = async () => {
    // A command line is trimmed; other text keeps a leading space, which is what makes "/x" text for the model.
    const t = text.startsWith("/") ? text.trim() : text.replace(/^[\r\n]+/, "").trimEnd();
    if ((!t.trim() && !hasAttachments) || disabled) return;
    if (localDraft.isSaving()) {
      localDraft.warn("Wait for the attachments to finish, then send again.");
      return;
    }
    const images = localDraft.items.flatMap((item) => item.kind === "image" ? [item.path] : []);
    const local = localDraft.items.flatMap((item) => item.kind === "file" || item.kind === "folder" ? [item] : []);
    const comments = localDraft.items.flatMap((item) => item.kind === "line-comment" ? [item.comment] : []);
    const sentFiles = localDraft.items.filter((item) => item.kind === "image" || item.kind === "file").map((item) => item.path);
    for (const p of sentFiles) sentPaths.current.add(p);
    const gen = draftGen.current;
    let ok = false;
    try {
      // The comments argument is only passed when there are some, so a send without them looks as it always did.
      ok = await (comments.length > 0 ? onSend(t, images, local, comments) : onSend(t, images, local));
    } finally {
      if (!ok) {
        for (const p of sentFiles) sentPaths.current.delete(p);
        // The draft is gone (the session was switched or the view closed while this send was pending), so nothing
        // else will discard these files.
        if (draftGen.current !== gen) for (const p of sentFiles) void discardRef.current?.(p)?.catch(() => {});
      }
    }
    if (ok) {
      setSlashSession(null);
      if (sentFiles.length > 0) onAttachmentsSent?.(sentFiles);
      for (const p of sentFiles) sentPaths.current.delete(p);
      localDraft.remove(localDraft.items.map((item) => item.path));
      setDrafts((d) => draftOf(d, sessionId) === text ? withDraft(d, sessionId, "") : d);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (Math.min(s, matches.length - 1) + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (Math.min(s, matches.length - 1) - 1 + matches.length) % matches.length);
        return;
      }
      const chosen = matches[active];
      const exact = commandMatches.some((c) => `/${c.name}` === text);
      const isFile = typeof chosen === "string";
      if (chosen && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && (isFile || showAllCommands || !exact)))) {
        e.preventDefault();
        if (typeof chosen === "string") completeMention(chosen);
        else complete(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashSession(null);
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
      {mentionFiles.length > 0 ? (
        <ul id={listId} className="slash-pop" role="listbox" aria-label="File mentions">
          <li role="presentation" className="slash-group-wrap">
            <div className="slash-group">Files</div>
            <ul role="presentation">
              {mentionFiles.map((path, i) => {
                const cut = path.lastIndexOf("/") + 1;
                return (
                  <li
                    key={path}
                    id={`${listId}-opt-${i}`}
                    role="option"
                    aria-selected={i === active}
                    className={i === active ? "is-sel" : ""}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      completeMention(path);
                    }}
                    onMouseMove={() => i !== active && setSel(i)}
                  >
                    <span className="slash-name truncate" title={path}>
                      @<span style={{ opacity: 0.6, fontWeight: 400 }}>{path.slice(0, cut)}</span>{path.slice(cut)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </li>
        </ul>
      ) : commandMatches.length > 0 ? (
        <ul id={listId} className="slash-pop" role="listbox" aria-label="Slash commands">
          {groups.map((g) => (
            <li key={g.group} role="presentation" className="slash-group-wrap">
              <div className="slash-group">{g.group}</div>
              <ul role="presentation">
                {g.items.map((c) => {
                  const i = commandMatches.indexOf(c);
                  return (
                    <li
                      key={c.name}
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? "is-sel" : ""}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        complete(c);
                      }}
                      onMouseMove={() => i !== active && setSel(i)}
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
      {attachments.length > 0 ? (
        <ul className="composer-attachments" aria-label="Attached page elements">
          {attachments.map((a) => (
            <li key={a.key} className="attach-chip" title={a.title}>
              <Icon name="pick" size={12} />
              <span className="truncate">{a.label}</span>
              {onRemoveAttachment ? (
                <button className="icon-btn icon-btn-sm" onClick={() => onRemoveAttachment(a.key)} aria-label={`Remove ${a.label}`} title="Remove">
                  <Icon name="x" size={10} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {localDraft.items.length > 0 ? (
        <ul className="composer-attachments" aria-label="Local attachments">
          {localDraft.items.map((item, i) => (
            <li className={`attach-chip${item.kind === "image" ? " image-chip" : ""}${item.kind === "line-comment" ? " comment-chip" : ""}`} key={item.path}
              title={item.kind === "image" ? undefined : item.kind === "line-comment" ? item.comment.text : item.path}>
              {item.kind === "image" ? <AttachmentImage path={item.path} alt={`Attached image ${i + 1}`} eager load={loadImage} /> : item.kind === "line-comment" ? <>
                <Icon name="comment" size={12} />
                <span className="truncate">{lineCommentRange(item.comment)} {item.comment.text}</span>
              </> : <>
                <Icon name={item.kind === "folder" ? "folder" : "file"} size={12} />
                <span className="truncate">{item.label}</span>
              </>}
              <button type="button" className="icon-btn icon-btn-sm" disabled={localDraft.pending} onClick={() => void localDraft.discard(item)}
                aria-label={`Remove ${item.kind === "image" ? `image ${i + 1}` : item.kind === "line-comment" ? `comment on ${lineCommentRange(item.comment)}` : item.label}`} title="Remove attachment"><Icon name="x" size={12} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      {localDraft.pending || localDraft.error ? (
        <div className="composer-image-status" role={localDraft.error ? "alert" : "status"}>
          {localDraft.error ?? "Adding attachments…"}
        </div>
      ) : null}
      <textarea
        ref={area}
        rows={1}
        value={text}
        disabled={disabled}
        aria-label="Message keryx"
        role={matches.length > 0 ? "combobox" : undefined}
        aria-autocomplete={matches.length > 0 ? "list" : undefined}
        aria-expanded={matches.length > 0 ? true : undefined}
        aria-controls={matches.length > 0 ? listId : undefined}
        aria-activedescendant={matches.length > 0 ? `${listId}-opt-${active}` : undefined}
        placeholder={disabledReason ?? (busy ? `keryx is working. ${sendKey === "enter" ? "Enter" : `${MOD}Return`} queues your next message` : "Ask keryx, or type / for commands")}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setSlashSession(null);
          setDismissed(false);
        }}
        onPaste={(e) => {
          if (!saveImage || disabled || !sessionId) return;
          const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          if (!files.length) return;
          if (!e.clipboardData.getData("text/plain")) e.preventDefault();
          void localDraft.addFiles(files, true);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
      />
      <input key={sessionId} ref={fileInput} type="file" multiple hidden
        aria-label="Choose files or images" accept={saveFile ? undefined : "image/*"}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (!disabled) void localDraft.addFiles(files);
          area.current?.focus();
        }} />
      <div className="composer-bar">
        <button type="button" ref={addBtn} className="icon-btn composer-add" aria-label="Add to message"
          title="Add attachments or slash commands" aria-haspopup="menu" aria-expanded={menu === "add"}
          disabled={disabled} onClick={() => setMenu(menu === "add" ? null : "add")}>
          <Icon name="plus" size={18} />
        </button>
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
            <span className="truncate" title={currentMode?.name ?? modes.currentModeId}>{currentMode?.name ?? modes.currentModeId}</span>
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
            <span className="truncate chip-model" title={currentProvider || "provider"}>{currentProvider || "provider"}</span>
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
            <span className="truncate chip-model" title={modelName(model)}>{modelName(model)}</span>
            <Icon name="chevronDown" size={11} />
          </button>
        ) : null}
        <div className="grow" />
        {onCompact && onDetails ? <ContextMeter usage={usage} busy={busy} onCompact={onCompact} onDetails={onDetails} /> : null}
        <span className="composer-hint truncate" title={disabled ? undefined : sendHint}>{disabled ? (text ? disabledReason : "") : busy ? "esc to stop" : sendHint}</span>
        {busy ? (
          <button className="send-btn is-stop" onClick={onStop} title="Stop the current turn (Esc)" aria-label="Stop">
            <Icon name="stop" size={12} strokeWidth={0} className="filled" />
          </button>
        ) : (
          <button className="send-btn" onClick={() => void send()} disabled={disabled || localDraft.pending || (!text.trim() && !hasAttachments)} title="Send" aria-label="Send">
            <Icon name="arrowUp" size={16} strokeWidth={2.25} />
          </button>
        )}
      </div>
      {menu === "add" && !disabled ? (
        <Menu anchor={addBtn.current} placement="above" label="Add to message" width={240}
          onClose={() => { setMenu(null); addBtn.current?.focus(); }}
          items={[
            { id: "files", label: "Add files or images", icon: "file", disabled: (!saveFile && !saveImage) || localDraft.pending,
              onSelect: () => fileInput.current?.click() },
            { id: "folder", label: "Add folder", icon: "folder", disabled: !pickAttachmentFolder || localDraft.pending,
              onSelect: () => void localDraft.addFolder() },
            { kind: "separator", id: "commands-separator" },
            { id: "commands", label: "Slash commands", icon: "command", disabled: !sessionId || commands.length === 0,
              onSelect: () => { setSel(0); setSlashSession(sessionId); area.current?.focus(); } },
          ]} />
      ) : null}
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
