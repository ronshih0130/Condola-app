import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { disposableDbUrl } from './test-disposable-db';

/** Synthetic test sessions only, on an explicitly disposable database. */
export async function insertTestAuthSession(client:Pick<Client,'query'>,userId:string) {
  disposableDbUrl(process.env.DATABASE_URL,process.env.CONDOLA_RLS_DISPOSABLE);
  const id=randomUUID();
  await client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,[id,userId,randomUUID()]);
  return id;
}
