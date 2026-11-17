import { useCallback, useEffect, useRef, useState } from "react";
import {
  PROVIDERS_CONNECT,
  PROVIDERS_DISCONNECT,
  PROVIDERS_LIST,
  PROVIDERS_LOGIN,
  PROVIDERS_LOGIN_CANCEL,
  PROVIDERS_TEST,
  SEARCH_PROVIDERS_CONNECT,
  SEARCH_PROVIDERS_LIST,
  SEARCH_PROVIDERS_SELECT,
  loginUrl,
  supportsDeviceLogin,
  supportsProviders,
  supportsSearchProviders,
  type LoginChallenge,
  type ProviderConnectResult,
  type ProviderDisconnectResult,
  type ProviderInfo,
  type ProviderLoginResult,
  type ProviderTestResult,
  type ProvidersListResult,
  type SearchProviderInfo,
} from "../acp/providers";
import { Icon } from "../components/Icon";
import { Dialog, Spinner } from "../components/ui";
import { openExternal } from "../platform/commands";

/** What opened the dialog: the command (`connect` or `search-provider`) and its arguments. */
export interface ProvidersRequest {
  name: string;
  args: string;
}

/** What the dialog needs from the connection to keryx. */
export interface ProvidersApi {
  request<T>(method: string, params?: unknown): Promise<T>;
  /** `initialize._meta.keryx.extensions`. */
  extensions: readonly string[];
  /** Subscribe to `_keryx/providers/login_challenge`; returns the unsubscribe. */
  onChallenge(cb: (c: LoginChallenge) => void): () => void;
  /** Opens a URL in the system browser; defaults to the app's opener. */
  openUrl?: (url: string) => void | Promise<void>;
}

/**
 * Hook point for the Providers dialog. `/connect`, `/search-provider` and the model picker call
 * `openProviders`; the window renders `<ProvidersDialog request={request} api={...} onClose={close} />`.
 */
export function useProvidersDialog() {
  const [request, setRequest] = useState<ProvidersRequest | null>(null);
  const openProviders = useCallback((name: string, args: string) => setRequest({ name, args }), []);
  const close = useCallback(() => setRequest(null), []);
  return { request, openProviders, close };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Tab = "connected" | "add" | "search";

const UPDATE_KERYX = "This keryx does not offer this yet. Update keryx to use it.";

export function ProvidersDialog({ request, api, onClose }: { request: ProvidersRequest; api: ProvidersApi; onClose: () => void }) {
  const hasProviders = supportsProviders(api.extensions);
  const hasSearch = supportsSearchProviders(api.extensions);
  const wantsSearch = request.name === "search-provider";
  const tabs: Tab[] = [...(hasProviders ? (["connected", "add"] as Tab[]) : []), ...(hasSearch ? (["search"] as Tab[]) : [])];
  const [tab, setTab] = useState<Tab>(wantsSearch ? "search" : "connected");
  const active: Tab | null = tabs.includes(tab) ? tab : (tabs[0] ?? null);
  const missing = wantsSearch ? !hasSearch : !hasProviders;

  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [presel, setPresel] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasProviders) return;
    try {
      const r = await api.request<ProvidersListResult>(PROVIDERS_LIST, {});
      setProviders(Array.isArray(r?.providers) ? r.providers : []);
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [api, hasProviders]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // `/connect openai` goes straight to that provider's form.
  const argId = request.name === "connect" ? request.args.trim().toLowerCase() : "";
  useEffect(() => {
    if (!argId || !providers) return;
    const hit = providers.find((p) => p.id.toLowerCase() === argId);
    if (hit && !hit.connected) {
      setPresel(hit.id);
      setTab("add");
    }
    // only when the list first arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers === null]);

  return (
    <Dialog
      title="Providers"
      icon="command"
      width={560}
      onClose={onClose}
      footer={
        <button className="btn" onClick={onClose}>
          Close
        </button>
      }
    >
      {missing ? (
        <div className="notice notice-warn" role="status">
          <Icon name="alert" size={14} />
          <span>{UPDATE_KERYX}</span>
        </div>
      ) : null}
      {tabs.length > 0 ? (
        <div className="tabs providers-tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t} className="tab" role="tab" aria-selected={active === t} onClick={() => setTab(t)}>
              {t === "connected" ? "Connected" : t === "add" ? "Add" : "Search"}
              {t === "connected" && providers ? <span className="tab-count">{providers.filter((p) => p.connected).length}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {note ? (
        <div className="notice notice-info" role="status">
          <Icon name="info" size={14} />
          <span>{note}</span>
        </div>
      ) : null}
      {loadError && active !== "search" ? (
        <div className="notice notice-error" role="alert">
          <Icon name="alert" size={14} />
          <span>{loadError}</span>
        </div>
      ) : null}
      {active === "connected" ? <ConnectedTab providers={providers} api={api} onChanged={refresh} setNote={setNote} /> : null}
      {active === "add" ? (
        <AddTab
          providers={providers}
          api={api}
          presel={presel}
          onConnected={(label) => {
            setNote(`${label} is connected. Pick one of its models in the model menu to use it.`);
            setPresel(null);
            setTab("connected");
            void refresh();
          }}
        />
      ) : null}
      {active === "search" ? <SearchTab api={api} setNote={setNote} /> : null}
    </Dialog>
  );
}

// ---- connected -------------------------------------------------------------------------------

function ConnectedTab({
  providers,
  api,
  onChanged,
  setNote,
}: {
  providers: ProviderInfo[] | null;
  api: ProvidersApi;
  onChanged: () => Promise<void>;
  setNote: (t: string | null) => void;
}) {
  const [busy, setBusy] = useState<Record<string, "test" | "disconnect" | undefined>>({});
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [confirm, setConfirm] = useState<ProviderInfo | null>(null);

  if (providers === null) {
    return (
      <div className="loading-row">
        <Spinner /> Loading providers…
      </div>
    );
  }
  const connected = providers.filter((p) => p.connected);
  const labelOf = (id: string) => providers.find((p) => p.id === id)?.label ?? id;

  const test = async (p: ProviderInfo) => {
    setBusy((b) => ({ ...b, [p.id]: "test" }));
    try {
      const r = await api.request<ProviderTestResult>(PROVIDERS_TEST, { providerId: p.id });
      setTests((t) => ({
        ...t,
        [p.id]: r?.ok ? { ok: true, text: typeof r.models === "number" ? `Works: ${r.models} models` : "Works" } : { ok: false, text: r?.error || "The test failed" },
      }));
    } catch (e) {
      setTests((t) => ({ ...t, [p.id]: { ok: false, text: errText(e) } }));
    } finally {
      setBusy((b) => ({ ...b, [p.id]: undefined }));
    }
  };

  const disconnect = async (p: ProviderInfo) => {
    setConfirm(null);
    setBusy((b) => ({ ...b, [p.id]: "disconnect" }));
    try {
      const r = await api.request<ProviderDisconnectResult>(PROVIDERS_DISCONNECT, { providerId: p.id });
      const shared = (r?.sharedEnvWith ?? []).map(labelOf);
      setNote(
        shared.length > 0
          ? `${p.label} is disconnected here, but the same environment variable still connects ${shared.join(", ")}.`
          : `${p.label} is disconnected.`,
      );
      setTests((t) => {
        const { [p.id]: _gone, ...rest } = t;
        return rest;
      });
      await onChanged();
    } catch (e) {
      setNote(`Could not disconnect ${p.label}: ${errText(e)}`);
    } finally {
      setBusy((b) => ({ ...b, [p.id]: undefined }));
    }
  };

  if (connected.length === 0) return <p className="field-hint">No provider is connected yet. Use the Add tab.</p>;
  return (
    <>
      <ul className="providers-list">
        {connected.map((p) => (
          <li key={p.id} className="providers-row" data-provider={p.id}>
            <div className="providers-row-main">
              <span className="providers-row-label">{p.label}</span>
              {p.baseUrl ? <span className="providers-row-detail mono truncate">{p.baseUrl}</span> : null}
              {tests[p.id] ? <span className={`providers-test ${tests[p.id]!.ok ? "is-ok" : "is-bad"}`}>{tests[p.id]!.text}</span> : null}
              {p.refusal ? <span className="field-hint">{p.refusal}</span> : null}
            </div>
            <button className="btn btn-sm" disabled={busy[p.id] !== undefined} onClick={() => void test(p)}>
              {busy[p.id] === "test" ? "Testing…" : "Test"}
            </button>
            <button className="btn btn-sm" disabled={busy[p.id] !== undefined} onClick={() => setConfirm(p)}>
              Disconnect
            </button>
          </li>
        ))}
      </ul>
      {confirm ? (
        <Dialog
          title={`Disconnect ${confirm.label}?`}
          icon="alert"
          tone="warn"
          width={400}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void disconnect(confirm)}>
                Disconnect
              </button>
            </>
          }
        >
          <p className="field-hint">keryx removes the saved credential. Sessions using this provider keep their model until you change it.</p>
        </Dialog>
      ) : null}
    </>
  );
}

// ---- add ----------------------------------------------------------------------------------------

const CUSTOM = "__custom__";

function AddTab({ providers, api, presel, onConnected }: { providers: ProviderInfo[] | null; api: ProvidersApi; presel: string | null; onConnected: (label: string) => void }) {
  const [picked, setPicked] = useState<string | null>(presel);
  useEffect(() => setPicked(presel), [presel]);
  if (providers === null) {
    return (
      <div className="loading-row">
        <Spinner /> Loading providers…
      </div>
    );
  }
  const p = picked && picked !== CUSTOM ? providers.find((x) => x.id === picked) : undefined;
  if (picked === CUSTOM) {
    return (
      <>
        <BackLink onClick={() => setPicked(null)} />
        <CustomForm api={api} onConnected={onConnected} />
      </>
    );
  }
  if (p) {
    return (
      <>
        <BackLink onClick={() => setPicked(null)} />
        <ConnectForm key={p.id} provider={p} api={api} onConnected={() => onConnected(p.label)} />
      </>
    );
  }
  return (
    <ul className="providers-list">
      {providers.map((x) => (
        <li key={x.id} className="providers-row" data-provider={x.id}>
          <div className="providers-row-main">
            <span className="providers-row-label">{x.label}</span>
            {x.refusal ? (
              <span className="providers-refusal">{x.refusal}</span>
            ) : x.connected ? (
              <span className="field-hint">Connected</span>
            ) : null}
          </div>
          <button className="btn btn-sm" disabled={!!x.refusal} onClick={() => setPicked(x.id)}>
            {x.connected ? "Reconnect" : "Connect"}
          </button>
        </li>
      ))}
      <li className="providers-row" data-provider={CUSTOM}>
        <div className="providers-row-main">
          <span className="providers-row-label">Custom provider</span>
          <span className="field-hint">Any OpenAI-compatible endpoint.</span>
        </div>
        <button className="btn btn-sm" onClick={() => setPicked(CUSTOM)}>
          Add
        </button>
      </li>
    </ul>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn btn-sm btn-ghost providers-back" onClick={onClick}>
      <Icon name="chevronRight" size={12} className="flip" /> All providers
    </button>
  );
}

/** Readable text for a failed connect: the reason, and what to retry. */
function retryHint(r: ProviderConnectResult): string {
  const base = r.error || "keryx could not connect.";
  if (r.retry === "credential") return `${base} Check the API key and try again.`;
  if (r.retry === "base-url") return `${base} Check the base URL and try again.`;
  return base;
}

/**
 * An API key goes from this field to keryx once. It lives only in the input element: never in React
 * state, never logged or rendered. The field is emptied before the request is sent, and any reply text is
 * scrubbed of the key in case keryx echoes it.
 */
function ConnectForm({ provider, api, onConnected }: { provider: ProviderInfo; api: ProvidersApi; onConnected: () => void }) {
  const hasKey = provider.authMethods.includes("api-key");
  const hasDevice = provider.authMethods.includes("device-code");
  const keyRef = useRef<HTMLInputElement>(null);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const el = keyRef.current;
    const key = el?.value ?? "";
    if (el) el.value = "";
    if (hasKey && !key) {
      setError("Enter the API key.");
      return;
    }
    const url = baseUrl.trim();
    if (provider.needsBaseUrl && !url) {
      setError("Enter the base URL.");
      return;
    }
    const scrub = (t: string): string => (key ? t.split(key).join("•••") : t);
    setBusy(true);
    setError(null);
    try {
      const params: Record<string, unknown> = { providerId: provider.id, method: hasKey ? "api-key" : "none" };
      if (hasKey) params.apiKey = key;
      if (provider.needsBaseUrl) params.baseUrl = url;
      const r = await api.request<ProviderConnectResult>(PROVIDERS_CONNECT, params);
      if (r?.ok) onConnected();
      else setError(scrub(retryHint(r ?? { ok: false })));
    } catch (e) {
      setError(scrub(errText(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="providers-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="providers-form-title">{provider.label}</h3>
      {provider.needsBaseUrl ? (
        <label className="field">
          <span className="field-label">Base URL</span>
          <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://host.example/v1" spellCheck={false} />
        </label>
      ) : null}
      {hasKey ? (
        <label className="field">
          <span className="field-label">API key</span>
          <input ref={keyRef} type="password" autoComplete="off" spellCheck={false} data-autofocus name="provider-api-key" />
          <span className="field-hint">Sent to keryx once and saved there. The app never keeps it.</span>
        </label>
      ) : null}
      {error ? <div className="field-error" role="alert">{error}</div> : null}
      {hasKey || (!hasDevice && provider.authMethods.includes("none")) ? (
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      ) : null}
      {hasDevice ? <DeviceLogin provider={provider} api={api} onConnected={onConnected} /> : null}
    </form>
  );
}

function CustomForm({ api, onConnected }: { api: ProvidersApi; onConnected: (label: string) => void }) {
  const keyRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const el = keyRef.current;
    const key = el?.value ?? "";
    if (el) el.value = "";
    if (!name.trim() || !baseUrl.trim()) {
      setError("A name and a base URL are required.");
      return;
    }
    const scrub = (t: string): string => (key ? t.split(key).join("•••") : t);
    setBusy(true);
    setError(null);
    try {
      const custom: Record<string, string> = { name: name.trim(), baseUrl: baseUrl.trim() };
      if (key) custom.apiKey = key;
      const r = await api.request<ProviderConnectResult>(PROVIDERS_CONNECT, { custom });
      if (r?.ok) onConnected(name.trim());
      else setError(scrub(retryHint(r ?? { ok: false })));
    } catch (e) {
      setError(scrub(errText(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="providers-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="providers-form-title">Custom provider</h3>
      <label className="field">
        <span className="field-label">Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} name="custom-name" />
      </label>
      <label className="field">
        <span className="field-label">Base URL</span>
        <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://host.example/v1" spellCheck={false} name="custom-base-url" />
      </label>
      <label className="field">
        <span className="field-label">API key (optional)</span>
        <input ref={keyRef} type="password" autoComplete="off" spellCheck={false} name="custom-api-key" />
      </label>
      {error ? <div className="field-error" role="alert">{error}</div> : null}
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "Connecting…" : "Add provider"}
      </button>
    </form>
  );
}

// ---- device code ---------------------------------------------------------------------------------

function DeviceLogin({ provider, api, onConnected }: { provider: ProviderInfo; api: ProvidersApi; onConnected: () => void }) {
  const supported = supportsDeviceLogin(api.extensions);
  const [waiting, setWaiting] = useState(false);
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loginId = useRef<string | null>(null);
  const live = useRef(false);

  useEffect(() => {
    live.current = true;
    const off = api.onChallenge((c) => {
      if (c.providerId !== provider.id) return;
      loginId.current = c.loginId;
      setChallenge(c);
    });
    return () => {
      live.current = false;
      off();
      // Closing the dialog mid-login ends the login on keryx's side too.
      if (loginId.current) void api.request(PROVIDERS_LOGIN_CANCEL, { loginId: loginId.current }).catch(() => {});
    };
  }, [api, provider.id]);

  if (!supported) return <p className="field-hint">This keryx cannot sign in from the app. Update keryx.</p>;

  const start = async () => {
    setWaiting(true);
    setMessage(null);
    setChallenge(null);
    loginId.current = null;
    try {
      const r = await api.request<ProviderLoginResult>(PROVIDERS_LOGIN, { providerId: provider.id });
      if (!live.current) return;
      loginId.current = null;
      if (r?.outcome === "connected") onConnected();
      else setMessage(r?.outcome === "cancelled" ? "Sign-in cancelled." : r?.error || "Sign-in failed.");
    } catch (e) {
      if (live.current) setMessage(errText(e));
    } finally {
      if (live.current) {
        setWaiting(false);
        setChallenge(null);
      }
    }
  };

  const cancel = () => {
    if (loginId.current) void api.request(PROVIDERS_LOGIN_CANCEL, { loginId: loginId.current }).catch(() => {});
  };

  const open = async (url: string) => {
    try {
      await (api.openUrl ?? openExternal)(url);
    } catch (e) {
      setMessage(`Could not open the browser (${errText(e)}). Open ${url} yourself.`);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(challenge!.userCode);
      setCopied(true);
      window.setTimeout(() => live.current && setCopied(false), 1500);
    } catch {
      setMessage("Could not copy. Select the code and copy it.");
    }
  };

  if (!waiting) {
    return (
      <div className="providers-device">
        <button type="button" className="btn btn-primary" onClick={() => void start()}>
          Sign in with {provider.label}
        </button>
        {message ? <div className="field-hint" role="status">{message}</div> : null}
      </div>
    );
  }
  return (
    <div className="providers-device" role="status">
      {challenge ? (
        <>
          <div className="field-hint">{challenge.instructions || "Enter this code on the sign-in page."}</div>
          <div className="device-code" aria-label="Sign-in code">
            {challenge.userCode}
          </div>
          <div className="device-code-url mono truncate">{challenge.verificationUri}</div>
          <div className="providers-device-actions">
            <button type="button" className="btn btn-sm" onClick={() => void copy()}>
              <Icon name="copy" size={13} /> {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void open(loginUrl(challenge))}>
              <Icon name="external" size={13} /> Open browser
            </button>
          </div>
          <div className="field-hint">
            <Spinner size={12} /> Waiting for you to approve in the browser…
          </div>
        </>
      ) : (
        <div className="field-hint">
          <Spinner size={12} /> Asking {provider.label} for a code…
        </div>
      )}
      {message ? <div className="field-hint">{message}</div> : null}
      <button type="button" className="btn btn-sm" onClick={cancel} disabled={!challenge}>
        Cancel
      </button>
    </div>
  );
}

// ---- search providers --------------------------------------------------------------------------------

function SearchTab({ api, setNote }: { api: ProvidersApi; setNote: (t: string | null) => void }) {
  const [list, setList] = useState<SearchProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef<Record<string, HTMLInputElement | null>>({});

  const refresh = useCallback(async () => {
    try {
      const r = await api.request<{ providers?: SearchProviderInfo[] }>(SEARCH_PROVIDERS_LIST, {});
      setList(Array.isArray(r?.providers) ? r.providers : []);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async (p: SearchProviderInfo) => {
    const el = keys.current[p.id];
    const key = el?.value ?? "";
    if (el) el.value = "";
    if (!key) {
      setError("Enter the API key.");
      return;
    }
    setBusy(p.id);
    setError(null);
    try {
      const r = await api.request<{ ok?: boolean; error?: string }>(SEARCH_PROVIDERS_CONNECT, { providerId: p.id, apiKey: key });
      if (r?.ok === false) setError((r.error || "keryx could not connect.").split(key).join("•••"));
      else setNote(`${p.label} is connected.`);
      await refresh();
    } catch (e) {
      setError(errText(e).split(key).join("•••"));
    } finally {
      setBusy(null);
    }
  };

  const select = async (p: SearchProviderInfo) => {
    setBusy(p.id);
    setError(null);
    try {
      const r = await api.request<{ ok?: boolean; error?: string }>(SEARCH_PROVIDERS_SELECT, { providerId: p.id });
      if (r?.ok === false) setError(r.error || "keryx could not switch search provider.");
      else setNote(`${p.label} is now the search provider.`);
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (list === null) {
    return error ? (
      <div className="notice notice-error" role="alert">
        <Icon name="alert" size={14} />
        <span>{error}</span>
      </div>
    ) : (
      <div className="loading-row">
        <Spinner /> Loading search providers…
      </div>
    );
  }
  return (
    <>
      {error ? <div className="field-error" role="alert">{error}</div> : null}
      <ul className="providers-list">
        {list.map((p) => (
          <li key={p.id} className="providers-row" data-search-provider={p.id}>
            <div className="providers-row-main">
              <span className="providers-row-label">
                {p.label} {p.selected ? <span className="badge badge-ok">in use</span> : null}
              </span>
              {p.refusal ? <span className="providers-refusal">{p.refusal}</span> : null}
            </div>
            {p.refusal ? null : p.connected ? (
              <button className="btn btn-sm" disabled={p.selected || busy !== null} onClick={() => void select(p)}>
                Use
              </button>
            ) : p.needsKey === false ? (
              <button className="btn btn-sm" disabled={busy !== null} onClick={() => void select(p)}>
                Use
              </button>
            ) : (
              <>
                <input
                  ref={(el) => {
                    keys.current[p.id] = el;
                  }}
                  type="password"
                  autoComplete="off"
                  aria-label={`${p.label} API key`}
                  className="providers-inline-key"
                />
                <button className="btn btn-sm" disabled={busy !== null} onClick={() => void connect(p)}>
                  Connect
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
