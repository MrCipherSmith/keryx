// Flow 305 (Flow A), AC4 — the `/routing` modal: list + a flat model picker.
//
// List: every category (`ROUTING_CATEGORIES`) with its current resolution.
// Enter opens the picker: ONE searchable/filterable list spanning every
// connected provider's models (`mountFilterList`, `./filter-list.ts` —
// extracted from `tui-shell.ts` so this file can reuse it without a
// `tui-shell.ts` <-> modal import cycle), plus one "provider default" row per
// connected provider and one "session default" row — never a two-step
// provider-then-model flow (PRD §7, §Non-goals). A confirmed pick writes
// immediately to the per-user layer (AC3's default write layer), not on
// modal close.
import {
  loadRoutingConfig,
  saveRoutingConfig,
  type RoutingConfigLocation,
  type RoutingConfigResult,
} from "../harness/routing/config";
import {
  describeAssignment,
  flatModelOptions,
  ROUTING_CATEGORIES,
  type CategoryAssignment,
  type FlatModelOption,
  type FlatPickerProvider,
  type RoutingCategory,
  type RoutingTable,
} from "../harness/routing/table";
import { mountFilterList, type KeypressEvent } from "./filter-list";
import { modalBodyRows, openModal, resolveModalPanelSize, type ModalHandle } from "./modal-host";
import { onThemeChange } from "./theme";
import { guardedThemeRepaint, isRenderableGone } from "./theme-repaint";
import { dimChunk, roleChunk } from "./theme-text";

type OpenTui = typeof import("@opentui/core");

export const ROUTING_COMMAND = "/routing";

export const ROUTING_FOOTER = [
  { key: "↑/↓", label: "move" },
  { key: "enter", label: "pick model" },
  { key: "esc", label: "close" },
] as const;

export interface RoutingCategoryRow {
  readonly category: RoutingCategory;
  readonly assignment: CategoryAssignment;
  readonly source: "project" | "user" | "default";
}

/** The list tab's rows, derived from both layers (AC3's precedence: project > user > default). */
export function routingCategoryRows(project: RoutingConfigResult, user: RoutingConfigResult): RoutingCategoryRow[] {
  return ROUTING_CATEGORIES.map((category) => {
    const projectAssignment = project.table[category];
    const userAssignment = user.table[category];
    if (projectAssignment !== undefined) {
      return { category, assignment: projectAssignment, source: "project" as const };
    }
    if (userAssignment !== undefined) {
      return { category, assignment: userAssignment, source: "user" as const };
    }
    return { category, assignment: { kind: "session-default" as const }, source: "default" as const };
  });
}

/** The list tab's rendered lines. Exported so a test can hold it against the CLI's own `list` output shape. */
export function formatRoutingListLines(rows: readonly RoutingCategoryRow[], selected: number): string[] {
  return rows.map((row, index) => {
    const mark = index === selected ? ">" : " ";
    return `${mark} ${row.category.padEnd(12)} ${describeAssignment(row.assignment)}  [${row.source}]`;
  });
}

export interface RoutingModalOptions {
  /** Project root — the "project" layer. */
  cwd: string;
  /** Per-user config dir override (test seam only) — the "user" layer. Default: the real global config dir. */
  userConfigDir?: string;
  onKeypress: (handler: (key: KeypressEvent) => void) => () => void;
  /** Connected providers for the flat picker. Defaults to a live `detectProviders()` call. */
  providers?: () => Promise<readonly FlatPickerProvider[]>;
  load?: (layer: "project" | "user", location: RoutingConfigLocation) => Promise<RoutingConfigResult>;
  save?: (layer: "project" | "user", location: RoutingConfigLocation, table: RoutingTable) => Promise<void>;
  renderer?: { width?: number; height?: number };
  visibleRows?: number;
  /** True while a composer choice or permission prompt owns the keyboard (review pattern, flow 300). */
  inputBlocked?: () => boolean;
}

export interface RoutingModalHandle extends ModalHandle {
  readonly ready: Promise<void>;
  reload(): Promise<void>;
  status(): string;
  visibleLines(): readonly string[];
  selectedCategory(): RoutingCategory | undefined;
  /** The flat picker's current options (populated once the "picker" tab has loaded providers). Tests only. */
  pickerOptions(): readonly FlatModelOption[];
}

export function openRouting(otui: unknown, chrome: unknown, options: RoutingModalOptions): RoutingModalHandle | undefined {
  const core = otui as OpenTui;
  const r = (chrome as { renderer?: unknown } | undefined)?.renderer;
  const load = options.load ?? loadRoutingConfig;
  const save = options.save ?? saveRoutingConfig;
  const location: RoutingConfigLocation = {
    cwd: options.cwd,
    ...(options.userConfigDir !== undefined ? { userConfigDir: options.userConfigDir } : {}),
  };
  const loadProviders = options.providers ?? defaultProviders;
  const rendererHint = options.renderer ?? (chrome as { renderer?: { width?: number; height?: number } } | undefined)?.renderer;
  const panelRows =
    typeof rendererHint?.width === "number" && typeof rendererHint.height === "number"
      ? modalBodyRows(resolveModalPanelSize(rendererHint.width, rendererHint.height).height)
      : 13;
  const bodyRows = Math.max(1, options.visibleRows ?? panelRows);

  let rows: RoutingCategoryRow[] = [];
  let flatOptions: FlatModelOption[] = [];
  let selected = 0;
  let statusText = "enter to pick a model for the selected category";
  let closed = false;
  let currentTab: string = "list";
  let statusNode: { content: unknown } | undefined;
  let bodyNode: { content: unknown } | undefined;
  const host: { handle?: ModalHandle } = {};
  const keys: { off?: () => void } = {};

  const selectedRow = (): RoutingCategoryRow | undefined => rows[selected];

  const listLines = (): string[] => (rows.length === 0 ? ["Reading routing table…"] : formatRoutingListLines(rows, selected));

  const paintList = (): void => {
    // Guarded on `currentTab`, not `host.handle?.activeTab()` (which is
    // unavailable during the very first synchronous paint — `host.handle` is
    // only assigned once `openModal` has already returned, after the initial
    // `renderTab` call already ran) and not merely on `closed`:
    // `statusNode`/`bodyNode` are reused closure variables the "list" tab's
    // own `renderTab` call assigns; once the operator switches to "picker",
    // modal-host tears those nodes down (`unmountActiveTab`) and the picker
    // branch never reassigns them (it uses its own status node). `reload()`
    // (called from `writePick`, which can run while "picker" is still
    // active, right before it switches back to "list") must not paint into
    // an already-destroyed TextRenderable.
    if (closed || currentTab !== "list") return;
    if (statusNode !== undefined) {
      statusNode.content = core.t`${roleChunk(core, "muted", statusText)}`;
    }
    if (bodyNode !== undefined) {
      bodyNode.content = core.t`${dimChunk(core, listLines().join("\n"))}`;
    }
  };

  const reload = async (): Promise<void> => {
    const [project, user] = await Promise.all([load("project", location), load("user", location)]);
    for (const error of [project.error, user.error]) {
      if (error !== undefined) statusText = `routing: ${error}`;
    }
    rows = routingCategoryRows(project, user);
    selected = Math.min(selected, Math.max(0, rows.length - 1));
    paintList();
  };

  const writePick = async (category: RoutingCategory, assignment: CategoryAssignment): Promise<void> => {
    const current = await load("user", location);
    await save("user", location, { ...current.table, [category]: assignment });
    statusText = `${category} -> ${describeAssignment(assignment)}  [user]`;
    await reload();
    host.handle?.setTab("list");
  };

  let unsubscribeTheme: () => void = () => {};
  const handle = openModal(core, chrome as never, {
    title: ROUTING_COMMAND,
    tabs: [
      { id: "list", label: "Categories" },
      { id: "picker", label: "Model" },
    ],
    footer: ROUTING_FOOTER,
    renderTab: (tabId, body) => {
      currentTab = tabId;
      const parent = body as { add(child: unknown): void };
      if (tabId === "list") {
        statusNode = new core.TextRenderable(r as never, { id: "rt-status", content: "" }) as never;
        bodyNode = new core.TextRenderable(r as never, { id: "rt-body", content: "", marginTop: 1 }) as never;
        parent.add(statusNode);
        parent.add(bodyNode);
        paintList();
        return options.onKeypress((key) => {
          if (closed || options.inputBlocked?.() === true) return;
          const token = key.name || key.sequence;
          if (token === "up" || token === "k") {
            selected = Math.max(0, selected - 1);
            paintList();
          } else if (token === "down" || token === "j") {
            selected = Math.min(Math.max(0, rows.length - 1), selected + 1);
            paintList();
          } else if (token === "return" || token === "enter") {
            if (selectedRow() !== undefined) host.handle?.setTab("picker");
          }
        });
      }
      // "picker" tab — the flat model list (AC4).
      const row = selectedRow();
      statusNode = new core.TextRenderable(r as never, {
        id: "rt-picker-status",
        content: core.t`${roleChunk(core, "muted", row === undefined ? "no category selected" : `picking a model for ${row.category}`)}`,
      }) as never;
      parent.add(statusNode as never);
      let unsub = (): void => {};
      void (async () => {
        const providers = await loadProviders();
        flatOptions = flatModelOptions(providers);
        if (closed || host.handle?.activeTab() !== "picker") return;
        const list = mountFilterList(core, r as never, parent as never, {
          idPrefix: "rt",
          items: flatOptions,
          toOption: (opt) => ({ name: opt.label, description: "" }),
          matches: (opt, q) => opt.search.includes(q),
          emptyLabel: "(no connected providers)",
          idleHint: "type to filter · ↑/↓ Enter to pick · Esc back",
          filterHint: (filter, shown, total) => `filter: ${filter}  (${shown}/${total})`,
          showDescription: false,
          width: "100%",
          height: Math.max(1, bodyRows - 1),
          onPick: (opt) => {
            const currentRow = selectedRow();
            if (opt === undefined || currentRow === undefined) return;
            void writePick(currentRow.category, opt.assignment);
          },
        });
        unsub = options.onKeypress((key) => {
          if (closed || options.inputBlocked?.() === true) return;
          list.onKey(key);
        });
      })();
      return () => unsub();
    },
    onClose: () => {
      closed = true;
      keys.off?.();
      unsubscribeTheme();
    },
  });
  if (handle === undefined) return undefined;
  host.handle = handle;
  unsubscribeTheme = onThemeChange(
    guardedThemeRepaint("routing-modal", paintList, () => closed || isRenderableGone(bodyNode) || (r as { isDestroyed?: boolean } | undefined)?.isDestroyed === true),
  );

  const ready = reload();
  return {
    ...handle,
    ready,
    reload,
    status: () => statusText,
    visibleLines: () => windowLines(listLines(), bodyRows),
    selectedCategory: () => selectedRow()?.category,
    pickerOptions: () => flatOptions,
  };
}

function windowLines(lines: readonly string[], rows: number): readonly string[] {
  return lines.slice(0, Math.max(1, rows));
}

/** Live connected-provider list for the flat picker, from `detectProviders()`. */
async function defaultProviders(): Promise<readonly FlatPickerProvider[]> {
  const { detectProviders } = await import("../commands/select");
  const { envWithSavedApiKeys } = await import("../lib/shell-config");
  const detected = await detectProviders({ fetch, env: envWithSavedApiKeys() });
  return detected.map((p) => ({ name: p.name, models: p.models }));
}
