import { formatCents } from "../format/money";

export interface OrderTotalProps {
  cents: number;
  currency: string;
}

export function OrderTotal({ cents, currency }: OrderTotalProps) {
  return <span>{formatCents(cents, currency)}</span>;
}
