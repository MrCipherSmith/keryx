import type { ReviewRunUsage, ReviewUsageCounts } from "../../../../src/review/run-usage";

const tokens = [
  { key: "inputTokens", label: "Input" },
  { key: "outputTokens", label: "Output" },
  { key: "totalTokens", label: "Total" },
  { key: "cacheReadTokens", label: "Cache read" },
  { key: "cacheWriteTokens", label: "Cache write" },
] as const;

const costs = [
  { key: "cost", label: "Cost" },
  { key: "estimatedCost", label: "Estimated cost" },
] as const;

function UsageCell({ value }: { value?: string | undefined }) {
  return value === undefined
    ? <td title="Unreported" aria-label="Unreported">—</td>
    : <td>{value}</td>;
}

export function ReviewUsage({ usage }: { usage: ReviewRunUsage }) {
  const rows = [usage.total, usage.coordinator, ...usage.reviewers];
  const columns = tokens.filter(({ key }) => key !== "cacheReadTokens" && key !== "cacheWriteTokens" || rows.some(row => row[key] !== undefined));
  const costColumns = costs.filter(({ key }) => rows.some(row => row[key] !== undefined));
  function values(counts: ReviewUsageCounts) {
    return <>
      {columns.map(({ key }) => <UsageCell key={key} value={counts[key]?.toLocaleString()} />)}
      {costColumns.map(({ key }) => {
        const cost = counts[key];
        return <UsageCell key={key} value={cost && `${cost.amount.toLocaleString(undefined, { maximumSignificantDigits: 8 })} ${cost.currency}`} />;
      })}
    </>;
  }
  return <details className="review-usage">
    <summary>
      Token usage{" "}
      <span className="review-usage-total">
        {usage.total.totalTokens === undefined ? "Total unavailable" : `${usage.total.totalTokens.toLocaleString()} tokens`}
        {usage.partial && " · Partial"}
      </span>
    </summary>
    {usage.partial && <p className="review-detail-muted">Partial usage · Totals include the measurements available for this run.</p>}
    <div className="review-usage-scroll" role="region" aria-label="Token usage by agent" tabIndex={0}>
      <table aria-label="Token usage">
        <thead><tr><th scope="col">Agent</th>{columns.map(({ key, label }) => <th scope="col" key={key}>{label}</th>)}
          {costColumns.map(({ key, label }) => <th scope="col" key={key}>{label}</th>)}</tr></thead>
        <tbody>
          <tr><th scope="row">Orchestrator</th>{values(usage.coordinator)}</tr>
          {usage.reviewers.map((reviewer, i) => <tr key={i}>
            <th scope="row">{reviewer.reviewer}{reviewer.partial && <small>Partial usage</small>}
              {(reviewer.provider || reviewer.model) && <small>{[reviewer.provider, reviewer.model].filter(Boolean).join(" · ")}</small>}
            </th>{values(reviewer)}
          </tr>)}
        </tbody>
        <tfoot><tr><th scope="row">Total</th>{values(usage.total)}</tr></tfoot>
      </table>
    </div>
    {costColumns.length === 0 && <p className="review-detail-muted">Cost unavailable for this run.</p>}
  </details>;
}
