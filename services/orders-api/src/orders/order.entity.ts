import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from "typeorm";
import { Customer } from "../customers/customer.entity";
import { OrderItem } from "./order-item.entity";

export enum OrderStatus {
  Pending = "pending",
  Paid = "paid",
  Shipped = "shipped",
  Cancelled = "cancelled",
}

@Entity("orders")
@Index("idx_orders_customer_id", ["customerId"])
@Index("idx_orders_status_created_at", ["status", "createdAt"])
export class Order {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "customer_id", type: "uuid" })
  customerId!: string;

  @ManyToOne(() => Customer)
  @JoinColumn({ name: "customer_id" })
  customer!: Customer;

  @Column({ type: "varchar", length: 16 })
  status!: OrderStatus;

  @Column({ name: "total_cents", type: "integer" })
  totalCents!: number;

  @Column({ type: "char", length: 3 })
  currency!: string;

  @Column({ name: "warehouse_note", type: "varchar", length: 500, nullable: true })
  note!: string | null;

  @Column({ name: "external_ref", type: "varchar", length: 64 })
  externalRef!: string;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: ["insert"] })
  items!: OrderItem[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", type: "timestamptz" })
  deletedAt!: Date | null;
}
