import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("refunds")
@Index("idx_refunds_order_id", ["orderId"])
export class Refund {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @Column({ name: "amount_cents", type: "integer" })
  amountCents!: number;

  @Column({ type: "varchar", length: 200 })
  reason!: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
