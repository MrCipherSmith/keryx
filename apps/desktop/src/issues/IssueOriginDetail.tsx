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
  request?: typeof requestIssues;
}
interface Result { viewer: IssueViewer; issue: Detail | null }

/** Deep link independently of the current board's source, filters, and paginated window. */
export function IssueOriginDetail({ cwd, login, origin, close, onWork, request = requestIssues }: Props) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [workError, setWorkError] = useState("");
  const [attempt, retry] = useState(0);
  const [busy, setBusy] = useState(false);
  const loseAccess = useCallback((reason: string) => { setResult(null); setWorkError(""); setError(reason); }, []);
  useEffect(() => {
    let live = true;
    setResult(null);
    setError("");
    void request<Result>(cwd, login, "origin", origin).then(value => {
      if (live) setResult(value);
    }).catch(reason => { if (live) loseAccess(errMessage(reason)); });
    return () => { live = false; };
  }, [cwd, login, origin, attempt, loseAccess, request]);
  const row = result?.issue;
  const work = async (action: "open-session" | "open-flow" | "prepare-flow") => {
    if (!row || busy) return;
    setBusy(true);
    setWorkError("");
    try {
      await onWork(action, row.ref, "flowDir" in origin ? origin.flowDir : undefined);
      if (action === "prepare-flow") retry(n => n + 1);
    }
    catch (reason) {
      const message = errMessage(reason);
      if (isAccessError(message)) loseAccess(message);
      else {
        setWorkError(message);
        if (action === "prepare-flow") retry(n => n + 1);
      }
    } finally { setBusy(false); }
  };
  return <div className="issue-workspace issue-origin">
    {workError && <p role="alert">{workError}</p>}
    {error && <p role="alert">{error} <button className="btn btn-sm" onClick={() => retry(n => n + 1)}>Retry</button></p>}
    {row && result && <IssueDetail cwd={cwd} login={login} viewer={result.viewer} row={row} request={request}
      close={close} onAccessLost={loseAccess} mobile={false} verifiedDetail={row} actions={<>
        <button className="btn btn-sm" disabled={busy} onClick={() => void work("open-session")}>Open session</button>
        {"flowDir" in origin || (row.work && row.work.stage !== "none")
          ? <button className="btn btn-sm" disabled={busy} onClick={() => void work("open-flow")}>Open Flow</button>
          : <button className="btn btn-sm" disabled={busy} onClick={() => void work("prepare-flow")}>Prepare Flow</button>}
        {row.work?.canResumePreparation && <button className="btn btn-sm" disabled={busy}
          onClick={() => void work("prepare-flow")}>Resume preparation</button>}
      </>} />}
    {!row && <div className="issues-notice">
      {!error && <p role="status">{result ? "No linked issue was found." : "Loading source issue…"}</p>}
      <button className="btn btn-sm" onClick={close}>Back to Issues</button>
    </div>}
  </div>;
}
