import { useMessages } from "../../i18n";
import { insightsMessages } from "./insights.messages";

export interface DeliveryScrubberProps {
  step: number;
  steps: number;
  onChange: (step: number) => void;
}

// Scrubbers follow platform media players: time runs left to right whatever the locale.
export function DeliveryScrubber({ step, steps, onChange }: DeliveryScrubberProps) {
  const t = useMessages(insightsMessages);

  return (
    <input
      type="range"
      dir="ltr"
      min={0}
      max={steps}
      value={step}
      aria-label={t("deliveryProgress")}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-full accent-[var(--color-accent)]"
    />
  );
}
