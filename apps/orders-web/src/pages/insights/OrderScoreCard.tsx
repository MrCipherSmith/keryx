import { useMessages } from "../../i18n";
import { insightsMessages } from "./insights.messages";

export interface OrderScoreCardProps {
  score: number;
}

export function OrderScoreCard({ score }: OrderScoreCardProps) {
  const t = useMessages(insightsMessages);

  return (
    <div className="w-fit rounded-panel border border-line bg-surface p-4">
      <div className="flex items-center gap-3">
        <span className="text-[14px] text-muted">{t("scoreLabel")}</span>
        <div className="h-2 min-w-0 flex-1 rounded-full bg-line" data-measure="score-track">
          <div className="h-full rounded-full bg-sage" style={{ width: `${score}%` }} />
        </div>
        <span className="tabular-nums text-ink">{score}</span>
      </div>
    </div>
  );
}
