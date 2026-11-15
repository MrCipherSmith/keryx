import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { Order } from "./order.entity";

@Entity("order_items")
@Index("idx_order_items_order_id", ["orderId"])
export class OrderItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @ManyToOne(() => Order, (order) => order.items)
  @JoinColumn({ name: "order_id" })
  order!: Order;

  @Column({ name: "product_id", type: "uuid" })
  productId!: string;

  @Column({ type: "integer" })
  quantity!: number;

  @Column({ name: "unit_price_cents", type: "integer" })
  unitPriceCents!: number;
}
