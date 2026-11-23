import { useCallback, useMemo, useReducer, useRef } from "react";
import {
  MetaprojectRequestError,
  type MetaprojectTreeEntry,
  type MetaprojectTreeScope,
  type MetaprojectTreeV2,
} from "../../../../src/integrations/metaproject-explorer-contract";
import { errMessage } from "../lib/format";
import type { MetaprojectTreeRequest } from "../platform/metaproject";

/** The key of a tree's root; graph folder paths and wiki group keys are never empty. */
export const TREE_ROOT = "";

export type RequestTree = (cwd: string, request: MetaprojectTreeRequest) => Promise<MetaprojectTreeV2>;

/** The loaded children of one tree parent (the root, a graph folder or a wiki group). */
export interface TreeFolder {
  status: "loading" | "ready" | "failed";
  entries: readonly MetaprojectTreeEntry[];
  error?: string;
  nextCursor?: string;
  /** The source behind the scope is missing or incomplete (a graph that is not built). */
  partial: boolean;
  /** The next page: being read, or its read failed. */
  more?: { status: "loading" } | { status: "failed"; error: string };
}

/** One scope's tree: kept by the explorer, so it survives leaving the view and switching Graph/Wiki. */
export interface ScopeTree {
  snapshot: string;
  expanded: ReadonlySet<string>;
  folders: ReadonlyMap<string, TreeFolder>;
  /** The last selection the tree revealed or chose itself; a different one is revealed. */
  handled: string;
}

export interface MetaprojectTreeModel {
  get(scope: MetaprojectTreeScope): ScopeTree;
  /** Reads `parent`'s first page unless it is loaded, being read, or failed. */
  ensure(scope: MetaprojectTreeScope, parent: string): void;
  setExpanded(scope: MetaprojectTreeScope, key: string, expanded: boolean): void;
  /** Re-reads one failed parent, or its failed next page. */
  retry(scope: MetaprojectTreeScope, parent: string): void;
  /** Appends `parent`'s next page; a page already being read is not asked for again. */
  more(scope: MetaprojectTreeScope, parent: string): void;
  setHandled(scope: MetaprojectTreeScope, selection: string): void;
}

/** A container's key: a graph folder's path or a wiki group's key. A node is keyed by its id. */
export const entryKey = (entry: MetaprojectTreeEntry) =>
  entry.type === "folder" ? entry.path : entry.type === "group" ? entry.key : entry.node.id;

/** The parent of an expandable key: wiki groups sit at the root, graph folders under their directory. */
export function parentOf(scope: MetaprojectTreeScope, key: string): string {
  if (scope === "wiki") return TREE_ROOT;
  const slash = key.lastIndexOf("/");
  return slash < 0 ? TREE_ROOT : key.slice(0, slash);
}

const emptyScope = (snapshot: string): ScopeTree => ({ snapshot, expanded: new Set(), folders: new Map(), handled: "" });

/**
 * The explorer's tree data: per scope, the expanded folders, the loaded pages of each parent and
 * what the tree last revealed. A new snapshot drops loaded children and every pending answer and
 * keeps the expanded set; the tree re-reads what it shows. A cursor is only ever sent for the
 * snapshot that issued it. `onStale` is told when the CLI answers for another snapshot.
 */
export function useMetaprojectTree({ cwd, snapshot, request, onStale }: {
  cwd: string;
  snapshot: string;
  request: RequestTree;
  onStale: () => void;
}): MetaprojectTreeModel {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const state = useRef<Record<MetaprojectTreeScope, ScopeTree>>({ graph: emptyScope(snapshot), wiki: emptyScope(snapshot) });
  // Every snapshot change retires the answers still in flight; a read keeps the generation it started in.
  const generation = useRef(0);
  if (state.current.graph.snapshot !== snapshot) {
    generation.current++;
    const keep = (scope: ScopeTree): ScopeTree => ({ ...emptyScope(snapshot), expanded: scope.expanded, handled: scope.handled });
    state.current = { graph: keep(state.current.graph), wiki: keep(state.current.wiki) };
  }
  const latest = useRef({ cwd, request, onStale });
  latest.current = { cwd, request, onStale };

  const update = useCallback((scope: MetaprojectTreeScope, change: (tree: ScopeTree) => ScopeTree) => {
    const next = change(state.current[scope]);
    if (next === state.current[scope]) return;
    state.current = { ...state.current, [scope]: next };
    render();
  }, []);

  const setFolder = useCallback((scope: MetaprojectTreeScope, parent: string, change: (folder: TreeFolder | undefined) => TreeFolder) => {
    update(scope, tree => {
      const folders = new Map(tree.folders);
      folders.set(parent, change(tree.folders.get(parent)));
      return { ...tree, folders };
    });
  }, [update]);

  /** Once every page of `parent` is read, its expanded children that are gone are forgotten, with their descendants. */
  const forgetVanished = useCallback((scope: MetaprojectTreeScope, parent: string) => {
    update(scope, tree => {
      const folder = tree.folders.get(parent);
      if (!folder || folder.status !== "ready" || folder.nextCursor) return tree;
      const present = new Set(folder.entries.map(entryKey));
      const gone = [...tree.expanded].filter(key => parentOf(scope, key) === parent && !present.has(key));
      if (!gone.length) return tree;
      const expanded = new Set([...tree.expanded].filter(key => !gone.some(vanished => key === vanished || key.startsWith(`${vanished}/`))));
      return { ...tree, expanded };
    });
  }, [update]);

  const read = useCallback((scope: MetaprojectTreeScope, parent: string, cursor?: string) => {
    const issued = generation.current;
    const pinned = state.current[scope].snapshot;
    const current = () => issued === generation.current;
    const { cwd: root, request: send } = latest.current;
    const input: MetaprojectTreeRequest = {
      scope, expectedSnapshotId: pinned, ...(parent !== TREE_ROOT && { parent }), ...(cursor && { cursor }),
    };
    void Promise.resolve().then(() => send(root, input)).then(page => {
      if (!current()) return;
      if (page.snapshotId !== pinned) throw new MetaprojectRequestError("stale-snapshot", "Project knowledge changed while loading.");
      setFolder(scope, parent, folder => {
        if (!cursor) return { status: "ready", entries: page.entries, partial: page.partial, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
        // A page appends to the one that asked for it, in order, without repeating a row.
        const base = folder ?? { status: "ready" as const, entries: [], partial: page.partial };
        const seen = new Set(base.entries.map(entryKey));
        const entries = [...base.entries, ...page.entries.filter(entry => !seen.has(entryKey(entry)))];
        return { status: "ready", entries, partial: base.partial || page.partial, ...(page.nextCursor && { nextCursor: page.nextCursor }) };
      });
      forgetVanished(scope, parent);
    }).catch(cause => {
      if (!current()) return;
      if (cause instanceof MetaprojectRequestError && cause.code === "stale-snapshot") latest.current.onStale();
      // A folder that no longer exists is forgotten quietly; the next read of its parent drops its row.
      if (!cursor && parent !== TREE_ROOT && cause instanceof MetaprojectRequestError && cause.code === "not-found") {
        update(scope, tree => {
          const folders = new Map(tree.folders);
          folders.delete(parent);
          const expanded = new Set([...tree.expanded].filter(key => key !== parent && !key.startsWith(`${parent}/`)));
          return { ...tree, folders, expanded };
        });
        return;
      }
      const error = errMessage(cause);
      setFolder(scope, parent, folder => cursor && folder
        ? { ...folder, more: { status: "failed", error } }
        : { status: "failed", entries: [], partial: false, error });
    });
  }, [forgetVanished, setFolder, update]);

  const ensure = useCallback((scope: MetaprojectTreeScope, parent: string) => {
    if (state.current[scope].folders.has(parent)) return;
    setFolder(scope, parent, () => ({ status: "loading", entries: [], partial: false }));
    read(scope, parent);
  }, [read, setFolder]);

  const more = useCallback((scope: MetaprojectTreeScope, parent: string) => {
    const folder = state.current[scope].folders.get(parent);
    if (!folder || folder.status !== "ready" || !folder.nextCursor || folder.more?.status === "loading") return;
    const cursor = folder.nextCursor;
    setFolder(scope, parent, current => ({ ...(current ?? folder), more: { status: "loading" } }));
    read(scope, parent, cursor);
  }, [read, setFolder]);

  const retry = useCallback((scope: MetaprojectTreeScope, parent: string) => {
    const folder = state.current[scope].folders.get(parent);
    if (folder?.status === "failed") {
      setFolder(scope, parent, () => ({ status: "loading", entries: [], partial: false }));
      read(scope, parent);
    } else if (folder?.more?.status === "failed" && folder.nextCursor) {
      setFolder(scope, parent, current => ({ ...(current ?? folder), more: { status: "loading" } }));
      read(scope, parent, folder.nextCursor);
    }
  }, [read, setFolder]);

  const setExpanded = useCallback((scope: MetaprojectTreeScope, key: string, open: boolean) => {
    update(scope, tree => {
      if (tree.expanded.has(key) === open) return tree;
      const expanded = new Set(tree.expanded);
      if (open) expanded.add(key); else expanded.delete(key);
      return { ...tree, expanded };
    });
  }, [update]);

  const setHandled = useCallback((scope: MetaprojectTreeScope, selection: string) => {
    update(scope, tree => tree.handled === selection ? tree : { ...tree, handled: selection });
  }, [update]);

  const get = useCallback((scope: MetaprojectTreeScope) => state.current[scope], []);
  const scopes = state.current;
  // A new object whenever a scope changes, so the tree re-renders with it.
  return useMemo(() => ({ get, ensure, setExpanded, retry, more, setHandled, scopes }),
    [get, ensure, setExpanded, retry, more, setHandled, scopes]);
}
