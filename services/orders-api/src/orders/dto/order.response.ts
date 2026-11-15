import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Order, OrderStatus } from "../order.entity";

export class OrderResponse {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ format: "uuid" }) customerId!: string;
  @ApiProperty() customerName!: string;
  @ApiProperty({ enum: OrderStatus }) status!: OrderStatus;
  @ApiProperty() totalCents!: number;
  @ApiProperty({ minLength: 3, maxLength: 3 }) currency!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiPropertyOptional({ format: "date-time" }) paidAt?: string;

  static from(order: Order): OrderResponse {
    return {
      id: order.id,
      customerId: order.customerId,
      customerName: order.customer.name,
      status: order.status,
      totalCents: order.totalCents,
      currency: order.currency,
      createdAt: order.createdAt.toISOString(),
      ...(order.paidAt ? { paidAt: order.paidAt.toISOString() } : {}),
    };
  }
}

export interface OrderPage {
  data: OrderResponse[];
  meta: { limit: number; offset: number; total: number };
}
