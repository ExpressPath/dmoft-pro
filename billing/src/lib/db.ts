import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { getEnv } from "./env";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const env = getEnv();
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
      application_name: "dmoft-pro-billing",
    });
    pool.on("error", (error) => console.error("Idle PostgreSQL client error", error));
  }
  return pool;
}

/** Inject an isolated migrated pool for database-backed tests. */
export function setPoolForTests(nextPool: Pool | undefined): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setPoolForTests is available only while NODE_ENV=test");
  }
  pool = nextPool;
}

export async function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<Row>> {
  return getPool().query<Row>(text, [...values]);
}

export async function transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
