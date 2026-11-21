import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
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

type Viewer =
  | { state: "loading"; path: string }
  | { state: "error"; path: string; message: string }
  | { state: "ready"; path: string; file: ProjectFileContent };

const message = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

/** The Files tab of the side panel: the project's tree, a search box and a read-only viewer. */
export function FilesPanel({ cwd, visible, api = REAL_API }: { cwd: string; visible: boolean; api?: FilesApi }) {
  const [all, setAll] = useState<ProjectFiles | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<ProjectFiles | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [copied, setCopied] = useState(false);
  const [started, setStarted] = useState(false);
  const [retry, setRetry] = useState(0);
  const alive = useRef(true);
  const listReq = useRef(0);
  const searchReq = useRef(0);
  const readReq = useRef(0);

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
    readReq.current++;
    setAll(null);
    setFound(null);
    setQuery("");
    setViewer(null);
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

  const open = (path: string) => {
    const id = ++readReq.current;
    setCopied(false);
    setViewer({ state: "loading", path });
    api.read(cwd, path).then(
      (file) => alive.current && id === readReq.current && setViewer({ state: "ready", path, file }),
      (e) => alive.current && id === readReq.current && setViewer({ state: "error", path, message: message(e) }),
    );
  };

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(`@${path}`).then(
      () => alive.current && setCopied(true),
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
  const current = viewer?.path ?? null;

  return (
    <div className="files-panel" data-testid="files-panel">
      <div className="files-search">
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
                className={`files-row${current === p ? " is-active" : ""}`}
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
                className={`files-row${current === node.path ? " is-active" : ""}`}
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
      {viewer ? (
        <div className="files-viewer" data-testid="files-viewer">
          <div className="files-viewer-head">
            <span className="files-viewer-path" title={viewer.path}>{viewer.path}</span>
            <button className="btn btn-sm" onClick={() => copyPath(viewer.path)}>{copied ? "Copied" : "Copy @path"}</button>
          </div>
          {viewer.state === "loading" ? (
            <div className="files-note">Loading…</div>
          ) : viewer.state === "error" ? (
            <div className="files-error" role="alert">{viewer.message}</div>
          ) : viewer.file.binary || viewer.file.text === null ? (
            <div className="files-note">Binary file, {viewer.file.size} bytes</div>
          ) : (
            <FileText text={viewer.file.text} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function FileText({ text }: { text: string }) {
  const { text: shown, cut } = useMemo(() => limitLines(text, MAX_LINES), [text]);
  return (
    <>
      {cut ? <div className="files-note">Showing first {MAX_LINES} lines</div> : null}
      <pre className="files-viewer-body">{shown}</pre>
    </>
  );
}
