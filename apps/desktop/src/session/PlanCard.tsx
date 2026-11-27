import { useEffect, useRef, useState } from "react";
import type { PlanEntry } from "../acp/types";
import { Icon } from "../components/Icon";
import { planStaleMinutes } from "./planStaleness";

const PLAN_ICON = { pending: "circle", in_progress: "circleDot", completed: "circleCheck" } as const;

/** The session plan above the composer: its steps, how many are done, and whether the agent stopped moving it. */
export function PlanCard({ plan, updatedAt, busy }: { plan: PlanEntry[]; updatedAt: number | null; busy: boolean }) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  // The staleness line is the only part of the card that changes with time alone: tick only while the agent works.
  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [busy]);
  const done = plan.filter((p) => p.status === "completed").length;
  const currentIndex = plan.findIndex((p) => p.status === "in_progress");
  const current = currentIndex < 0 ? undefined : plan[currentIndex];
  const staleMinutes = planStaleMinutes(plan, updatedAt, busy, now);
  // A long plan scrolls inside the card: keep the step in progress in view as it moves down the list. The list's own
  // scrollTop, not scrollIntoView, so the transcript behind the dock never jumps.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const item = currentIndex < 0 ? undefined : (list?.children[currentIndex] as HTMLElement | undefined);
    if (!list || !item) return;
    const top = item.offsetTop;
    // Land with the step before it still in view: what just finished is the context for what runs now.
    const previous = item.previousElementSibling as HTMLElement | null;
    if (top < list.scrollTop || top + item.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, (previous?.offsetTop ?? top) - 4);
    }
  }, [currentIndex, open]);
  return (
    <div className={`plan-card${open ? " is-open" : ""}`}>
      <button className="plan-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="checklist" size={14} />
        <span className="plan-title">Plan</span>
        <span className="plan-count">
          {done}/{plan.length}
        </span>
        {!open && current ? <span className="plan-current truncate">{current.content}</span> : null}
        <span className="grow" />
        {staleMinutes !== null ? (
          <span className="plan-stale" title="The agent is still working but has not updated this plan; it may be behind the real progress.">
            not updated for {staleMinutes} min
          </span>
        ) : null}
        <Icon name={open ? "chevronDown" : "chevronUp"} size={13} />
      </button>
      {open ? (
        <ol className="plan-list" ref={listRef}>
          {plan.map((p, i) => (
            <li key={p._meta?.keryx?.id ?? i} className={`plan-item plan-${p.status}`}>
              <Icon name={PLAN_ICON[p.status] ?? "circle"} size={14} />
              <span>{p.content}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
