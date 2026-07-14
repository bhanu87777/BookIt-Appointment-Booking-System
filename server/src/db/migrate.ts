import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Creates the database if missing, then applies schema.sql (idempotent). */
async function main() {
  const url = new URL(config.databaseUrl);
  const dbName = url.pathname.slice(1);

  // Connect to the maintenance DB to create the target DB if needed
  const adminUrl = new URL(config.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (exists.rowCount === 0) {
    console.log(`Creating database "${dbName}"…`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  }
  await admin.end();

  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
  await client.end();
  console.log('✔ Schema applied.');
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
