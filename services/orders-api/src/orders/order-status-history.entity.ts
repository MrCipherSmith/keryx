import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";
import { OrderStatus } from "./order.entity";

@Entity("order_status_history")
@Index("idx_order_status_history_order_id", ["orderId", "createdAt"])
export class OrderStatusHistory {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @Column({ name: "from_status", type: "varchar", length: 16 })
  fromStatus!: OrderStatus;

  @Column({ name: "to_status", type: "varchar", length: 16 })
  toStatus!: OrderStatus;

  @Column({ name: "payment_ref", type: "varchar", length: 64, nullable: true })
  paymentRef!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
