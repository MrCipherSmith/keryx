import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionFlags, type SessionInfo } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import { FLOW_LINK_WINDOW_MS, resolveFlowLinks, type PendingFlowLink } from "./prWork";

/**
 * "Create Flow" requests waiting for their package. `known()` takes the packages that exist before the
 * request (null before the first flow list: nothing can then be told apart, so nothing is linked);
 * `expect(sessionId, known)` waits for the session's package for `FLOW_LINK_WINDOW_MS`. The new package is
 * linked through `link` only when it is the one new package and this is the one pending request; a package
 * once linked is never linked again (`resolveFlowLinks`). The returned api keeps its identity.
 */
export function usePendingFlowLinks(flows: readonly FlowCard[], loaded: boolean, sessions: readonly SessionInfo[],
  link: (sessionId: string, dir: string) => void, now: () => number = Date.now) {
  const [pending, setPending] = useState<PendingFlowLink[]>([]);
  const linkRef = useRef(link);
  linkRef.current = link;
  const nowRef = useRef(now);
  nowRef.current = now;
  const listed = useRef({ flows, loaded });
  listed.current = { flows, loaded };
  const claimed = useRef(new Set<string>());
  useEffect(() => {
    if (!pending.length) return;
    const flowOf = (sessionId: string) => {
      const session = sessions.find(item => item.sessionId === sessionId);
      return session && sessionFlags(session).flow;
    };
    const pass = resolveFlowLinks(pending, flows.map(flow => flow.dir), flowOf, claimed.current, nowRef.current());
    for (const { sessionId, dir } of pass.links) {
      claimed.current.add(dir);
      linkRef.current(sessionId, dir);
    }
    if (pass.pending.length !== pending.length) setPending(pass.pending);
  }, [pending, flows, sessions]);
  const known = useCallback((): ReadonlySet<string> | null =>
    listed.current.loaded ? new Set(listed.current.flows.map(flow => flow.dir)) : null, []);
  const expect = useCallback((sessionId: string, knownDirs: ReadonlySet<string> | null) => {
    if (!knownDirs) return;
    const expiresAt = nowRef.current() + FLOW_LINK_WINDOW_MS;
    setPending(old => [...old.filter(entry => entry.sessionId !== sessionId), { sessionId, knownDirs, expiresAt }]);
  }, []);
  return useMemo(() => ({ known, expect }), [known, expect]);
}
