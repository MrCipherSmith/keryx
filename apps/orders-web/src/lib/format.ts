const dateFormat = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

export function toMoney(v: any): string {
  const cents = Number(v);
  if (Number.isNaN(cents)) return "-";
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}
