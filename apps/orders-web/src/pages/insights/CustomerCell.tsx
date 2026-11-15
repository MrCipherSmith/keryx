export interface CustomerCellProps {
  name: string;
  badge: string;
}

export function CustomerCell({ name, badge }: CustomerCellProps) {
  return (
    <div className="flex items-center gap-2" data-measure="customer-cell">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-line font-medium text-ink"
      >
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0 flex-1 truncate" data-measure="customer-name">
        {name}
      </span>
      <span className="w-28 shrink-0 text-end text-[14px] text-muted">{badge}</span>
    </div>
  );
}
