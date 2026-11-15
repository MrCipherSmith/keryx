import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity("products")
export class Product {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @Column({ name: "price_cents", type: "integer" })
  priceCents!: number;

  @Column({ type: "integer" })
  stock!: number;
}
