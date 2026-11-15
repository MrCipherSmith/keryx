import { MigrationInterface, QueryRunner } from "typeorm";

export class Shipments1731700000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS shipments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id),
      carrier varchar(8) NOT NULL,
      tracking_number varchar(64),
      weight_grams integer NOT NULL,
      country_code char(2) NOT NULL,
      postcode varchar(20) NOT NULL,
      street varchar(200) NOT NULL,
      notes varchar(500),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_shipments_order_id ON shipments(order_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_shipments_carrier_created_at ON shipments(carrier, created_at)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS shipments`);
  }
}
