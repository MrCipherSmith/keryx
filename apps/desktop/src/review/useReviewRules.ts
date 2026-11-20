import { useCallback, useEffect, useRef, useState } from "react";
import type { ReviewRuleAction, ReviewRuleSnapshot } from "../../../../src/review/review-rule-types";
import type { WatcherKey } from "../../../../src/review/watcher-types";
import { reviewRules } from "../platform/reviewRules";
import { errMessage } from "../lib/format";

export interface RulesProps {
  cwd: string;
  target: WatcherKey;
  command?: typeof reviewRules;
  onAccessLost?: (reason: string) => void;
}

export function useReviewRules({ cwd, target, command = reviewRules, onAccessLost }: RulesProps, number?: number) {
  const [snapshot, setSnapshot] = useState<ReviewRuleSnapshot | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef<"read" | "write" | null>(null);
  const seq = useRef(0);
  const request = useCallback(async (action: ReviewRuleAction) => {
    const write = action.kind !== "status";
    if (pending.current && (!write || pending.current === "write")) return false;
    const ticket = ++seq.current;
    pending.current = write ? "write" : "read";
    if (write) setSaving(true);
    try {
      const result = await command(cwd, target, action);
      if (ticket !== seq.current) return false;
      setSnapshot(result);
      setError("");
      return true;
    } catch (cause) {
      if (ticket !== seq.current) return false;
      const message = errMessage(cause);
      if (/^access:/i.test(message)) { setSnapshot(null); onAccessLost?.(message); }
      setError(message);
      return false;
    } finally {
      if (ticket === seq.current) { pending.current = null; setSaving(false); }
    }
  }, [cwd, target, command, onAccessLost]);
  const refresh = useCallback(() => {
    void request(number === undefined ? { kind: "status" } : { kind: "status", number });
  }, [request, number]);
  useEffect(() => {
    refresh();
    const visible = () => { if (!document.hidden) refresh(); };
    const timer = window.setInterval(visible, 30000);
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      seq.current++;
      pending.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  return { snapshot, request, refresh, error, saving };
}
