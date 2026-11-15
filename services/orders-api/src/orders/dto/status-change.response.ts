import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { OrderStatus } from "../order.entity";
import { OrderStatusHistory } from "../order-status-history.entity";

export class StatusChangeResponse {
  @ApiProperty({ enum: OrderStatus }) fromStatus!: OrderStatus;
  @ApiProperty({ enum: OrderStatus }) toStatus!: OrderStatus;
  @ApiPropertyOptional() paymentRef?: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;

  static from(row: OrderStatusHistory): StatusChangeResponse {
    return {
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      ...(row.paymentRef ? { paymentRef: row.paymentRef } : {}),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
