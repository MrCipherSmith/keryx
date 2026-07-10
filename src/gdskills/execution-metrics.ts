export const EXECUTION_METRICS_RULE_PATH = ".metaproject/rules/core/execution-metrics.md";

const EXECUTION_METRICS_MARKER = "<!-- keryx:execution-metrics:begin -->";

const EXECUTION_METRICS_GATE = `${EXECUTION_METRICS_MARKER}
## Execution Metrics (user-direct opt-in)

When this skill is invoked directly by a user, before task work:

1. Read \`${EXECUTION_METRICS_RULE_PATH}\`.
2. Ask exactly: **Collect execution statistics for this run? (yes / no)**
3. Wait for the answer. If yes, follow the rule's reporting and persistence contract; if no, continue normally.

When dispatched as a subagent, do not ask and do not emit a separate report. The top-level caller owns metrics.
<!-- keryx:execution-metrics:end -->`;

export function ensureExecutionMetricsOptIn(skillMarkdown: string): string {
  if (skillMarkdown.includes(EXECUTION_METRICS_MARKER)) {
    return skillMarkdown;
  }

  const frontmatter = skillMarkdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!frontmatter) {
    return `${EXECUTION_METRICS_GATE}\n\n${skillMarkdown}`;
  }

  const offset = frontmatter[0].length;
  const rest = skillMarkdown.slice(offset).replace(/^\r?\n/, "");
  return `${skillMarkdown.slice(0, offset)}\n${EXECUTION_METRICS_GATE}\n\n${rest}`;
}
