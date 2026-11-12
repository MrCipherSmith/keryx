import type { NormalizedMessage } from "../harness/provider/types";
import { resumedConversation, type ConversationEntry } from "./conversation-history";
import { openModal, type ModalChrome, type ModalHandle } from "./modal-host";
import { getTheme } from "./theme";
import { boldChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Match = { entry: number; start: number; end: number };

export function isHistoryShortcut(key: { name: string; ctrl: boolean; shift?: boolean; meta: boolean }): boolean {
  return key.name.toLowerCase() === "h" && key.ctrl && key.shift === true && !key.meta;
}

export function appendConversationPreview(otui: OpenTui, chrome: ModalChrome & { transcript: Box }, history: readonly NormalizedMessage[]): void {
  const entries = resumedConversation(history);
  if (entries.length === 0) return;
  const add = (text: string, fg: string) => chrome.transcript.add(new otui.TextRenderable(chrome.renderer, {
    content: text, fg, width: "100%", wrapMode: "word", flexShrink: 0,
  }));
  add("Last turn", getTheme().muted);
  for (const { label, text } of entries) add(`${label}: ${text}`, getTheme().text);
}

export function openHistoryModal(otui: OpenTui, chrome: ModalChrome, entries: readonly ConversationEntry[]): ModalHandle | undefined {
  const r = chrome.renderer;
  let query = "";
  let move = (_delta: number): void => {};
  let scrollPage = (_delta: number): void => {};
  let selected = 0;
  return openModal(otui, chrome, {
    title: "Session history",
    tabs: [{ id: "history", label: "History" }],
    toolbar: true,
    footer: [{ key: "↑/↓", label: "matches or scroll" }, { key: "PgUp/PgDn", label: "scroll" }, { key: "Esc", label: "close" }],
    claimKey: (key) => {
      switch (key.name) {
        case "up": move(-1); return true;
        case "down": move(1); return true;
        case "pageup": scrollPage(-1); return true;
        case "pagedown": scrollPage(1); return true;
        default: return false;
      }
    },
    renderTab: (_tab, target, { toolbar }) => {
      if (toolbar === undefined) return;
      const { controls, scroll } = toolbar;
      const theme = getTheme();
      const body = target as Box;
      const field = new otui.InputRenderable(r, {
        id: "history-search",
        value: query,
        placeholder: "Search history",
        flexGrow: 1,
        minWidth: 4,
        textColor: theme.text,
        focusedTextColor: theme.text,
        cursorColor: theme.focus,
      });
      const count = new otui.TextRenderable(r, { id: "history-count", fg: theme.muted, flexShrink: 0 });
      const rows = entries.map((entry, index) => {
        body.add(new otui.TextRenderable(r, {
          id: `history-role-${index}`,
          content: otui.t`${boldChunk(otui, entry.label)}`,
          marginTop: index === 0 ? 0 : 1,
          flexShrink: 0,
        }));
        const row = new otui.TextRenderable(r, {
          id: `history-entry-${index}`,
          content: entry.text,
          fg: theme.text,
          width: "100%",
          wrapMode: "word",
          flexShrink: 0,
        });
        body.add(row);
        return row;
      });
      if (rows.length === 0) {
        body.add(new otui.TextRenderable(r, { content: "This session has no messages yet.", fg: theme.muted }));
      }

      let matches: Match[] = [];
      let painted: Match | undefined;
      let pendingFrame: (() => void) | undefined;
      const afterLayout = (action: () => void): void => {
        if (pendingFrame !== undefined) r.off(otui.CliRenderEvents.FRAME, pendingFrame);
        pendingFrame = () => {
          pendingFrame = undefined;
          action();
        };
        r.once(otui.CliRenderEvents.FRAME, pendingFrame);
        r.requestRender();
      };
      const showMatch = (): void => {
        if (painted !== undefined) rows[painted.entry]!.content = entries[painted.entry]!.text;
        painted = matches[selected];
        count.content = query.trim().length === 0 ? "" : painted === undefined ? " No matches" : ` ${selected + 1}/${matches.length}`;
        if (painted === undefined) {
          if (pendingFrame !== undefined) r.off(otui.CliRenderEvents.FRAME, pendingFrame);
          pendingFrame = undefined;
          return;
        }
        const { entry, start, end } = painted;
        const row = rows[entry]!;
        const text = entries[entry]!.text;
        const highlighted = otui.bg(theme.focus)(otui.fg(theme.panel)(text.slice(start, end)));
        row.content = otui.t`${text.slice(0, start)}${highlighted}${text.slice(end)}`;
        afterLayout(() => {
          // The hit can be far below the start of a long, wrapped message.
          const prefix = text.slice(0, start).split("\n");
          const sourceLine = prefix.length - 1;
          const column = Bun.stringWidth(prefix[sourceLine]!);
          const { lineSources, lineStartCols } = row.lineInfo;
          const firstLine = lineSources.indexOf(sourceLine);
          let visualLine = Math.max(0, firstLine);
          const startColumn = lineStartCols[visualLine] ?? 0;
          while (lineSources[visualLine + 1] === sourceLine
            && lineStartCols[visualLine + 1]! - startColumn <= column) visualLine++;
          scroll.scrollTop += row.y - scroll.viewport.y + visualLine;
        });
      };
      const search = (value: string, reset: boolean): void => {
        query = value;
        const needle = query.trim();
        matches = [];
        if (needle !== "") {
          const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
          entries.forEach(({ text }, entry) => {
            for (const hit of text.matchAll(pattern)) {
              matches.push({ entry, start: hit.index, end: hit.index + hit[0].length });
            }
          });
        }
        selected = reset || selected >= matches.length ? 0 : selected;
        showMatch();
      };
      const submit = (): void => {
        search(field.value, field.value !== query);
        field.focus();
      };
      controls.add(field);
      controls.add(new otui.TextRenderable(r, {
        id: "history-find",
        content: " [Find]",
        fg: theme.focus,
        flexShrink: 0,
        onMouseDown: (event) => {
          event.preventDefault();
          event.stopPropagation();
          submit();
        },
      }));
      controls.add(count);
      field.on(otui.InputRenderableEvents.INPUT, () => search(field.value, true));
      field.on(otui.InputRenderableEvents.ENTER, submit);
      field.focus();
      move = (delta) => {
        if (matches.length === 0) scroll.scrollBy(delta);
        else {
          selected = (selected + delta + matches.length) % matches.length;
          showMatch();
        }
      };
      scrollPage = (delta) => scroll.scrollBy(delta * Math.max(1, scroll.viewport.height - 1));
      search(query, false);
      if (matches.length === 0) afterLayout(() => { scroll.scrollTop = scroll.scrollHeight; });
      return () => {
        if (pendingFrame !== undefined) r.off(otui.CliRenderEvents.FRAME, pendingFrame);
      };
    },
  });
}
