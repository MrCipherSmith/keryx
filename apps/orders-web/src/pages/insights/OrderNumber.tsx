export interface OrderNumberProps {
  value: string;
}

// Order numbers are identifiers, not prose: like phone numbers they keep reading
// left to right in right-to-left locales.
export function OrderNumber({ value }: OrderNumberProps) {
  return (
    <span dir="ltr" className="tabular-nums font-medium text-ink">
      {value}
    </span>
  );
}
