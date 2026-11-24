import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionFlags, type SessionInfo } from "../acp/types";
import { errMessage } from "../lib/format";
import type { FlowCard } from "../platform/commands";
import { FLOW_LINK_WINDOW_MS, resolveFlowLinks, type PendingFlowLink } from "./prWork";

/** A package offered for linking to the session that asked for it; nothing is written until `accept`. */
export interface FlowLinkOffer {
  sessionId: string;
  dir: string;
  /** Link was pressed and the flag write has not answered yet. */
  linking?: boolean;
  /** Why the last Link failed; the offer stays so Link can be pressed again. */
  error?: string;
}

/**
 * "Create Flow" requests waiting for their package. `known()` takes the packages that exist before the
 * request (null before the first flow list: nothing can then be told apart, so nothing is offered);
 * `expect(sessionId, known)` waits for the session's package for `FLOW_LINK_WINDOW_MS`. When it is the one
 * new package and this is the one pending request (`resolveFlowLinks`), it becomes an offer: arrival alone
 * cannot tell who made it, so the user confirms. `accept(sessionId)` writes the link through `link` and
 * keeps the offer (`linking`) until the write answers: it goes on success, and stays with its `error` on a
 * failure, so Link can be pressed again. `dismiss(sessionId)` drops the offer and writes nothing; a package
 * once offered is never offered again. An offer whose session has meanwhile got a Flow is dropped.
 * `actions` keeps its identity.
 */
export function usePendingFlowLinks(flows: readonly FlowCard[], loaded: boolean, sessions: readonly SessionInfo[],
  link: (sessionId: string, dir: string) => void | Promise<void>, now: () => number = Date.now) {
  const [pending, setPending] = useState<PendingFlowLink[]>([]);
  const [offered, setOffered] = useState<FlowLinkOffer[]>([]);
  const linkRef = useRef(link);
  linkRef.current = link;
  const nowRef = useRef(now);
  nowRef.current = now;
  const listed = useRef({ flows, loaded });
  listed.current = { flows, loaded };
  const claimed = useRef(new Set<string>());
  const flowOf = useCallback((sessionId: string) => {
    const session = sessions.find(item => item.sessionId === sessionId);
    return session && sessionFlags(session).flow;
  }, [sessions]);
  useEffect(() => {
    if (!pending.length) return;
    const pass = resolveFlowLinks(pending, flows.map(flow => flow.dir), flowOf, claimed.current, nowRef.current());
    for (const { dir } of pass.links) claimed.current.add(dir);
    if (pass.links.length) {
      setOffered(old => [...old.filter(offer => !pass.links.some(next => next.sessionId === offer.sessionId)), ...pass.links]);
    }
    if (pass.pending.length !== pending.length) setPending(pass.pending);
  }, [pending, flows, flowOf]);
  const offers = useMemo(() => offered.filter(offer => !flowOf(offer.sessionId)), [offered, flowOf]);
  const offersRef = useRef(offers);
  offersRef.current = offers;
  const known = useCallback((): ReadonlySet<string> | null =>
    listed.current.loaded ? new Set(listed.current.flows.map(flow => flow.dir)) : null, []);
  const expect = useCallback((sessionId: string, knownDirs: ReadonlySet<string> | null) => {
    if (!knownDirs) return;
    const expiresAt = nowRef.current() + FLOW_LINK_WINDOW_MS;
    setPending(old => [...old.filter(entry => entry.sessionId !== sessionId), { sessionId, knownDirs, expiresAt }]);
  }, []);
  const accept = useCallback(async (sessionId: string) => {
    const offer = offersRef.current.find(item => item.sessionId === sessionId);
    if (!offer || offer.linking) return;
    const { dir } = offer;
    // Read and marked at once, so a second press before the next render cannot write the link twice.
    offersRef.current = offersRef.current.map(item => item === offer ? { sessionId, dir, linking: true } : item);
    // This offer is replaced by `next`, or dropped when it is null; the others stay.
    const settle = (next: FlowLinkOffer | null) => setOffered(old => old.flatMap(item => {
      if (item.sessionId !== sessionId || item.dir !== dir) return [item];
      return next ? [next] : [];
    }));
    settle({ sessionId, dir, linking: true });
    try {
      await linkRef.current(sessionId, dir);
    } catch (cause) {
      settle({ sessionId, dir, error: errMessage(cause) });
      return;
    }
    settle(null);
  }, []);
  const dismiss = useCallback((sessionId: string) => {
    offersRef.current = offersRef.current.filter(item => item.sessionId !== sessionId);
    setOffered(old => old.filter(item => item.sessionId !== sessionId));
  }, []);
  const actions = useMemo(() => ({ known, expect, accept, dismiss }), [known, expect, accept, dismiss]);
  return { offers, actions };
}
