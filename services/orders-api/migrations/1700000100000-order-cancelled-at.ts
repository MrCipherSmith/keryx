import { MigrationInterface, QueryRunner } from "typeorm";

export class OrderCancelledAt1700000100000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE orders DROP COLUMN IF EXISTS cancelled_at`);
  }
}
