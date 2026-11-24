import type { SessionSubject } from "../acp/types";
import type { FlowCard } from "../platform/commands";

/** The shown session's Subject ("PR owner/repo#N" or "Issue owner/repo#N") and its Flow, as links back to their cards. */
export function SessionSubjectLinks({ subject, flow, onOpenSubject, onOpenFlow }: {
  subject?: SessionSubject | undefined;
  flow?: Pick<FlowCard, "id" | "dir" | "title"> | undefined;
  onOpenSubject: (subject: SessionSubject) => void;
  onOpenFlow: (dir: string) => void;
}) {
  if (!subject && !flow) return null;
  const name = subject && `${subject.kind === "pr" ? "PR" : "Issue"} ${subject.repo}#${subject.number}`;
  return <span className="session-subject-links">
    {subject && <button type="button" className="link-btn" title={`Open ${name} on its card`} onClick={() => onOpenSubject(subject)}>{name}</button>}
    {flow && <button type="button" className="link-btn" title={flow.title} onClick={() => onOpenFlow(flow.dir)}>Flow #{flow.id}</button>}
  </span>;
}
