import { useCallback, useEffect, useState } from "react";
import { type IssueDetail as Detail, type IssueViewer } from "../../../../src/integrations/issues-contract";
import { errMessage } from "../lib/format";
import { requestIssues } from "../platform/issues";
import { IssueDetail, type WorkProps } from "./IssueDetail";
import { isAccessError } from "./useIssueCollection";

export type IssueOriginRequest = { sessionId: string } | { flowDir: string };
interface Props extends WorkProps {
  cwd: string;
  login: string;
  origin: IssueOriginRequest;
  close: () => void;
}
interface Result { viewer: IssueViewer; issue: Detail | null }

/** Deep link independently of the current board's source, filters, and paginated window. */
export function IssueOriginDetail({ cwd, login, origin, close, onWork }: Props) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const loseAccess = useCallback((reason: string) => { setResult(null); setError(reason); }, []);
  useEffect(() => {
    let live = true;
    setResult(null);
    setError("");
    void requestIssues<Result>(cwd, login, "origin", origin).then(value => {
      if (live) setResult(value);
    }).catch(reason => { if (live) loseAccess(errMessage(reason)); });
    return () => { live = false; };
  }, [cwd, login, origin, attempt, loseAccess]);
  const row = result?.issue;
  const work = async (action: "open-session" | "open-flow" | "prepare-flow") => {
    if (!row || busy) return;
    setBusy(true);
    try { await onWork(action, row.ref, "flowDir" in origin ? origin.flowDir : undefined); }
    catch (reason) {
      const message = errMessage(reason);
      if (isAccessError(message)) loseAccess(message); else setError(message);
    } finally { setBusy(false); }
  };
  return <div className="issue-workspace issue-origin">
    {error && <p role="alert">{error} <button className="btn btn-sm" onClick={() => retry(n => n + 1)}>Retry</button></p>}
    {row && result && <IssueDetail cwd={cwd} login={login} viewer={result.viewer} row={row} request={requestIssues}
      close={close} onAccessLost={loseAccess} mobile={false} verifiedDetail={row} actions={<>
        <button className="btn btn-sm" disabled={busy} onClick={() => void work("open-session")}>Open session</button>
        {"flowDir" in origin || (row.work && row.work.stage !== "none")
          ? <button className="btn btn-sm" disabled={busy} onClick={() => void work("open-flow")}>Open Flow</button>
          : <button className="btn btn-sm" disabled={busy} onClick={() => void work("prepare-flow")}>Prepare Flow</button>}
      </>} />}
    {!row && <div className="issues-notice">
      {!error && <p role="status">{result ? "No linked issue was found." : "Loading source issue…"}</p>}
      <button className="btn btn-sm" onClick={close}>Back to Issues</button>
    </div>}
  </div>;
}
