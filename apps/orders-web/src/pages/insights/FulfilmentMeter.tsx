import { useMessages } from "../../i18n";
import { insightsMessages } from "./insights.messages";

export interface FulfilmentMeterProps {
  percent: number;
}

export function FulfilmentMeter({ percent }: FulfilmentMeterProps) {
  const t = useMessages(insightsMessages);

  return (
    <div className="inline-grid">
      <span className="whitespace-nowrap text-[14px] text-muted">{t("fulfilledLabel")}</span>
      <div className="mt-1 h-2 rounded-full bg-line" data-measure="meter-track">
        <div className="h-full rounded-full bg-sage" style={{ width: `${percent}%` }} data-measure="meter-fill" />
      </div>
    </div>
  );
}
