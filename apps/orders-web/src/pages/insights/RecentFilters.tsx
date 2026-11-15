import { useMessages } from "../../i18n";
import { insightsMessages } from "./insights.messages";

export interface RecentFiltersProps {
  filters: string[];
  onPick: (filter: string) => void;
}

export function RecentFilters({ filters, onPick }: RecentFiltersProps) {
  const t = useMessages(insightsMessages);

  return (
    <section aria-label={t("recentFilters")}>
      <h3 className="ml-4 text-[14px] text-muted">{t("recentFilters")}</h3>
      <div className="relative mt-2">
        <ul className="flex gap-3 overflow-x-auto ps-4 pe-12">
          {filters.map((filter) => (
            <li key={filter} className="shrink-0">
              <button
                type="button"
                onClick={() => onPick(filter)}
                className="min-h-11 rounded-control border border-line bg-surface px-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                {filter}
              </button>
            </li>
          ))}
        </ul>
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-paper to-transparent"
          data-measure="fade"
        />
      </div>
    </section>
  );
}
