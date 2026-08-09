import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const ssl = process.env.DATABASE_SSL?.toLowerCase() === "true"
  ? { rejectUnauthorized: true }
  : undefined;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDirectory = join(root, "migrations");
const files = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
  .sort();
const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 1 });
const client = await pool.connect();

try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    sha256 text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query("SELECT pg_advisory_lock(hashtext('dmoft-pro-billing:migrations'))");
  for (const name of files) {
    const sql = await readFile(join(migrationsDirectory, name), "utf8");
    const digest = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query("SELECT sha256 FROM schema_migrations WHERE name = $1", [name]);
    if (existing.rows[0]) {
      if (existing.rows[0].sha256 !== digest) {
        throw new Error(`Applied migration ${name} has changed; create a new migration instead`);
      }
      process.stdout.write(`already applied ${name}\n`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [name, digest]);
      await client.query("COMMIT");
      process.stdout.write(`applied ${name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext('dmoft-pro-billing:migrations'))");
  } finally {
    client.release();
    await pool.end();
  }
}
