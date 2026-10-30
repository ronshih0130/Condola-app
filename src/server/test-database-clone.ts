import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { disposableDbUrl, withDatabase } from "./test-disposable-db";

/** Clone only the explicitly designated local disposable database. */
export async function cloneTestDatabase(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const previous = process.env.DATABASE_URL;
  const source = disposableDbUrl(previous, process.env.CONDOLA_RLS_DISPOSABLE);
  let sourceName: string;
  try { sourceName = decodeURIComponent(source.pathname.slice(1)); } catch { throw new Error("Invalid source database name"); }
  if (!sourceName || sourceName.includes("\0") || sourceName.includes("/") || Buffer.byteLength(sourceName) > 63) {
    throw new Error("Invalid source database name");
  }
  const quotedSource = `"${sourceName.replaceAll('"', '""')}"`;
  const name = `condola_test_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = withDatabase(source, "postgres");
  const cloneUrl = withDatabase(source, name);
  async function admin(sql: string, onSuccess?: () => void) {
    const client = new Client({ connectionString: adminUrl });
    try {
      await client.connect();
      await client.query(sql);
      onSuccess?.();
    } finally {
      await client.end();
    }
  }
  // PostgreSQL refuses a template with active connections. Do not terminate them.
  let owned = false;
  try {
    await admin(`CREATE DATABASE "${name}" TEMPLATE ${quotedSource}`, () => { owned = true; });
  } catch (error) {
    if (owned) await admin(`DROP DATABASE "${name}"`);
    throw error;
  }
  process.env.DATABASE_URL = cloneUrl;
  return {
    url: cloneUrl,
    async cleanup() {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      if (!owned) return;
      await admin(`DROP DATABASE "${name}"`);
      owned = false;
    },
  };
}
