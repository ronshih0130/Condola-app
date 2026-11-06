import type { Client } from 'pg';
import { logServerError, safeDbCode } from './errors';

type Connection = Pick<Client, 'query'>;
const transactionFlags = new WeakMap<Connection, Map<string, boolean>>();

/** Scope the cache to the callback, never the lifetime of a reusable connection. */
export async function withUsageTransaction<T>(client: Connection, fn: () => Promise<T>): Promise<T> {
  transactionFlags.set(client, new Map());
  try { return await fn(); }
  finally { transactionFlags.delete(client); }
}
export type UsageInput = {
  orgId: string;
  dimension: 'units' | 'signatures' | 'stored_bytes' | 'notifications' | 'vendor_jobs';
  quantity: bigint;
  occurredAt: string | Date;
  sourceTable: string;
  sourceId: string;
  dedupeKey: string;
};
export type UsageResult = { state: 'off' | 'failed' | 'empty' } | { state: 'recorded'; id: string };

export function usageEventsOn(global: unknown, flags: unknown, orgId: string): boolean {
  if (!global || typeof global !== 'object' || Array.isArray(global) || !flags || typeof flags !== 'object' || Array.isArray(flags)) return false;
  const g = global as Record<string, unknown>, f = flags as Record<string, unknown>;
  return g.enabled === true && Array.isArray(g.allowed_org_ids) && g.allowed_org_ids.includes(orgId) && f.usage_events === true;
}

export function usageDedupeKey(dimension: UsageInput['dimension'], sourceTable: string, sourceId: string, version?: string): string {
  return `${dimension}:${sourceTable}:${sourceId}${version ? `:${version}` : ''}`;
}

// Includes flag/source reads in the savepoint: even a missing telemetry schema
// must not poison the caller's transaction. No nested BEGIN or COMMIT.
async function metered(client: Connection, orgId: string, input: () => Promise<UsageInput | null>): Promise<UsageResult> {
  const flags = transactionFlags.get(client);
  if (flags?.get(orgId) === false) return { state: 'off' };
  let saved = false;
  try {
    await client.query('SAVEPOINT usage_event');
    saved = true;
    let enabled = flags?.get(orgId);
    if (enabled === undefined) {
      const flag = (await client.query<{ value: unknown; feature_flags: unknown }>(
        `SELECT (SELECT value FROM platform_settings WHERE key='usage_events') AS value, feature_flags FROM organizations WHERE id=$1`, [orgId],
      )).rows[0];
      enabled = usageEventsOn(flag?.value, flag?.feature_flags, orgId);
      flags?.set(orgId, enabled);
    }
    if (!enabled) {
      await client.query('RELEASE SAVEPOINT usage_event');
      return { state: 'off' };
    }
    const context = (await client.query<{ role: string; claim: string | null }>(
      `SELECT current_setting('role') AS role, current_setting('request.jwt.claim.role',true) AS claim`,
    )).rows[0];
    await client.query('SET LOCAL ROLE service_role');
    await client.query(`SELECT set_config('request.jwt.claim.role','service_role',true)`);
    const event = await input();
    let result: UsageResult = { state: 'empty' };
    if (event) {
      const row = (await client.query<{ id: string }>(
        `SELECT app.prop07_record_usage($1,$2,$3::bigint,$4::timestamptz,$5,$6,$7)::text AS id`,
        [event.orgId, event.dimension, event.quantity.toString(), event.occurredAt, event.sourceTable, event.sourceId, event.dedupeKey],
      )).rows[0];
      result = { state: 'recorded', id: row.id };
    }
    await client.query(`SELECT set_config('role',$1,true),set_config('request.jwt.claim.role',$2,true)`, [context.role, context.claim ?? '']);
    await client.query('RELEASE SAVEPOINT usage_event');
    return result;
  } catch (error) {
    if (saved) {
      // ROLLBACK TO also restores SET LOCAL role/claims, including failures while restoring.
      try { await client.query('ROLLBACK TO SAVEPOINT usage_event'); await client.query('RELEASE SAVEPOINT usage_event'); } catch { /* A lost connection cannot be repaired here. */ }
    }
    const code = safeDbCode((error as { code?: unknown } | null)?.code);
    try { logServerError('usage_event', { code }); } catch { /* Diagnostics must not fail business work. */ }
    return { state: 'failed' };
  }
}

/** Trusted server hook; the caller has authorized and written the source in this transaction. */
export async function recordUsage(client: Connection, input: UsageInput): Promise<UsageResult> {
  return metered(client, input.orgId, async () => input);
}

/** Common file-finalization hook. Read bigint as text, preserving all bytes and timestamp precision. */
export async function recordStoredFileUsage(client: Connection, orgId: string, fileId: string): Promise<UsageResult> {
  return metered(client, orgId, async () => {
    const file = (await client.query<{ size: string | null; at: string }>(
      `SELECT size_bytes::text AS size,created_at::text AS at FROM files WHERE org_id=$1 AND id=$2`, [orgId, fileId],
    )).rows[0];
    if (!file?.size || BigInt(file.size) === BigInt(0)) return null;
    return { orgId, dimension: 'stored_bytes', quantity: BigInt(file.size), occurredAt: file.at,
      sourceTable: 'files', sourceId: fileId, dedupeKey: usageDedupeKey('stored_bytes', 'files', fileId) };
  });
}

/** Identical paper bytes for a lease are a retry; a different document hash is a new signature. */
export async function recordPaperSignatureUsage(client: Connection, orgId: string, leaseId: string, sha: string): Promise<UsageResult> {
  return metered(client, orgId, async () => {
    const row = (await client.query<{ id: string; at: string }>(
      `SELECT p.lease_id::text AS id,min(p.created_at)::text AS at FROM lease_signed_pdfs p JOIN files f ON f.id=p.file_id AND f.org_id=p.org_id
       WHERE p.org_id=$1 AND p.lease_id=$2 AND f.sha256=$3 GROUP BY p.lease_id`, [orgId, leaseId, sha],
    )).rows[0];
    if (!row) return null;
    return { orgId, dimension: 'signatures', quantity: BigInt(1), occurredAt: row.at,
      sourceTable: 'leases', sourceId: row.id, dedupeKey: usageDedupeKey('signatures', 'leases', row.id, sha) };
  });
}

export async function recordHandoverAttachmentUsage(client: Connection, orgId: string, attachmentId: string): Promise<UsageResult> {
  return metered(client, orgId, async () => {
    const row = (await client.query<{ id: string; size: string; at: string }>(
      `SELECT id::text,size_bytes::text AS size,created_at::text AS at FROM app.handover_attachments WHERE org_id=$1 AND id=$2`, [orgId, attachmentId],
    )).rows[0];
    if (!row || BigInt(row.size) === BigInt(0)) return null;
    return { orgId, dimension: 'stored_bytes', quantity: BigInt(row.size), occurredAt: row.at,
      sourceTable: 'handover_attachments', sourceId: row.id, dedupeKey: usageDedupeKey('stored_bytes', 'handover_attachments', row.id) };
  });
}

/** No dispatch request ID exists. Consecutive jobs for one vendor are a single
 * intent; a vendor change starts a generation, including A -> B -> A.
 * The caller holds the ticket/job locks. Revocation order (not transaction-start
 * created_at) orders replaced links; the current active job is always last. */
export async function recordVendorDispatchUsage(client: Connection, orgId: string, jobId: string): Promise<UsageResult> {
  return metered(client, orgId, async () => {
    const row = (await client.query<{ id: string; ticket: string; vendor: string; at: string }>(
      `WITH history AS (
         SELECT j.*,row_number() OVER (ORDER BY j.active,coalesce(j.revoked_at,j.created_at),j.id) AS seq
         FROM repair_vendor_jobs j JOIN repair_vendor_jobs current_job
           ON current_job.org_id=j.org_id AND current_job.ticket_id=j.ticket_id
         WHERE current_job.org_id=$1 AND current_job.id=$2
       ), current_job AS (SELECT * FROM history WHERE id=$2), boundary AS (
         SELECT coalesce(max(h.seq),0) AS seq FROM history h,current_job c
         WHERE h.seq<c.seq AND h.vendor_contact_id IS DISTINCT FROM c.vendor_contact_id
       )
       SELECT h.id::text,h.ticket_id::text AS ticket,h.vendor_contact_id::text AS vendor,h.created_at::text AS at
       FROM history h,current_job c,boundary b WHERE h.seq>b.seq AND h.seq<=c.seq ORDER BY h.seq LIMIT 1`, [orgId, jobId],
    )).rows[0];
    if (!row) return null;
    return { orgId, dimension: 'vendor_jobs', quantity: BigInt(1), occurredAt: row.at,
      sourceTable: 'repair_vendor_jobs', sourceId: row.id,
      dedupeKey: usageDedupeKey('vendor_jobs', 'repair_vendor_jobs', row.id, `${row.ticket}:${row.vendor}`) };
  });
}
