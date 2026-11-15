import { Column, CreateDateColumn, Entity, PrimaryColumn } from "typeorm";

@Entity("idempotency_records")
export class IdempotencyRecord {
  @PrimaryColumn({ type: "varchar", length: 64 })
  key!: string;

  @PrimaryColumn({ type: "varchar", length: 128 })
  scope!: string;

  @Column({ type: "jsonb" })
  response!: unknown;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
