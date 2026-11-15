export interface ScoreBadgeProps {
  score: number;
}

export function ScoreBadge({ score }: ScoreBadgeProps) {
  return (
    <div className="w-48 rounded-panel border border-line bg-surface pe-6 py-3 text-center" data-measure="badge-box">
      <span className="font-display text-[40px] leading-none text-ink" data-measure="badge-score">
        {score}
      </span>
    </div>
  );
}
