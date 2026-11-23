import { useCallback, useEffect, useRef, useState } from "react";
import { sessionFlags, type SessionInfo } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import { resolveFlowLink, type PendingFlowLink } from "./prWork";

/**
 * "Create Flow" requests waiting for their package. `known()` takes the packages that exist before the
 * request (null before the first flow list: nothing can then be told apart, so nothing is linked);
 * `expect(sessionId, known)` waits for the session's package. The one new package is linked through
 * `link`; when several appear, none is.
 */
export function usePendingFlowLinks(flows: readonly FlowCard[], loaded: boolean, sessions: readonly SessionInfo[],
  link: (sessionId: string, dir: string) => void) {
  const [pending, setPending] = useState<PendingFlowLink[]>([]);
  const linkRef = useRef(link);
  linkRef.current = link;
  useEffect(() => {
    if (!pending.length) return;
    const dirs = flows.map(flow => flow.dir);
    const kept = pending.filter(entry => {
      const session = sessions.find(item => item.sessionId === entry.sessionId);
      const step = resolveFlowLink(entry, dirs, session && sessionFlags(session).flow);
      if (step.action === "link") linkRef.current(entry.sessionId, step.dir);
      return step.action === "wait";
    });
    if (kept.length !== pending.length) setPending(kept);
  }, [pending, flows, sessions]);
  const known = useCallback((): ReadonlySet<string> | null => loaded ? new Set(flows.map(flow => flow.dir)) : null, [flows, loaded]);
  const expect = useCallback((sessionId: string, knownDirs: ReadonlySet<string> | null) => {
    if (!knownDirs) return;
    setPending(old => [...old.filter(entry => entry.sessionId !== sessionId), { sessionId, knownDirs }]);
  }, []);
  return { known, expect };
}
