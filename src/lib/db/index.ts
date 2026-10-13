import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { consumeRuntimeConfiguration } from "./candidate-runtime";

const pool = new Pool(consumeRuntimeConfiguration());

export const db = drizzle(pool, { schema });
export { pool };
