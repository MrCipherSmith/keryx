import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export enum Carrier {
  Dhl = "dhl",
  Ups = "ups",
  Gls = "gls",
}

@Entity("shipments")
@Index("idx_shipments_order_id", ["orderId"])
@Index("idx_shipments_carrier_created_at", ["carrier", "createdAt"])
export class Shipment {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "order_id", type: "uuid" })
  orderId!: string;

  @Column({ type: "varchar", length: 8 })
  carrier!: Carrier;

  @Column({ name: "tracking_number", type: "varchar", length: 64, nullable: true })
  trackingNumber!: string | null;

  @Column({ name: "weight_grams", type: "integer" })
  weightGrams!: number;

  @Column({ name: "country_code", type: "char", length: 2 })
  countryCode!: string;

  @Column({ type: "varchar", length: 20 })
  postcode!: string;

  @Column({ type: "varchar", length: 200 })
  street!: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
