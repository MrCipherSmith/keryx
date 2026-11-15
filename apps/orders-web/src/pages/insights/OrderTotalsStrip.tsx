import { useLocale, useMessages } from "../../i18n";
import { insightsMessages } from "./insights.messages";

export interface OrderTotalsStripProps {
  subtotalCents: number;
  totalCents: number;
}

export function OrderTotalsStrip({ subtotalCents, totalCents }: OrderTotalsStripProps) {
  const t = useMessages(insightsMessages);
  const locale = useLocale();
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });

  return (
    <div className="overflow-hidden rounded-panel border border-line bg-surface" data-measure="totals-container">
      <div className="flex w-[112%] items-center justify-between gap-6 bg-paper px-4 py-3">
        <span className="text-muted">
          {t("subtotal")} <span className="tabular-nums">{money.format(subtotalCents / 100)}</span>
        </span>
        <span className="font-medium text-ink" data-measure="totals-total">
          {t("total")} <span className="tabular-nums">{money.format(totalCents / 100)}</span>
        </span>
      </div>
    </div>
  );
}
