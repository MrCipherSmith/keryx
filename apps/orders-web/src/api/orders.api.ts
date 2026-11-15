import { http } from "./http";

export type OrderStatus = "new" | "paid" | "shipped" | "delivered" | "cancelled";

export interface OrderDto {
  id: string;
  number: string;
  status: OrderStatus;
  totalCents: number;
  createdAt: string;
  // Guest checkout orders have no customer record, so this is absent for them.
  customer?: { id: string; name: string };
}

export interface ListOrdersParams {
  status?: OrderStatus;
  query?: string;
  page?: number;
  pageSize?: number;
}

export interface ListOrdersResponse {
  items: OrderDto[];
  total: number;
}

export async function listOrders(params: ListOrdersParams): Promise<ListOrdersResponse> {
  const res = await http.get<ListOrdersResponse>("/orders", { params });
  return res.data;
}

export async function getOrder(id: string): Promise<OrderDto> {
  const res = await http.get<OrderDto>(`/orders/${encodeURIComponent(id)}`);
  return res.data;
}

export async function updateStatus(id: string, status: OrderStatus): Promise<OrderDto> {
  const res = await http.patch<OrderDto>(`/orders/${encodeURIComponent(id)}/status`, { status });
  return res.data;
}
