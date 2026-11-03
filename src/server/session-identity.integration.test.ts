import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import { cloneTestDatabase } from './test-database-clone';
import { disposableDbUrl } from './test-disposable-db';
import { isPlatformAdmin } from './platform';

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
let clone: Awaited<ReturnType<typeof cloneTestDatabase>>;
test.before(async () => { clone = await cloneTestDatabase(); });
test.after(async () => { await clone.cleanup(); });

// Execute the literals actually passed to the two identity calls in readSessionOn.
// This checks both real SQL projections, not the HTTP loader or fallback dispatch.
function identityQueries(): string[] {
  const source = readFileSync(resolve(process.cwd(), 'src/server/session.ts'), 'utf8');
  const start = source.indexOf('const found = await withMissingConsentFallback(');
  const end = source.indexOf('const identity = found.rows[0];', start);
  assert.ok(start >= 0 && end > start, 'identity call sites must exist');
  const segment = source.slice(start, end);
  const matches = [...segment.matchAll(/client\.query<IdentityRow>\(\s*`([^`]*)`\s*,\s*\[sha256\(token\)\]/g)];
  assert.equal(matches.length, 2, 'both identity query literals must be bound to the session token');
  assert.match(matches[0][1], /FROM public\.consents c/);
  assert.match(matches[1][1], /NULL::jsonb AS consent/);
  return matches.map((match) => match[1]);
}

test('both session identity projections use confirmed Auth email, never mutable profile email', async () => {
  const client = new Client({ connectionString: clone.url });
  const originalAllowlist = process.env.CONDOLA_PLATFORM_ADMIN_EMAILS;
  const adminEmail = `admin-${randomUUID()}@example.test`;
  const normalEmail = `normal-${randomUUID()}@example.test`;
  const missingEmail = `missing-${randomUUID()}@example.test`;
  const admin = randomUUID(), normal = randomUUID(), missing = randomUUID();
  const normalToken = randomUUID(), adminToken = randomUUID(), missingToken = randomUUID();
  process.env.CONDOLA_PLATFORM_ADMIN_EMAILS = adminEmail;
  await client.connect();
  try {
    await client.query(`INSERT INTO auth.users(id,email,email_confirmed_at,role,aud) VALUES
      ($1,$2,now(),'authenticated','authenticated'),($3,$4,now(),'authenticated','authenticated'),
      ($5,$6,now(),'authenticated','authenticated')`,
    [normal, normalEmail, admin, adminEmail, missing, missingEmail]);
    await client.query(`INSERT INTO profiles(id,display_name,email) VALUES($1,'Normal person',$2),($3,'Actual admin',$4)`,
      [normal, normalEmail, admin, normalEmail]);
    await client.query(`INSERT INTO auth_sessions(id,user_id,token_hash,expires_at) VALUES
      ($1,$2,$3,now()+interval '1 hour'),($4,$5,$6,now()+interval '1 hour'),($7,$8,$9,now()+interval '1 hour')`,
    [randomUUID(), normal, normalToken, randomUUID(), admin, adminToken, randomUUID(), missing, missingToken]);

    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [normal]);
      await client.query('SET LOCAL ROLE authenticated');
      const own = await client.query('UPDATE profiles SET email=$1 WHERE id=$2', [adminEmail, normal]);
      assert.equal(own.rowCount, 1, 'ordinary authenticated self update must actually succeed');
      const other = await client.query('UPDATE profiles SET email=$1 WHERE id=$2', [adminEmail, admin]);
      assert.equal(other.rowCount, 0, 'another profile must remain outside the self policy');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    const stored = await client.query('SELECT u.email AS auth_email,p.email::text AS profile_email,p.display_name FROM auth.users u JOIN profiles p ON p.id=u.id WHERE u.id=$1', [normal]);
    assert.deepEqual(stored.rows[0], { auth_email: normalEmail, profile_email: adminEmail, display_name: 'Normal person' });
    const foreign = await client.query('SELECT email::text FROM profiles WHERE id=$1', [admin]);
    assert.equal(foreign.rows[0].email, normalEmail);

    const queries = identityQueries();
    async function check(token: string, expectedEmail: string | null, expectedName: string | null, expectedUser: string, privileged: boolean) {
      for (const sql of queries) {
        const result = await client.query<{ user_id: string; name: string | null; email: string | null }>(sql, [token]);
        assert.equal(result.rowCount, 1);
        assert.equal(result.rows[0].user_id, expectedUser);
        assert.equal(result.rows[0].name, expectedName);
        assert.equal(result.rows[0].email, expectedEmail);
        assert.equal(isPlatformAdmin(result.rows[0].email ?? ''), privileged);
      }
    }
    await check(normalToken, normalEmail, 'Normal person', normal, false);
    await check(adminToken, adminEmail, 'Actual admin', admin, true);
    await client.query('UPDATE auth.users SET email_confirmed_at=NULL WHERE id=$1', [admin]);
    await check(adminToken, null, 'Actual admin', admin, false);
    await check(missingToken, missingEmail, null, missing, false);
    for (const [email, confirmed] of [[normalEmail, false], [null, true], ['', true]] as const) {
      await client.query('UPDATE auth.users SET email=$2,email_confirmed_at=CASE WHEN $3::boolean THEN now() ELSE NULL END WHERE id=$1', [normal, email, confirmed]);
      await check(normalToken, confirmed ? email : null, 'Normal person', normal, false);
    }
  } finally {
    if (originalAllowlist === undefined) delete process.env.CONDOLA_PLATFORM_ADMIN_EMAILS;
    else process.env.CONDOLA_PLATFORM_ADMIN_EMAILS = originalAllowlist;
    await client.end();
  }
});
