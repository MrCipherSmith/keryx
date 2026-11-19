import { useEffect, useMemo, useState } from "react";
import { Dialog, Spinner } from "../components/ui";
import {
  cookieImport,
  cookieProfiles,
  cookieScan,
  type BrowserEngine,
  type ChromeProfile,
  type CookieDomain,
  type CookieImportResult,
} from "../platform/panels";

const HOST = { cookieProfiles, cookieScan, cookieImport };

/** The last import of a project, kept so it can be repeated ("re-import"). */
export interface LastImport {
  profile: string;
  domains: string[];
  at: number;
}

const storeKey = (cwd: string) => `keryx.cookieImport.${cwd}`;

export function loadLastImport(cwd: string): LastImport | null {
  try {
    const raw = localStorage.getItem(storeKey(cwd));
    const v = raw ? (JSON.parse(raw) as LastImport) : null;
    return v && typeof v.profile === "string" && Array.isArray(v.domains) ? v : null;
  } catch {
    return null;
  }
}

function saveLastImport(cwd: string, v: LastImport): void {
  try {
    localStorage.setItem(storeKey(cwd), JSON.stringify(v));
  } catch {
    // Remembering is a convenience only.
  }
}

/** Domains matching the filter text, most cookies first (the host already sorted them). */
export function filterDomains(domains: readonly CookieDomain[], filter: string): CookieDomain[] {
  const f = filter.trim().toLowerCase();
  return f ? domains.filter((d) => d.domain.includes(f)) : domains.slice();
}

/**
 * Copy cookies of chosen domains from the installed Chrome into this project's Chromium profile.
 * Nothing is picked by default; it is a one-time copy, not a sync.
 */
export function CookieImportDialog({
  cwd,
  engine,
  onClose,
  host = HOST,
}: {
  cwd: string;
  engine: BrowserEngine | null;
  onClose: () => void;
  host?: typeof HOST;
}) {
  const last = useMemo(() => loadLastImport(cwd), [cwd]);
  const [profiles, setProfiles] = useState<ChromeProfile[] | null>(null);
  const [profile, setProfile] = useState<string>(last?.profile ?? "");
  const [domains, setDomains] = useState<CookieDomain[] | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(last?.domains ?? []));
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CookieImportResult | null>(null);
  const chromium = engine === "chromium";

  useEffect(() => {
    if (!chromium) return;
    let live = true;
    host
      .cookieProfiles()
      .then((list) => {
        if (!live) return;
        setProfiles(list);
        setProfile((p) => (p && list.some((x) => x.dir === p) ? p : (list[0]?.dir ?? "")));
      })
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [chromium, host]);

  useEffect(() => {
    if (!profile) return;
    let live = true;
    setDomains(null);
    host
      .cookieScan(profile)
      .then((list) => live && setDomains(list))
      .catch((e) => live && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      live = false;
    };
  }, [profile, host]);

  const shown = useMemo(() => filterDomains(domains ?? [], filter), [domains, filter]);
  const toggle = (d: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  const pickedList = [...picked].filter((d) => !domains || domains.some((x) => x.domain === d));
  const count = (domains ?? []).filter((d) => picked.has(d.domain)).reduce((n, d) => n + d.count, 0);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await host.cookieImport(profile, pickedList);
      setResult(r);
      saveLastImport(cwd, { profile, domains: pickedList, at: Date.now() });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const footer = chromium ? (
    <>
      <button className="btn" onClick={onClose}>
        {result ? "Done" : "Cancel"}
      </button>
      <button className="btn btn-primary" disabled={busy || !profile || pickedList.length === 0} onClick={() => void run()}>
        {busy ? <Spinner /> : null} {result || last ? "Re-import" : "Import"} {pickedList.length ? `${pickedList.length} domain${pickedList.length === 1 ? "" : "s"}` : ""}
      </button>
    </>
  ) : (
    <button className="btn" onClick={onClose}>
      Close
    </button>
  );

  return (
    <Dialog title="Import cookies from Chrome" icon="lock" onClose={onClose} footer={footer} width={520}>
      {!chromium ? (
        <p className="cookie-note">Importing cookies works with the Chromium browser engine only. Switch it in Settings → Browser panel.</p>
      ) : (
        <>
          <p className="cookie-note">
            A one-time copy of the sites you pick into this project's browser, not a sync: later changes in Chrome stay there until you import
            again. macOS will ask to let Keryx read Chrome's key in the Keychain.
          </p>
          {last ? (
            <p className="cookie-note">
              Last import {new Date(last.at).toLocaleString()}: {last.domains.join(", ")}.
            </p>
          ) : null}
          <div className="cookie-row">
            <label className="field grow">
              <span className="field-label">Chrome profile</span>
              <select value={profile} onChange={(e) => setProfile(e.target.value)} disabled={!profiles || busy}>
                {(profiles ?? []).map((p) => (
                  <option key={p.dir} value={p.dir}>
                    {p.name === p.dir ? p.name : `${p.name} (${p.dir})`}
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span className="field-label">Find a site</span>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="github.com" spellCheck={false} />
            </label>
          </div>
          {profiles && profiles.length === 0 ? <p className="cookie-note">No Chrome profile with cookies was found.</p> : null}
          {domains && filter.trim() && shown.length === 0 && (profiles?.length ?? 0) > 1 ? (
            <p className="cookie-note">This profile has no such site; it may be signed in under another Chrome profile.</p>
          ) : null}
          {domains === null && profile ? (
            <div className="loading-row">
              <Spinner /> Reading Chrome's sites…
            </div>
          ) : (
            <ul className="cookie-list" aria-label="Sites with cookies">
              {shown.map((d) => (
                <li key={d.domain}>
                  <label>
                    <input type="checkbox" checked={picked.has(d.domain)} onChange={() => toggle(d.domain)} disabled={busy} />
                    <span className="cookie-domain">{d.domain}</span>
                    <span className="cookie-count">{d.count}</span>
                  </label>
                </li>
              ))}
              {domains && shown.length === 0 ? <li className="cookie-note">No site matches.</li> : null}
            </ul>
          )}
          {pickedList.length ? (
            <p className="cookie-note">
              {pickedList.length} picked, {count} cookies.
            </p>
          ) : null}
          {result ? (
            <p className="cookie-done" role="status">
              Imported {result.imported} cookies{result.skipped ? `, left out ${result.skipped} (expired, partitioned or unreadable)` : ""}.
            </p>
          ) : null}
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
