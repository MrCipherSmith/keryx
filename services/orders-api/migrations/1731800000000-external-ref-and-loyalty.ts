import { MigrationInterface, QueryRunner } from "typeorm";

export class ExternalRefAndLoyalty1731800000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    // Marketplace orders carry the partner's reference; support looks orders up by it.
    await q.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_ref varchar(64) NOT NULL`);
    await q.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_external_ref ON orders(external_ref)`);

    // Every existing customer starts on the standard tier.
    await q.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_tier varchar(16) NOT NULL DEFAULT 'standard'`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_customers_loyalty_tier ON customers(loyalty_tier)`);

    await q.query(`ALTER TABLE orders RENAME COLUMN note TO warehouse_note`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE orders RENAME COLUMN warehouse_note TO note`);
    await q.query(`DROP INDEX IF EXISTS idx_customers_loyalty_tier`);
    await q.query(`ALTER TABLE customers DROP COLUMN IF EXISTS loyalty_tier`);
    await q.query(`DROP INDEX IF EXISTS idx_orders_external_ref`);
    await q.query(`ALTER TABLE orders DROP COLUMN IF EXISTS external_ref`);
  }
}
