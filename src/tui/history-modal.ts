import type { NormalizedMessage } from "../harness/provider/types";
import { resumedConversation } from "./conversation-history";
import { HistoryReader, type HistorySearch, type HistorySnapshot } from "./history-reader";
import { clearTranscriptChildren } from "./transcript-blocks";
import { openModal, type ModalChrome, type ModalHandle } from "./modal-host";
import { getTheme } from "./theme";
import { boldChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");
type Box = InstanceType<OpenTui["BoxRenderable"]>;
type Match = NonNullable<Awaited<ReturnType<HistorySearch["locate"]>>>;
const PAGE = 20;

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

export function openHistoryModal(otui: OpenTui, chrome: ModalChrome, snapshot: HistorySnapshot): ModalHandle | undefined {
  const r = chrome.renderer;
  let move = (_delta: number): void => {};
  let scrollPage = (_delta: number): void => {};
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
        placeholder: "Search history",
        flexGrow: 1,
        minWidth: 4,
        textColor: theme.text,
        focusedTextColor: theme.text,
        cursorColor: theme.focus,
      });
      const count = new otui.TextRenderable(r, { id: "history-count", fg: theme.muted, flexShrink: 0 });
      const lifetime = new AbortController();
      const ready = HistoryReader.open(snapshot, lifetime.signal);
      let reader: HistoryReader | undefined;
      let query = "";
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let searching: AbortController | undefined;
      let results: HistorySearch | undefined;
      let selected = 0;
      let selection = 0;
      let currentMatch: Match | undefined;
      let windowStart = 0;
      let pendingView = 0;
      let loadingView = false;
      let matchingView = false;
      let lastScrollTop = 0;
      let afterLayout: (() => void) | undefined;
      type Row = { view: InstanceType<OpenTui["TextRenderable"]>; index: number; entry: number; start: number; text: string };
      let rows: Row[] = [];
      const hint = (content: string): void => {
        body.add(new otui.TextRenderable(r, { content, fg: theme.muted, flexShrink: 0 }));
      };
      hint("Loading history…");

      const overlaps = (row: Row, match: Match | undefined): match is Match =>
        match?.entry === row.entry && match.end > row.start && match.start < row.start + row.text.length;
      const mark = (row: Row, match: Match | undefined): void => {
        if (!overlaps(row, match)) {
          row.view.content = row.text;
          return;
        }
        const start = Math.max(0, match.start - row.start);
        const end = match.end - row.start;
        const highlighted = otui.bg(theme.focus)(otui.fg(theme.panel)(row.text.slice(start, end)));
        row.view.content = otui.t`${row.text.slice(0, start)}${highlighted}${row.text.slice(end)}`;
      };
      const repaintMatch = (match: Match | undefined): void => {
        for (const row of rows) {
          if (overlaps(row, currentMatch) || overlaps(row, match)) mark(row, match);
        }
        currentMatch = match;
      };
      const scrollToMatch = (match: Match): void => {
        const row = rows.find((item) => item.index === match.fragment);
        if (row === undefined) return;
        const prefix = row.text.slice(0, match.start - row.start).split("\n");
        const sourceLine = prefix.length - 1;
        const column = Bun.stringWidth(prefix[sourceLine]!);
        const { lineSources, lineStartCols } = row.view.lineInfo;
        let visualLine = Math.max(0, lineSources.indexOf(sourceLine));
        const startColumn = lineStartCols[visualLine] ?? 0;
        while (lineSources[visualLine + 1] === sourceLine
          && lineStartCols[visualLine + 1]! - startColumn <= column) visualLine++;
        scroll.scrollTop += row.view.y - scroll.viewport.y + visualLine;
      };
      const maxStart = (): number => Math.max(0, (reader?.length ?? 0) - PAGE);
      const showWindow = async (start: number, position: "end" | "anchor" | Match): Promise<void> => {
        if (reader === undefined) return;
        const request = ++pendingView;
        loadingView = true;
        matchingView = typeof position !== "string";
        afterLayout = undefined;
        try {
          const page = await reader.page(start, Math.min(start + PAGE, reader.length), lifetime.signal);
          if (request !== pendingView || lifetime.signal.aborted) return;
          const anchor = position === "anchor"
            ? rows.find((row) => row.index >= start && row.index < start + PAGE
              && row.view.y + row.view.height > scroll.viewport.y)
            : undefined;
          const anchorY = anchor === undefined ? 0 : anchor.view.y - scroll.viewport.y;
          clearTranscriptChildren(body);
          rows = page.map(({ index, entry, start: offset, label, text }) => {
            if (label !== "") {
              body.add(new otui.TextRenderable(r, {
                content: otui.t`${boldChunk(otui, label)}`,
                marginTop: index === start ? 0 : 1,
                flexShrink: 0,
              }));
            }
            const view = new otui.TextRenderable(r, {
              id: `history-entry-${index}`, content: text, fg: theme.text,
              width: "100%", wrapMode: "word", flexShrink: 0,
            });
            body.add(view);
            const row = { view, index, entry, start: offset, text };
            if (overlaps(row, currentMatch)) mark(row, currentMatch);
            return row;
          });
          if (page.length === 0) hint("This session has no messages yet.");
          const shiftedEarlier = start < windowStart;
          windowStart = start;
          afterLayout = () => {
            if (position === "end") scroll.scrollTop = scroll.scrollHeight;
            else if (typeof position !== "string") scrollToMatch(position);
            else if (anchor !== undefined) {
              const view = rows.find((row) => row.index === anchor.index)!.view;
              scroll.scrollTop += view.y - scroll.viewport.y - anchorY;
            } else {
              scroll.scrollTop = shiftedEarlier ? scroll.scrollHeight : 0;
            }
            loadingView = false;
            matchingView = false;
          };
          r.requestRender();
        } catch {
          if (lifetime.signal.aborted || request !== pendingView) return;
          loadingView = false;
          matchingView = false;
          count.content = " History unavailable";
        }
      };
      const shiftWindow = (direction: number): void => {
        if (loadingView || reader === undefined) return;
        const top = scroll.scrollTop;
        const bottom = Math.max(0, scroll.scrollHeight - scroll.viewport.height);
        if (direction < 0 && top <= 2 && windowStart > 0) {
          void showWindow(Math.max(0, windowStart - PAGE / 2), "anchor");
        } else if (direction > 0 && top >= bottom - 2 && windowStart < maxStart()) {
          void showWindow(Math.min(maxStart(), windowStart + PAGE / 2), "anchor");
        }
      };
      const frame = (): void => {
        if (afterLayout !== undefined) {
          const position = afterLayout;
          afterLayout = undefined;
          position();
          lastScrollTop = scroll.scrollTop;
          return;
        }
        const current = scroll.scrollTop;
        shiftWindow(Math.sign(current - lastScrollTop));
        lastScrollTop = current;
      };
      r.on(otui.CliRenderEvents.FRAME, frame);
      scroll.onMouseScroll = (event) => {
        const direction = event.scroll?.direction;
        if (direction === "up" || direction === "down") {
          queueMicrotask(() => {
            if (!lifetime.signal.aborted) shiftWindow(direction === "up" ? -1 : 1);
          });
        }
      };
      const scrollBy = (delta: number): void => {
        scroll.scrollBy(delta);
        shiftWindow(Math.sign(delta));
      };

      const showMatch = async (): Promise<void> => {
        const result = results;
        const signal = searching?.signal;
        if (result === undefined || signal === undefined || result.total === 0) return;
        const request = ++selection;
        const ordinal = selected;
        try {
          const match = await result.locate(ordinal, signal);
          if (match === undefined || signal.aborted || request !== selection) return;
          count.content = ` ${ordinal + 1}/${result.total}`;
          repaintMatch(match);
          if (loadingView || match.fragment < windowStart || match.fragment >= windowStart + rows.length) {
            await showWindow(Math.max(0, Math.min(maxStart(), match.fragment - PAGE / 2)), match);
          } else {
            afterLayout = () => {
              if (!signal.aborted && request === selection) scrollToMatch(match);
            };
            r.requestRender();
          }
        } catch {
          if (!signal.aborted && request === selection) count.content = " Search unavailable";
        }
      };
      const runSearch = async (): Promise<void> => {
        debounce = undefined;
        const request = new AbortController();
        searching = request;
        try {
          const source = await ready;
          request.signal.throwIfAborted();
          const result = await source.search(query, request.signal);
          request.signal.throwIfAborted();
          results = result;
          if (result.total === 0) count.content = " No matches";
          else void showMatch();
        } catch {
          if (!request.signal.aborted && !lifetime.signal.aborted) count.content = " Search unavailable";
        }
      };
      const updateQuery = (): void => {
        const next = field.value.trim();
        if (next === query) return;
        query = next;
        clearTimeout(debounce);
        debounce = undefined;
        searching?.abort();
        results = undefined;
        selected = 0;
        // A delayed jump for the previous query may still be reading from disk.
        if (matchingView) {
          pendingView++;
          loadingView = false;
          matchingView = false;
          afterLayout = undefined;
        }
        repaintMatch(undefined);
        count.content = query === "" ? "" : " Searching…";
        if (query !== "") debounce = setTimeout(() => { void runSearch(); }, 45);
      };
      const submit = (): void => {
        updateQuery();
        if (debounce !== undefined) {
          clearTimeout(debounce);
          void runSearch();
        } else {
          void showMatch();
        }
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
      field.on(otui.InputRenderableEvents.INPUT, updateQuery);
      field.on(otui.InputRenderableEvents.ENTER, submit);
      field.focus();
      move = (delta) => {
        if (results === undefined || results.total === 0) scrollBy(delta);
        else {
          selected = (selected + delta + results.total) % results.total;
          void showMatch();
        }
      };
      scrollPage = (delta) => scrollBy(delta * Math.max(1, scroll.viewport.height - 1));

      void ready.then((source) => {
        if (lifetime.signal.aborted) return;
        reader = source;
        void showWindow(maxStart(), "end");
      }).catch(() => {
        if (lifetime.signal.aborted) return;
        clearTranscriptChildren(body);
        hint("History unavailable.");
      });
      return () => {
        lifetime.abort();
        clearTimeout(debounce);
        searching?.abort();
        scroll.onMouseScroll = undefined;
        r.off(otui.CliRenderEvents.FRAME, frame);
        void ready.then((source) => source.close()).catch(() => {});
      };
    },
  });
}
