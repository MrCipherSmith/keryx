import { useEffect, useState } from "react";
import type { IssueRef } from "../../../../src/integrations/issues-contract";
import { errMessage } from "../lib/format";
import { listGitHubAccounts, type GitHubAccount } from "../platform/githubAccounts";
import { IssueOriginDetail, type IssueOriginRequest } from "./IssueOriginDetail";
import { IssuesBoard } from "./IssuesBoard";
import type { WorkAction } from "./IssueWork";

export function IssuesView({cwd, preferred, onWork, onSettings, origin, onCloseOrigin}: {
  origin?: IssueOriginRequest | null; onCloseOrigin?: () => void;
  cwd: string; preferred?: string; onSettings: () => void;
  onWork: (login: string, action: WorkAction, issue: IssueRef, flowDir?: string) => Promise<void>;
}) {
  const [accounts, setAccounts] = useState<GitHubAccount[]>([]);
  const [chosen, choose] = useState("");
  const [attempt, refresh] = useState(0);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError("");
    void listGitHubAccounts().then(({accounts}) => {
      if (alive) setAccounts(accounts.filter(account => account.state !== "error"));
    }).catch(reason => {
      if (alive) { setAccounts([]); setError(errMessage(reason)); }
    }).finally(() => { if (alive) setLoaded(true); });
    return () => {alive = false;};
  }, [attempt, preferred]);
  const login = accounts.find(a => a.login === chosen)?.login
    ?? accounts.find(a => a.login === preferred)?.login ?? accounts.find(a => a.active)?.login ?? accounts[0]?.login;
  return <div className="issues-view">
    {loaded && login && <><label className="issues-account">GitHub account <select value={login} onChange={event => choose(event.target.value)}>
      {accounts.map(account => <option key={account.login}>{account.login}</option>)}
    </select></label>
      {origin && onCloseOrigin
        ? <IssueOriginDetail key={JSON.stringify([cwd,login,origin])} cwd={cwd} login={login} origin={origin} close={onCloseOrigin}
            onWork={(action, issue, flowDir) => onWork(login, action, issue, flowDir)} />
        : <IssuesBoard key={JSON.stringify([cwd,login])} cwd={cwd} login={login} onSettings={onSettings}
        onWork={(action, issue, flowDir) => onWork(login, action, issue, flowDir)} />}</>}
    {!loaded && <p role="status">Loading GitHub accounts…</p>}
    {loaded && !login && <div role="status"><p>{error || "Connect a GitHub account to view issues."}</p>
      <button className="btn" onClick={onSettings}>GitHub settings</button> <button className="btn" onClick={() => refresh(n => n+1)}>Retry</button></div>}
  </div>;
}
