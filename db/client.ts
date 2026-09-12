import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const DB_URL = process.env.DATABASE_URL;

if (!DB_URL) {
  throw new Error(
    "DATABASE_URL is not set.",
  );
}

export const sql = postgres(DB_URL);
export const db = drizzle(sql, { schema });
