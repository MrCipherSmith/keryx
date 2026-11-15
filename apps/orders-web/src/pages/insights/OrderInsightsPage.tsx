import { useState } from "react";
import type { OrderDto } from "../../api/orders.api";
import { useMessages } from "../../i18n";
import { DeliveryScrubber } from "./DeliveryScrubber";
import { FulfilmentMeter } from "./FulfilmentMeter";
import { insightsMessages } from "./insights.messages";
import { OrderScoreCard } from "./OrderScoreCard";
import { OrdersTable } from "./OrdersTable";
import { OrderTotalsStrip } from "./OrderTotalsStrip";
import { RecentFilters } from "./RecentFilters";
import { ScoreBadge } from "./ScoreBadge";

export interface OrderInsightsPageProps {
  orders: OrderDto[];
  score: number;
  fulfilledPercent: number;
  subtotalCents: number;
  totalCents: number;
  recentFilters: string[];
  onPickFilter: (filter: string) => void;
}

export function OrderInsightsPage(props: OrderInsightsPageProps) {
  const t = useMessages(insightsMessages);
  const [step, setStep] = useState(2);

  return (
    <main className="mx-auto max-w-4xl space-y-8 px-4 py-8">
      <h1 className="font-display text-[28px] text-ink">{t("title")}</h1>

      <div className="flex flex-wrap items-start gap-6">
        <ScoreBadge score={props.score} />
        <OrderScoreCard score={props.score} />
        <FulfilmentMeter percent={props.fulfilledPercent} />
      </div>

      <OrderTotalsStrip subtotalCents={props.subtotalCents} totalCents={props.totalCents} />
      <DeliveryScrubber step={step} steps={4} onChange={setStep} />
      <RecentFilters filters={props.recentFilters} onPick={props.onPickFilter} />

      <section>
        <h2 className="mb-3 font-display text-[20px] text-ink">{t("ordersHeading")}</h2>
        <OrdersTable orders={props.orders} />
      </section>
    </main>
  );
}
