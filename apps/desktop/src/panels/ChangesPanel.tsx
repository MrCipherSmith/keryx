import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import { highlightToHtml, languageForPath } from "../components/highlight";
import { numberedDiffLines, type NumberedDiffLine } from "../components/unifiedDiff";
import { errMessage } from "../lib/format";
import { gitChanges, gitFileDiff, gitInfo, type ChangedFile, type FileDiff } from "../platform/commands";
import type { LineComment } from "../session/lineComments";

/** More files than this wait behind a "Show more" button; so do diff lines past `LINE_CAP`. */
export const FILE_CAP = 200;
export const LINE_CAP = 2000;
const POLL_MS = 10_000;

/** The host reads the panel makes; a test passes its own. */
export interface ChangesApi {
  changes: typeof gitChanges;
  fileDiff: typeof gitFileDiff;
  info: typeof gitInfo;
}
const HOST: ChangesApi = { changes: gitChanges, fileDiff: gitFileDiff, info: gitInfo };

type Side = "new" | "old";
interface Selection { side: Side; anchor: number; start: number; end: number }
type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; value: T };

/** A click on a line number: a plain click selects that line, a shift-click extends the range on the same side. */
export function extendSelection(current: Selection | null, side: Side, line: number, shift: boolean): Selection {
  if (shift && current && current.side === side) {
    return { side, anchor: current.anchor, start: Math.min(current.anchor, line), end: Math.max(current.anchor, line) };
  }
  return { side, anchor: line, start: line, end: line };
}

const STATUS_TITLE: Record<ChangedFile["status"], string> = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", "?": "Untracked" };

/** The changed files of the project and the diff of one of them; a line can be commented on for the next message. */
export function ChangesPanel({ cwd, busy, canComment, onComment, api = HOST }: {
  cwd: string;
  /** A turn is running: the list is read again when it ends. */
  busy: boolean;
  canComment: boolean;
  /** Add the comment to the next message; false when it could not be added. */
  onComment: (comment: LineComment) => boolean;
  api?: ChangesApi;
}) {
  const [list, setList] = useState<Loaded<{ files: ChangedFile[]; truncated: boolean }>>({ state: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(FILE_CAP);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const value = await api.changes(cwd);
      if (mine === seq.current) setList({ state: "ready", value });
    } catch (e) {
      if (mine === seq.current) setList({ state: "error", message: errMessage(e) });
    }
  }, [cwd, api]);

  // Read when opened, when the folder changes and when a turn ends.
  useEffect(() => {
    if (!busy) void refresh();
  }, [refresh, busy]);

  // Read again when the session's changed-files count moves (the footer reads the same number).
  useEffect(() => {
    let live = true;
    let last: number | undefined;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      const info = await api.info(cwd).catch(() => null);
      if (!live || !info) return;
      const before = last;
      last = info.changed;
      if (before !== undefined && before !== info.changed) void refresh();
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [cwd, refresh, api]);

  const files = list.state === "ready" ? list.value.files : null;
  useEffect(() => {
    if (files && selected && !files.some((f) => f.path === selected)) setSelected(null);
  }, [files, selected]);

  return (
    <div className="changes-panel">
      <div className="changes-head">
        <span className="grow">{files ? (files.length === 0 ? "No changes" : `${files.length} changed file${files.length === 1 ? "" : "s"}`) : "Changes"}</span>
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => void refresh()} aria-label="Refresh changes" title="Refresh">
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {list.state === "loading" ? <div className="changes-note" role="status"><Spinner size={14} /> Reading changes…</div> : null}
      {list.state === "error" ? <div className="changes-note changes-error" role="alert">{list.message}</div> : null}
      {files && files.length > 0 ? (
        <>
          <ul className="changes-files" aria-label="Changed files">
            {files.slice(0, showFiles).map((f) => (
              <FileRow key={f.path} file={f} selected={f.path === selected} onSelect={setSelected} />
            ))}
          </ul>
          {files.length > showFiles ? (
            <button type="button" className="btn btn-sm changes-more" onClick={() => setShowFiles((n) => n + FILE_CAP)}>
              Show {Math.min(FILE_CAP, files.length - showFiles)} more
            </button>
          ) : null}
          {list.state === "ready" && list.value.truncated ? (
            <div className="changes-note" role="status">Only the first {files.length} changed files are listed.</div>
          ) : null}
        </>
      ) : null}
      {selected && files?.some((f) => f.path === selected) ? (
        <DiffView key={selected} cwd={cwd} api={api} path={selected} version={files} canComment={canComment} onComment={onComment} />
      ) : files && files.length > 0 ? (
        <div className="changes-note">Select a file to see its diff.</div>
      ) : null}
    </div>
  );
}

const FileRow = memo(function FileRow({ file, selected, onSelect }: { file: ChangedFile; selected: boolean; onSelect: (path: string) => void }) {
  return (
    <li>
      <button type="button" className={`changes-file${selected ? " is-active" : ""}`} aria-current={selected ? "true" : undefined} onClick={() => onSelect(file.path)}>
        <span className={`changes-status changes-status-${file.status === "?" ? "U" : file.status}`} title={STATUS_TITLE[file.status]} aria-label={STATUS_TITLE[file.status]}>
          {file.status}
        </span>
        <span className="changes-path truncate" title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}>
          {file.path}
          {file.origPath ? <span className="changes-orig"> ← {file.origPath}</span> : null}
        </span>
        {file.staged ? <span className="changes-staged" title="Staged">staged</span> : null}
      </button>
    </li>
  );
});

function DiffView({ cwd, api, path, version, canComment, onComment }: {
  cwd: string;
  api: ChangesApi;
  path: string;
  /** Changes whenever the list is read again, so the diff is too. */
  version: unknown;
  canComment: boolean;
  onComment: (comment: LineComment) => boolean;
}) {
  const [diff, setDiff] = useState<Loaded<FileDiff>>({ state: "loading" });
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    // A re-read keeps the diff on screen until the new one arrives.
    api.fileDiff(cwd, path).then(
      (value) => mine === seq.current && setDiff({ state: "ready", value }),
      (e) => mine === seq.current && setDiff({ state: "error", message: errMessage(e) }),
    );
    return () => void ++seq.current;
  }, [cwd, api, path, version]);

  return (
    <div className="changes-diff">
      <div className="changes-diff-head truncate" title={path}>{path}</div>
      {diff.state === "loading" ? <div className="changes-note" role="status"><Spinner size={14} /> Reading diff…</div> : null}
      {diff.state === "error" ? <div className="changes-note changes-error" role="alert">{diff.message}</div> : null}
      {diff.state === "ready" ? <DiffBody diff={diff.value} canComment={canComment} onComment={onComment} /> : null}
    </div>
  );
}

function DiffBody({ diff, canComment, onComment }: { diff: FileDiff; canComment: boolean; onComment: (comment: LineComment) => boolean }) {
  const [shown, setShown] = useState(LINE_CAP);
  const [sel, setSel] = useState<Selection | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const lines = useMemo(() => (diff.text ? numberedDiffLines(diff.text) : []), [diff.text]);
  const lang = languageForPath(diff.path);
  const html = useMemo(
    () => lines.slice(0, shown).map((l) => (l.kind === "add" || l.kind === "del" || l.kind === "ctx") && lang ? highlightToHtml(l.text.slice(1), lang) : null),
    [lines, shown, lang],
  );
  // The diff changed under an open selection (a re-read): the line numbers may no longer mean the same lines.
  useEffect(() => setSel(null), [diff.text]);

  if (diff.binary) return <div className="changes-note">Binary file; no diff to show.</div>;
  if (diff.tooLarge) return <div className="changes-note">This diff is too large to show.</div>;
  if (!diff.text || lines.length === 0) return <div className="changes-note">No textual changes.</div>;

  const numberOf = (l: NumberedDiffLine, side: Side) => (side === "new" ? l.newNo : l.oldNo);
  const inSel = (l: NumberedDiffLine) => {
    if (!sel) return false;
    const n = numberOf(l, sel.side);
    return n !== undefined && n >= sel.start && n <= sel.end;
  };
  let formAfter = -1;
  if (sel) lines.slice(0, shown).forEach((l, i) => { if (numberOf(l, sel.side) === sel.end) formAfter = i; });
  const pick = (side: Side, line: number, shift: boolean) => {
    setNotice(null);
    setSel((cur) => extendSelection(cur, side, line, shift));
  };
  const submit = () => {
    if (!sel || !text.trim()) return;
    const ok = onComment({ path: diff.path, startLine: sel.start, endLine: sel.end, side: sel.side, text: text.trim() });
    if (ok) {
      setSel(null);
      setText("");
      setNotice({ ok: true, text: "Comment added to your next message." });
    } else setNotice({ ok: false, text: "The comment could not be added." });
  };

  return (
    <>
      {notice ? <div className={`changes-note${notice.ok ? "" : " changes-error"}`} role={notice.ok ? "status" : "alert"}>{notice.text}</div> : null}
      <div className="changes-lines" role="group" aria-label={`Diff of ${diff.path}`}>
        {lines.slice(0, shown).map((l, i) => (
          <div key={i} className="changes-row-group">
            <div className={`changes-line changes-${l.kind}${inSel(l) ? " is-selected" : ""}`}>
              <Gutter line={l} side="old" enabled={canComment} onPick={pick} />
              <Gutter line={l} side="new" enabled={canComment} onPick={pick} />
              {html[i] ? (
                <span className="changes-code hljs">
                  <span className="changes-sign">{l.text[0]}</span>
                  <span dangerouslySetInnerHTML={{ __html: html[i] ?? "" }} />
                </span>
              ) : (
                <span className="changes-code">{l.text || " "}</span>
              )}
            </div>
            {sel && i === formAfter ? (
              <form className="changes-comment" onSubmit={(e) => { e.preventDefault(); submit(); }}>
                <label className="changes-comment-label">
                  Comment on {sel.side === "old" ? "old " : ""}line{sel.end > sel.start ? `s ${sel.start}-${sel.end}` : ` ${sel.start}`}
                  <textarea
                    rows={2}
                    value={text}
                    autoFocus
                    placeholder="What should change here?"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") { e.preventDefault(); setSel(null); }
                      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
                    }}
                  />
                </label>
                <div className="changes-comment-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setSel(null)}>Cancel</button>
                  <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim()}>Add comment</button>
                </div>
              </form>
            ) : null}
          </div>
        ))}
      </div>
      {lines.length > shown ? (
        <button type="button" className="btn btn-sm changes-more" onClick={() => setShown((n) => n + LINE_CAP)}>
          Show {Math.min(LINE_CAP, lines.length - shown)} more lines
        </button>
      ) : null}
    </>
  );
}

function Gutter({ line, side, enabled, onPick }: { line: NumberedDiffLine; side: Side; enabled: boolean; onPick: (side: Side, line: number, shift: boolean) => void }) {
  const n = side === "new" ? line.newNo : line.oldNo;
  if (n === undefined) return <span className={`changes-gutter changes-gutter-${side}`} />;
  return enabled ? (
    <button
      type="button"
      className={`changes-gutter changes-gutter-${side} is-pickable`}
      aria-label={`Comment on ${side} line ${n}`}
      title="Click to comment; Shift-click extends the range"
      onClick={(e) => onPick(side, n, e.shiftKey)}
    >
      {n}
    </button>
  ) : (
    <span className={`changes-gutter changes-gutter-${side}`}>{n}</span>
  );
}
