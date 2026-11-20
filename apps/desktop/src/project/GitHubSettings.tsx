import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Dialog, Spinner } from "../components/ui";
import { errMessage } from "../lib/format";
import { invoke } from "../platform/backend";
import { bindProjectGitHubAccount, listGitHubAccounts, type GitHubAccount, type ProjectGitHubAccount } from "../platform/githubAccounts";

export function ProjectGitHubAccountButton({ account, onOpen }: { account: ProjectGitHubAccount; onOpen?: () => void }) {
  const label = `GitHub · ${account.login ? `@${account.login}` : account.configured ? "Not connected" : "Active account in gh"}`;
  return <button type="button" className="btn btn-ghost btn-sm project-github-account"
    onClick={onOpen} title={`${label} · Open Project Settings`}>
    <Icon name="user" size={13} />
    <span className="truncate">{label}</span>
  </button>;
}

function useGitHubAccounts() {
  const [accounts, setAccounts] = useState<GitHubAccount[] | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(true);
  useEffect(() => {
    let mounted = true;
    void listGitHubAccounts().then(
      (result) => {
        if (!mounted) return;
        pending.current = false;
        setAccounts(result.accounts);
      },
      (failure: unknown) => {
        if (!mounted) return;
        pending.current = false;
        setError(errMessage(failure));
      },
    );
    return () => { mounted = false; };
  }, [refresh]);
  const reload = () => {
    if (pending.current) return;
    pending.current = true;
    setAccounts(null);
    setError("");
    setRefresh((revision) => revision + 1);
  };
  return { accounts, error, reload, loading: accounts === null && !error };
}

export function GitHubIntegrations() {
  const { accounts, error, reload, loading } = useGitHubAccounts();
  const [connecting, setConnecting] = useState(false);
  const [loginError, setLoginError] = useState("");
  const connect = async () => {
    setConnecting(true);
    setLoginError("");
    try {
      await invoke("github_login");
      reload();
    } catch (failure) {
      setLoginError(errMessage(failure));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <section className="settings-group" aria-labelledby="github-integration-title">
      <h2 id="github-integration-title">GitHub</h2>
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-title">GitHub accounts</div>
          <p className="settings-row-help">Add accounts here, then choose which account each project uses in Project Settings.</p>
        </div>
        <button className="btn btn-primary" disabled={connecting || accounts === null} onClick={() => void connect()}>
          {connecting ? <Spinner /> : <Icon name="plus" />}
          Connect account
        </button>
      </div>
      {connecting ? <p role="status">Paste the one-time code on GitHub to finish signing in.</p> : null}
      {error || loginError ? <p className="field-error" role="alert">{loginError || error}</p> : null}
      {loading ? <div className="loading-row"><Spinner /> Loading accounts…</div> : null}
      {accounts?.length === 0 ? <p className="settings-row-help">No GitHub accounts connected.</p> : null}
      {accounts?.length ? (
        <ul className="settings-account-list" aria-label="Connected GitHub accounts">
          {accounts.map((account) => (
            <li className="settings-row" key={account.login}>
              <Icon name="user" />
              <strong className="settings-row-text truncate">@{account.login}</strong>
              <span className="settings-row-help">{account.state === "error" ? "Sign-in required" : account.active ? "Active in gh" : "Saved in gh"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="settings-actions">
        <button className="btn" disabled={loading || connecting} onClick={reload}><Icon name="refresh" /> Refresh accounts</button>
      </div>
    </section>
  );
}

interface ProjectSettingsProps {
  cwd: string;
  account: ProjectGitHubAccount | null;
  accountError: string;
  onRetryAccount: () => void;
  onboarding: boolean;
  onSaved: (account: ProjectGitHubAccount) => void;
  onClose: () => void;
  onIntegrations: () => void;
}

export function ProjectGitHubSettings({ cwd, account, accountError, onRetryAccount, onboarding, onSaved, onClose, onIntegrations }: ProjectSettingsProps) {
  const { accounts, error, reload } = useGitHubAccounts();
  const [selection, setSelection] = useState<string | null>(null);
  const selectedLogin = selection ?? account?.login ?? "";
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const canSelect = account?.eligible === true;
  const save = async (login: string | null) => {
    setSaving(true);
    setSaveError("");
    try {
      onSaved(await bindProjectGitHubAccount(cwd, login));
    } catch (failure) {
      setSaveError(errMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={onboarding ? "Choose a GitHub account" : "Project Settings"}
      icon="settings"
      onClose={saving ? null : onClose}
      footer={
        <>
          <button className="btn" disabled={saving} onClick={onClose}>{onboarding ? "Later" : "Close"}</button>
          {canSelect && (onboarding || account?.login) ? (
            <button className="btn" disabled={saving} onClick={() => void save(null)}>
              {onboarding ? "Continue without GitHub" : "Disconnect from project"}
            </button>
          ) : null}
          {canSelect ? (
            <button className="btn btn-primary" disabled={saving || !accounts?.some((item) => item.login === selectedLogin)} onClick={() => void save(selectedLogin)}>
              {saving ? <Spinner /> : null}
              Use account
            </button>
          ) : null}
        </>
      }
    >
      {canSelect ? (
        <>
          <label className="field">
            <span className="field-label">GitHub account</span>
            <select value={selectedLogin} disabled={saving || !accounts?.length} onChange={(event) => setSelection(event.target.value)}>
              <option value="">Select an account</option>
              {selectedLogin && !accounts?.some((item) => item.login === selectedLogin) ? <option value={selectedLogin} disabled>@{selectedLogin} — unavailable</option> : null}
              {accounts?.map(({ login }) => <option key={login} value={login}>@{login}</option>)}
            </select>
          </label>
          <p className="settings-row-help">Review and the PR watcher use this account across the project’s worktrees.</p>
          {accounts === null && !error ? <div className="loading-row"><Spinner /> Loading accounts…</div> : null}
          {error || saveError ? <p className="field-error" role="alert">{saveError || error}</p> : null}
          <div className="settings-actions">
            {error ? <button className="btn btn-ghost" disabled={saving} onClick={reload}>Retry</button> : null}
            <button className="btn btn-ghost" disabled={saving} onClick={onIntegrations}>Manage GitHub accounts <Icon name="arrowRight" /></button>
          </div>
        </>
      ) : accountError ? (
        <>
          <p className="field-error" role="alert">{accountError}</p>
          <button className="btn" onClick={onRetryAccount}>Retry</button>
        </>
      ) : account === null ? (
        <div className="loading-row"><Spinner /> Loading project settings…</div>
      ) : <p className="settings-row-help">This project has no GitHub.com remote.</p>}
    </Dialog>
  );
}
