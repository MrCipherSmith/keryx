import { MigrationInterface, QueryRunner } from "typeorm";

export class StatusHistory1731900000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS order_status_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id),
      from_status varchar(16) NOT NULL,
      to_status varchar(16) NOT NULL,
      payment_ref varchar(64),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    // A new, empty table: a plain CREATE INDEX takes no lock anyone waits on.
    await q.query(`CREATE INDEX IF NOT EXISTS idx_order_status_history_order_id ON order_status_history(order_id, created_at)`);
    await q.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at timestamptz`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE orders DROP COLUMN IF EXISTS paid_at`);
    await q.query(`DROP TABLE IF EXISTS order_status_history`);
  }
}
