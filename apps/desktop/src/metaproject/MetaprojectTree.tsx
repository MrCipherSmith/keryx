import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import {
  metaprojectWikiGroupKey,
  type MetaprojectNode,
  type MetaprojectTreeEntry,
  type MetaprojectTreeScope,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { Icon } from "../components/Icon";
import { NODE_KIND_LABELS } from "./labels";
import { TREE_ROOT, entryKey, type MetaprojectTreeModel, type ScopeTree } from "./useMetaprojectTree";

type ContainerEntry = Exclude<MetaprojectTreeEntry, { type: "node" }>;

/** One visible row of the flattened tree. Status rows (loading, error, more) belong to `parent`. */
type Row =
  | { type: "entry"; id: string; level: number; posinset: number; setsize: number; parent: string; entry: MetaprojectTreeEntry }
  | { type: "loading"; id: string; level: number; parent: string }
  | { type: "error"; id: string; level: number; parent: string; message: string }
  | { type: "more"; id: string; level: number; parent: string; loading: boolean };

const isContainer = (entry: MetaprojectTreeEntry): entry is ContainerEntry => entry.type !== "node";
const rowId = (entry: MetaprojectTreeEntry) => `${isContainer(entry) ? "d" : "n"}:${entryKey(entry)}`;
const nodeOf = (entry: MetaprojectTreeEntry): MetaprojectNode | undefined =>
  entry.type === "node" ? entry.node : entry.type === "folder" ? entry.module : undefined;

/**
 * A parent's first read shows one status row (loading, then error, and loading again on Retry) and its
 * next page another (Show more, loading, error). Each keeps one id through its states, so a Retry or
 * Show more updates the focused row in place. The two differ, so a first read that answers with a next
 * page replaces the focused Loading row instead of turning it into Show more.
 */
const statusId = (parent: string) => `status:${parent}`;
const moreId = (parent: string) => `more:${parent}`;

/** The visible rows, depth first, and the parents shown as loading that nobody has asked for yet. */
function flatten(tree: ScopeTree): { rows: Row[]; unread: string[] } {
  const rows: Row[] = [];
  const unread: string[] = [];
  const visit = (parent: string, level: number) => {
    const folder = tree.folders.get(parent);
    const id = statusId(parent);
    // A stale read shows as loading: the explorer's Refresh catalog banner is its one way out.
    if (!folder || folder.status === "loading" || folder.status === "stale") {
      if (!folder) unread.push(parent);
      rows.push({ type: "loading", id, level, parent });
      return;
    }
    if (folder.status === "failed") {
      rows.push({ type: "error", id, level, parent, message: folder.error ?? "The read failed." });
      return;
    }
    // More pages: the set's size is not known yet (ARIA's -1).
    const setsize = folder.nextCursor ? -1 : folder.entries.length;
    folder.entries.forEach((entry, index) => {
      rows.push({ type: "entry", id: rowId(entry), level, posinset: index + 1, setsize, parent, entry });
      if (isContainer(entry) && tree.expanded.has(entryKey(entry))) visit(entryKey(entry), level + 1);
    });
    if (folder.more?.status === "failed") rows.push({ type: "error", id: moreId(parent), level, parent, message: folder.more.error });
    else if (folder.nextCursor) rows.push({ type: "more", id: moreId(parent), level, parent, loading: Boolean(folder.more) });
  };
  visit(TREE_ROOT, 1);
  return { rows, unread };
}

/**
 * Where focus goes if the focused row leaves: the first row after `anchor`, or with `parent` set, the
 * first row of that parent after it. A parent's status row anchors to its own parent's rows, so rows of
 * another folder that arrive in the same commit cannot take its place: its Loading row to the parent's
 * row (its first child follows), its next-page row to the parent's last entry (its first appended entry
 * follows). Any other row anchors to the row before it.
 */
function handOff(rows: readonly Row[], index: number): { anchor?: string; parent?: string } {
  const row = rows[index];
  if (!row || row.type === "entry") return { anchor: rows[index - 1]?.id };
  const own = `d:${row.parent}`;
  if (row.id === statusId(row.parent)) return { anchor: own, parent: row.parent };
  const last = rows.slice(0, index).reverse().find(item => item.type === "entry" && item.parent === row.parent);
  return { anchor: last?.id ?? own, parent: row.parent };
}

/** The tree steps from the root to `node`: each names the parent to read and the child to find in it. */
type Step = { parent: string; container: string } | { parent: string; node: string };
function revealSteps(scope: MetaprojectTreeScope, node: MetaprojectNode): Step[] {
  if (scope === "wiki") {
    if (node.kind !== "wiki") return [];
    const group = metaprojectWikiGroupKey(node);
    return [{ parent: TREE_ROOT, container: group }, { parent: group, node: node.id }];
  }
  if (node.kind !== "file" && node.kind !== "module" && node.kind !== "symbol") return [];
  if (node.path === "." || !node.path) return [];
  const parts = node.path.split("/");
  // A module is its folder's row; a symbol lives in its file, which the tree does not key by path.
  const folders = node.kind === "file" || node.kind === "symbol" ? parts.slice(0, -1) : parts;
  const steps: Step[] = folders.map((_, index) => ({
    parent: folders.slice(0, index).join("/"), container: folders.slice(0, index + 1).join("/"),
  }));
  if (node.kind === "file") steps.push({ parent: folders.join("/"), node: node.id });
  return steps;
}

/**
 * The explorer sidebar as a WAI-ARIA tree: graph folders and files, or wiki page-type groups and
 * pages. Data lives in `model` (the explorer's), so this component can come and go with the search.
 * Focus moves with the keyboard or a click. Data arriving never takes focus from outside the tree;
 * when the focused row is replaced (its folder or next page loaded), focus goes to the row now at its
 * place: the one after the row that preceded it, when that row is still shown.
 */
export function MetaprojectTree({ scope, label, model, selection, selected, onSelect }: {
  scope: MetaprojectTreeScope;
  /** The tree's accessible name. */
  label: string;
  model: MetaprojectTreeModel;
  /** The explorer's selected node id. */
  selection: string;
  /** The selected node, when the explorer knows it: revealed when the selection came from elsewhere. */
  selected?: MetaprojectNode;
  onSelect: (node: MetaprojectNode) => void;
}) {
  const tree = model.get(scope);
  const { rows, unread } = flatten(tree);
  const [focusId, setFocusId] = useState("");
  const list = useRef<HTMLUListElement>(null);
  /**
   * The element focused inside the tree, its row's index and where it hands focus (`handOff`), so a
   * row that leaves can hand focus to the row now at its place.
   */
  const focused = useRef<{ element: HTMLElement; index: number; anchor?: string; parent?: string } | null>(null);
  // The rows on screen, for recording a hand-off outside a render (a blur's microtask).
  const shown = useRef(rows);
  shown.current = rows;
  const scrollRequest = useRef("");
  const rowElements = () => [...list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []];

  useEffect(() => {
    for (const parent of unread) model.ensure(scope, parent);
  }, [model, scope, unread.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reveal a selection made elsewhere: expand its ancestors, reading and paging as needed; stop at a failure.
  useEffect(() => {
    if (!selected || selected.id !== selection || tree.handled === selection) return;
    for (const step of revealSteps(scope, selected)) {
      const folder = tree.folders.get(step.parent);
      if (!folder) { model.ensure(scope, step.parent); return; }
      if (folder.status === "loading" || folder.status === "stale") return;
      if (folder.status === "failed") { model.setHandled(scope, selection); return; }
      const found = folder.entries.some(entry => "container" in step
        ? isContainer(entry) && entryKey(entry) === step.container
        : entry.type === "node" && entry.node.id === step.node);
      if (!found) {
        if (folder.nextCursor && folder.more?.status !== "failed") { model.more(scope, step.parent); return; }
        model.setHandled(scope, selection);
        return;
      }
      if ("container" in step && !(selected.kind === "module" && step.container === selected.path)) {
        model.setExpanded(scope, step.container, true);
      }
    }
    scrollRequest.current = selected.kind === "module" ? `d:${selected.path}` : `n:${selected.id}`;
    model.setHandled(scope, selection);
  });

  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    const elements = rowElements();
    if (scrollRequest.current) {
      const row = elements.find(item => item.dataset.row === scrollRequest.current);
      if (row) { row.scrollIntoView?.({ block: "nearest" }); scrollRequest.current = ""; }
    }
    // The focused row left (its folder's children or last page arrived, a new snapshot): focus the row
    // now at its place, found from its hand-off anchor (`handOff`), so rows added or removed elsewhere in
    // the same commit do not move it into another folder. Without the anchor, the row at its old index.
    // Focus that was outside the tree is never taken.
    const lost = focused.current;
    const active = document.activeElement;
    if (lost && !lost.element.isConnected && (!active || active === document.body || !active.isConnected)) {
      const at = lost.anchor === undefined ? -1 : rows.findIndex(row => row.id === lost.anchor);
      const after = rows.slice(at + 1);
      const target = at < 0 ? undefined
        : (lost.parent === undefined ? after[0] : after.find(row => row.parent === lost.parent)) ?? rows[at];
      const next = target ? elements.find(element => element.dataset.row === target.id) : elements[Math.min(lost.index, elements.length - 1)];
      next?.focus();
    }
    remember(document.activeElement);
  });

  /** Records where focus is when it is inside the tree, and forgets it otherwise. */
  function remember(element: Element | null) {
    const row = element instanceof HTMLElement && list.current?.contains(element) ? element.closest<HTMLElement>("[data-row]") : null;
    const index = row ? shown.current.findIndex(item => item.id === row.dataset.row) : -1;
    focused.current = element instanceof HTMLElement && index >= 0 ? { element, index, ...handOff(shown.current, index) } : null;
  }
  // Focus moving out of the tree is forgotten; a row removed while focused is not, so it can hand focus on.
  const onBlur = (event: FocusEvent<HTMLUListElement>) => {
    const element = event.target;
    queueMicrotask(() => {
      if (element.isConnected && focused.current?.element === element) remember(document.activeElement);
    });
  };

  const selectedRow = rows.find(row => row.type === "entry" && nodeOf(row.entry)?.id === selection);
  const tabbable = rows.find(row => row.id === focusId) ?? selectedRow ?? rows[0];

  const choose = (node: MetaprojectNode) => {
    model.setHandled(scope, node.id);
    onSelect(node);
  };
  const toggle = (key: string) => model.setExpanded(scope, key, !tree.expanded.has(key));
  const activate = (row: Row, key: "Enter" | " " | "click") => {
    if (row.type === "error") model.retry(scope, row.parent);
    else if (row.type === "more") model.more(scope, row.parent);
    else if (row.type === "entry") {
      const { entry } = row;
      if (entry.type === "node") choose(entry.node);
      else if (entry.type === "folder" && entry.module && key !== " ") choose(entry.module);
      else toggle(entryKey(entry));
    }
  };
  // Focus moves now, to a row already shown; nothing is left pending for a later render.
  const moveTo = (row: Row | undefined) => {
    if (row) rowElements().find(element => element.dataset.row === row.id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-row]")?.dataset.row : undefined;
    const current = rows.find(row => row.id === target) ?? tabbable;
    if (!current) return;
    const index = rows.indexOf(current);
    const container = current.type === "entry" && isContainer(current.entry) ? entryKey(current.entry) : null;
    const open = container !== null && tree.expanded.has(container);
    switch (event.key) {
      case "ArrowDown": moveTo(rows[index + 1]); break;
      case "ArrowUp": moveTo(rows[index - 1]); break;
      case "Home": moveTo(rows[0]); break;
      case "End": moveTo(rows.at(-1)); break;
      case "ArrowRight":
        if (container === null) break;
        if (!open) model.setExpanded(scope, container, true);
        else if (rows[index + 1]?.level === current.level + 1) moveTo(rows[index + 1]);
        break;
      case "ArrowLeft":
        if (open && container !== null) model.setExpanded(scope, container, false);
        else moveTo(rows.slice(0, index).reverse().find(row => row.level === current.level - 1));
        break;
      case "Enter":
      case " ":
        activate(current, event.key);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onRowClick = (row: Row) => (event: MouseEvent) => {
    event.stopPropagation();
    setFocusId(row.id);
    activate(row, "click");
  };
  const onChevron = (row: Row, key: string) => (event: MouseEvent) => {
    event.stopPropagation();
    setFocusId(row.id);
    toggle(key);
  };

  const root = tree.folders.get(TREE_ROOT);
  if (root?.status === "ready" && root.entries.length === 0 && !root.nextCursor) {
    return <p className="metaproject-meta" role="status">{scope === "graph"
      ? root.partial ? "The graph is not built yet. Rebuild the graph to browse its files." : "No indexed files."
      : "No Wiki pages."}</p>;
  }

  return (
    <ul ref={list} role="tree" aria-label={label} className="metaproject-tree" onKeyDown={onKeyDown} onBlur={onBlur}>
      {rows.map(row => {
        const common = {
          "data-row": row.id,
          role: "treeitem",
          "aria-level": row.level,
          tabIndex: row === tabbable ? 0 : -1,
          style: { paddingInlineStart: `calc(var(--sp-3) + ${row.level - 1} * var(--sp-4))` },
          onFocus: (event: FocusEvent<HTMLLIElement>) => {
            setFocusId(row.id);
            // The rendered rows are this render's `rows`, in order: no DOM query on every focus move.
            const index = rows.findIndex(item => item.id === row.id);
            focused.current = { element: event.target, index, ...handOff(rows, index) };
          },
        };
        if (row.type === "loading") {
          return <li key={row.id} {...common} aria-disabled="true" className="metaproject-tree-status"><span role="status">Loading…</span></li>;
        }
        if (row.type === "error") {
          // The same live region as the loading row it replaces, so the failure is announced.
          return (
            <li key={row.id} {...common} className="metaproject-tree-status metaproject-tree-error" onClick={onRowClick(row)}>
              <span role="status">Could not load. {row.message}</span>
              <button type="button" className="btn btn-sm" tabIndex={-1} onClick={onRowClick(row)}>Retry</button>
            </li>
          );
        }
        if (row.type === "more") {
          return (
            <li key={row.id} {...common} aria-busy={row.loading || undefined} className="metaproject-row metaproject-tree-more" onClick={onRowClick(row)}>
              {row.loading ? <span role="status">Loading…</span> : "Show more"}
            </li>
          );
        }
        const { entry } = row;
        const position = { "aria-posinset": row.posinset, "aria-setsize": row.setsize };
        if (entry.type === "node") {
          return (
            <li key={row.id} {...common} {...position} aria-selected={entry.node.id === selection} className="metaproject-row metaproject-tree-row"
              onClick={onRowClick(row)}>
              <span className="metaproject-tree-chevron" aria-hidden="true" />
              <span className="metaproject-tree-name">{entry.node.title}</span>
              <span className="metaproject-meta">{NODE_KIND_LABELS[entry.node.kind]}</span>
            </li>
          );
        }
        const key = entryKey(entry);
        const open = tree.expanded.has(key);
        const module = entry.type === "folder" ? entry.module : undefined;
        return (
          <li key={row.id} {...common} {...position} aria-expanded={open} {...(module && { "aria-selected": module.id === selection })}
            className="metaproject-row metaproject-tree-row" onClick={module ? onChevron(row, key) : onRowClick(row)}>
            <span className="metaproject-tree-chevron" aria-hidden="true" onClick={onChevron(row, key)}>
              <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
            </span>
            <span className="metaproject-tree-name" {...(module && { onClick: onRowClick(row) })}>{entry.name}</span>
            {/* A module folder's name selects the module, so it carries the kind label node rows show. */}
            {module && <span className="metaproject-meta">{NODE_KIND_LABELS.module}</span>}
            <span className="count-label">{entry.type === "folder" ? entry.files : entry.pages}</span>
          </li>
        );
      })}
    </ul>
  );
}
