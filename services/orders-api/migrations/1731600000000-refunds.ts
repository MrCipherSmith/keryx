import { MigrationInterface, QueryRunner } from "typeorm";

export class Refunds1731600000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS refunds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id),
      amount_cents integer NOT NULL,
      reason varchar(200) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_refunds_order_id ON refunds(order_id)`);
    await q.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE orders DROP COLUMN IF EXISTS cancelled_at`);
    await q.query(`DROP TABLE IF EXISTS refunds`);
  }
}
