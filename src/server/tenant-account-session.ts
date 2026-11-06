import { cache } from 'react';
import { redirect } from 'next/navigation';
import { withClient } from './db';
import { readSessionOn } from './session';

/** Account mutations must not touch activity or provision a sandbox before flag admission. */
export const getTenantAccountSession = cache(async () => {
  const session = await withClient(async client => {
    await client.query('BEGIN READ ONLY');
    try { return (await readSessionOn(client, { touch:false })).session; }
    catch { return null; }
    finally { await client.query('ROLLBACK'); }
  });
  if (!session || session.kind !== 'tenant') redirect('/login');
  return session;
});
