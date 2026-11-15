import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1700000000000 implements MigrationInterface {
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE IF NOT EXISTS customers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(200) NOT NULL,
      email varchar(320) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )`);
    await q.query(`CREATE TABLE IF NOT EXISTS products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title varchar(200) NOT NULL,
      price_cents integer NOT NULL,
      stock integer NOT NULL
    )`);
    await q.query(`CREATE TABLE IF NOT EXISTS orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id uuid NOT NULL REFERENCES customers(id),
      status varchar(16) NOT NULL,
      total_cents integer NOT NULL,
      currency char(3) NOT NULL,
      note varchar(500),
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id)`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_orders_status_created_at ON orders(status, created_at)`);
    await q.query(`CREATE TABLE IF NOT EXISTS order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id uuid NOT NULL REFERENCES orders(id),
      product_id uuid NOT NULL REFERENCES products(id),
      quantity integer NOT NULL,
      unit_price_cents integer NOT NULL
    )`);
    await q.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id)`);
    await q.query(`CREATE TABLE IF NOT EXISTS idempotency_records (
      key varchar(64) NOT NULL,
      scope varchar(128) NOT NULL,
      response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (key, scope)
    )`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS idempotency_records`);
    await q.query(`DROP TABLE IF EXISTS order_items`);
    await q.query(`DROP TABLE IF EXISTS orders`);
    await q.query(`DROP TABLE IF EXISTS products`);
    await q.query(`DROP TABLE IF EXISTS customers`);
  }
}
