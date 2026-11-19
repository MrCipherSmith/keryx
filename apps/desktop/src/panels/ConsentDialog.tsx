import { useEffect, useState } from "react";
import { Dialog } from "../components/ui";
import { browserConsentAnswer, onConsent, onConsentClosed, type ConsentRequest } from "../platform/panels";

/**
 * The host's question before the agent acts on a site that is not local (owner decision: always,
 * even in trust and auto). One at a time; Esc or closing is a no; no answer in time is a no too
 * (the host then closes the question).
 */
const HOST = { onConsent, onConsentClosed, browserConsentAnswer };

export function ConsentDialog({ host = HOST }: { host?: typeof HOST }) {
  const [queue, setQueue] = useState<ConsentRequest[]>([]);
  const current = queue[0] ?? null;

  useEffect(() => {
    let live = true;
    const offs: Array<() => void> = [];
    const keep = (u: () => void) => (live ? offs.push(u) : u());
    void host.onConsent((r) => setQueue((q) => (q.some((x) => x.id === r.id) ? q : [...q, r]))).then(keep);
    void host.onConsentClosed((id) => setQueue((q) => q.filter((x) => x.id !== id))).then(keep);
    return () => {
      live = false;
      offs.forEach((u) => u());
    };
  }, [host]);

  if (!current) return null;
  const answer = (allow: boolean, remember: boolean) => {
    setQueue((q) => q.filter((x) => x.id !== current.id));
    void host.browserConsentAnswer(current.id, allow, remember).catch(() => {});
  };

  return (
    <Dialog
      title="Allow the agent on this site?"
      icon="globe"
      tone="warn"
      onClose={() => answer(false, false)}
      focusRoot
      footer={
        <>
          <button className="btn" onClick={() => answer(false, false)}>
            Don't allow
          </button>
          <button className="btn" onClick={() => answer(true, true)}>
            Allow for this session
          </button>
          <button className="btn btn-primary" onClick={() => answer(true, false)}>
            Allow once
          </button>
        </>
      }
    >
      <p>
        The agent wants to <strong>{current.action}</strong> a page on
      </p>
      <p className="consent-site">{current.origin}</p>
      <p className="consent-note">
        This is not a local site, so Keryx asks every time, whatever the session's permission mode. Signed-in pages act as you.
      </p>
    </Dialog>
  );
}
