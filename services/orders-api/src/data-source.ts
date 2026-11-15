import { DataSource, DataSourceOptions } from "typeorm";

export const dataSourceOptions: DataSourceOptions = {
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [__dirname + "/**/*.entity.js"],
  migrations: [__dirname + "/../migrations/*.js"],
  migrationsTransactionMode: "each",
  synchronize: false,
};

export default new DataSource(dataSourceOptions);
