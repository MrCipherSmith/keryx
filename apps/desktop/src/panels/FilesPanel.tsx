import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { highlightToHtml, languageForPath } from "../components/highlight";
import { projectFileRead, projectFiles, type ProjectFileContent, type ProjectFiles } from "../platform/commands";
import { buildTree, limitLines, visibleRows } from "./fileTree";

const MAX_LINES = 2000;
const SEARCH_DELAY_MS = 150;

/** The host calls the panel makes; injectable so the panel is tested without the Tauri bridge. */
export interface FilesApi {
  list: (cwd: string, query?: string) => Promise<ProjectFiles>;
  read: (cwd: string, path: string) => Promise<ProjectFileContent>;
}
const REAL_API: FilesApi = { list: projectFiles, read: projectFileRead };

/** An open file: one tab beside the tree's. */
type Viewer =
  | { state: "loading"; path: string }
  | { state: "error"; path: string; message: string }
  | { state: "ready"; path: string; file: ProjectFileContent };

const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The Files tab of the side panel. Its own tab strip, like the terminal's: the first tab is the project's tree with a
 * search box, and every file opened from it gets a read-only tab of its own.
 */
export function FilesPanel({ cwd, visible, api = REAL_API }: { cwd: string; visible: boolean; api?: FilesApi }) {
  const [all, setAll] = useState<ProjectFiles | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ProjectFiles | null>(null);
  const [tabs, setTabs] = useState<Viewer[]>([]);
  /** The shown file tab's path; null shows the tree. */
  const [active, setActive] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(true);
  const listReq = useRef(0);
  const searchReq = useRef(0);
  /** The latest read of each open path; a response for an older one, or for a closed tab, is dropped. */
  const readReq = useRef(new Map<string, number>());
  const readSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(() => {
    const id = ++listReq.current;
    setListError(null);
    api.list(cwd).then(
      (r) => alive.current && id === listReq.current && setAll(r),
      (e) => alive.current && id === listReq.current && setListError(message(e)),
    );
  }, [api, cwd]);

  if (visible && !started) setStarted(true);

  // First visible, and again when the project changes.
  useEffect(() => {
    listReq.current++;
    searchReq.current++;
    readReq.current.clear();
    setAll(null);
    setFound(null);
    setQuery("");
    setTabs([]);
    setActive(null);
    setExpanded(new Set());
    setListError(null);
    if (started) load();
  }, [cwd, started, load]);

  const q = query.trim();
  useEffect(() => {
    const id = ++searchReq.current;
    if (q === "") {
      setFound(null);
      return;
    }
    const t = setTimeout(() => {
      api.list(cwd, q).then(
        (r) => alive.current && id === searchReq.current && (setFound(r), setListError(null)),
        (e) => alive.current && id === searchReq.current && setListError(message(e)),
      );
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [api, cwd, q, retry]);

  const tree = useMemo(() => buildTree(all?.files ?? []), [all]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const toggle = (path: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  /** Shows `path` in its tab, opening one when it has none, and reads the file again: the agent may have changed it. */
  const open = (path: string) => {
    const id = ++readSeq.current;
    readReq.current.set(path, id);
    const settle = (next: Viewer) => {
      if (!alive.current || readReq.current.get(path) !== id) return;
      setTabs((list) => list.map((tab) => (tab.path === path ? next : tab)));
    };
    setCopied(null);
    // An open tab keeps what it shows until the new read lands.
    setTabs((list) => (list.some((tab) => tab.path === path) ? list : [...list, { state: "loading", path }]));
    setActive(path);
    api.read(cwd, path).then(
      (file) => settle({ state: "ready", path, file }),
      (e) => settle({ state: "error", path, message: message(e) }),
    );
  };

  const close = (path: string) => {
    readReq.current.delete(path);
    const at = tabs.findIndex((tab) => tab.path === path);
    const rest = tabs.filter((tab) => tab.path !== path);
    setTabs(rest);
    // The neighbour takes its place; the tree when it was the last file.
    if (active === path) setActive(rest[Math.min(at, rest.length - 1)]?.path ?? null);
  };

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(`@${path}`).then(
      () => alive.current && setCopied(path),
      () => {},
    );
  };

  const rowKey = (e: React.KeyboardEvent, activate: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };

  const searching = q !== "";
  const viewer = tabs.find((tab) => tab.path === active) ?? null;
  const shown = viewer?.path ?? null;

  return (
    <div className="files-panel" data-testid="files-panel">
      <div className="panel-tabs" role="tablist" aria-label="File tabs">
        <div className={`panel-tab${viewer === null ? " is-active" : ""}`}>
          <button role="tab" aria-selected={viewer === null} className="panel-tab-btn" onClick={() => setActive(null)} title="Project files">
            <Icon name="folder" size={12} />
            <span className="truncate">Files</span>
          </button>
        </div>
        {tabs.map((tab) => (
          <div key={tab.path} className={`panel-tab${tab.path === shown ? " is-active" : ""}`}>
            <button role="tab" aria-selected={tab.path === shown} className="panel-tab-btn" onClick={() => setActive(tab.path)} title={tab.path}>
              <Icon name="file" size={12} />
              <span className="truncate">{baseName(tab.path)}</span>
            </button>
            <button className="icon-btn icon-btn-sm" onClick={() => close(tab.path)} aria-label={`Close ${tab.path}`} title="Close tab">
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
      </div>
      {/* The tree stays mounted behind a file tab, so its scroll position, search and open folders are kept. */}
      <div className="files-tree" hidden={viewer !== null}>
        <div className="files-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={query}
            placeholder="Search files"
            aria-label="Search files"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="files-list" role={searching ? "list" : "tree"} aria-label="Project files">
          {listError ? (
            <div className="files-error" role="alert">
              <span>{listError}</span>
              <button className="btn btn-sm" onClick={() => (searching ? setRetry((n) => n + 1) : load())}>
                Retry
              </button>
            </div>
          ) : null}
          {searching ? (
            found === null ? (
              listError ? null : <div className="files-note">Searching…</div>
            ) : found.files.length === 0 ? (
              <div className="files-note">No files match.</div>
            ) : (
              found.files.map((p) => (
                <button
                  key={p}
                  className={`files-row${tabs.some((tab) => tab.path === p) ? " is-open" : ""}`}
                  style={{ paddingLeft: 8 }}
                  title={p}
                  onClick={() => open(p)}
                >
                  <Icon name="file" size={13} />
                  <span className="files-row-name">{p}</span>
                </button>
              ))
            )
          ) : all === null ? (
            listError ? null : <div className="files-note">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="files-note">No files.</div>
          ) : (
            <>
              {rows.map(({ node, depth }) => (
                <button
                  key={node.path}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-expanded={node.dir ? expanded.has(node.path) : undefined}
                  className={`files-row${node.dir ? " is-dir" : ""}${!node.dir && tabs.some((tab) => tab.path === node.path) ? " is-open" : ""}`}
                  style={{ paddingLeft: 8 + depth * 14 }}
                  title={node.path}
                  onClick={() => (node.dir ? toggle(node.path) : open(node.path))}
                  onKeyDown={(e) => rowKey(e, () => (node.dir ? toggle(node.path) : open(node.path)))}
                >
                  <Icon name={node.dir ? (expanded.has(node.path) ? "folderOpen" : "folder") : "file"} size={13} />
                  <span className="files-row-name">{node.name}</span>
                </button>
              ))}
              {all.truncated ? <div className="files-note">The list is truncated. Search to find other files.</div> : null}
            </>
          )}
        </div>
      </div>
      {viewer ? (
        <div className="files-viewer" data-testid="files-viewer" role="tabpanel" aria-label={viewer.path}>
          <div className="files-viewer-head">
            <span className="files-viewer-path" title={viewer.path}>{viewer.path}</span>
            <button className="btn btn-sm" onClick={() => copyPath(viewer.path)}>{copied === viewer.path ? "Copied" : "Copy @path"}</button>
          </div>
          {viewer.state === "loading" ? (
            <div className="files-note">Loading…</div>
          ) : viewer.state === "error" ? (
            <div className="files-error" role="alert">{viewer.message}</div>
          ) : viewer.file.binary || viewer.file.text === null ? (
            <div className="files-note">Binary file, {viewer.file.size} bytes</div>
          ) : (
            <FileText key={viewer.path} path={viewer.path} text={viewer.file.text} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/** A file's text as an editor shows it: a line-number gutter beside syntax-highlighted code, scrolling together. */
function FileText({ path, text }: { path: string; text: string }) {
  const { text: shown, cut } = useMemo(() => limitLines(text, MAX_LINES), [text]);
  // highlight.js escapes the source and adds only its own `<span class="hljs-…">`.
  const html = useMemo(() => highlightToHtml(shown, languageForPath(path)), [shown, path]);
  const numbers = useMemo(() => {
    const count = shown.split("\n").length;
    return Array.from({ length: count }, (_, i) => i + 1).join("\n");
  }, [shown]);
  return (
    <>
      {cut ? <div className="files-note">Showing first {MAX_LINES} lines</div> : null}
      <div className="files-code">
        <pre className="files-code-gutter" aria-hidden>{numbers}</pre>
        {html === null ? (
          <pre className="files-viewer-body">{shown}</pre>
        ) : (
          <pre className="files-viewer-body" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </>
  );
}
