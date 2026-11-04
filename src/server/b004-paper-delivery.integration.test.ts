import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { ORG2_ID, USERS } from "./ids";
import { TENANT_SIGNED_PDFS_QUERY } from "./queries";
import { insertSandboxOrg } from "./sandbox";
import { disposableDbUrl } from "./test-disposable-db";

const url = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;

test("B004 tenant pinning, current pointer and bounded version delete guard", async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const org = (await client.query<{ id: string }>(
      `INSERT INTO organizations(name,country_code,default_currency,feature_flags)
       VALUES ('B004 fixture','TW','TWD','{"tenant_signed_pdf":true}') RETURNING id::text`)).rows[0].id;
    await client.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'admin')`, [org, USERS.admin]);
    const sandbox = await insertSandboxOrg(client, org, USERS.admin);
    const otherOrg = (await client.query<{ id: string }>(
      `INSERT INTO organizations(name,country_code,default_currency,feature_flags)
       VALUES ('B004 other','TW','TWD','{"tenant_signed_pdf":true}') RETURNING id::text`)).rows[0].id;
    await client.query(`INSERT INTO platform_settings(key,value) VALUES ('tenant_signed_pdf','true'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`);
    async function fixture(firm: string) {
      const contact = (await client.query<{ id: string }>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name)
        VALUES ($1,$2,true,'B004 tenant') RETURNING id::text`, [firm, USERS.tenant])).rows[0].id;
      const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode)
        VALUES ($1,'B004','TW','TWD','Asia/Taipei','whole_unit') RETURNING id::text`, [firm])).rows[0].id;
      const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label,rental_mode)
        VALUES ($1,$2,'B004','whole_unit') RETURNING id::text`, [firm, property])).rows[0].id;
      const lease = (await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor)
        VALUES ($1,$2,$3,$3,'active',current_date,'TWD',0) RETURNING id::text`, [firm, property, unit])).rows[0].id;
      await client.query(`INSERT INTO lease_parties(org_id,lease_id,contact_id) VALUES ($1,$2,$3)`, [firm, lease, contact]);
      const bytes = Buffer.from("%PDF-1.4\nB004\n%%EOF");
      async function pdf() {
        const path = `${firm}/${lease}/${randomUUID()}.pdf`;
        const file = (await client.query<{ id: string }>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
          VALUES ($1,'lease-documents-private',$2,'test.pdf','application/pdf',$3,$4) RETURNING id::text`, [firm, path, bytes.length, USERS.admin])).rows[0].id;
        const id = (await client.query<{ id: string }>(`INSERT INTO lease_signed_pdfs(org_id,lease_id,file_id,object_path,content)
          VALUES ($1,$2,$3,$4,$5) RETURNING id::text`, [firm, lease, file, path, bytes])).rows[0].id;
        return { id, file };
      }
      return { firm, lease, pdf };
    }
    const live = await fixture(org);
    const sample = await fixture(sandbox);
    const other = await fixture(otherOrg);
    const first = await live.pdf();
    const second = await live.pdf();
    const samplePdf = await sample.pdf();
    const otherPdf = await other.pdf();
    // Make timestamps equal and point to the older version; pointer beats ordering.
    await client.query(`UPDATE leases SET document_file_id=$1 WHERE id=$2`, [first.file, live.lease]);
    const context = async <T>(user: string, pin: string, env: string, role: "authenticated" | "service_role" | "anon", fn: () => Promise<T>) => {
      await client.query("SAVEPOINT b004_scope");
      try {
        await client.query(`SELECT set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role',$2,true),
          set_config('app.active_org_id',$3,true), set_config('app.env',$4,true)`, [user, role, pin, env]);
        await client.query(`SET LOCAL ROLE ${role}`);
        return await fn();
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT b004_scope");
        await client.query("RELEASE SAVEPOINT b004_scope");
      }
    };
    const visible = async () => (await client.query<{ id: string }>(`SELECT id::text FROM lease_signed_pdfs WHERE id=ANY($1::uuid[]) ORDER BY id`, [[first.id, second.id, samplePdf.id, otherPdf.id]])).rows.map((r) => r.id);
    assert.deepEqual(await context(USERS.tenant, org, "live", "authenticated", visible), [first.id, second.id].sort());
    assert.deepEqual(await context(USERS.tenant, sandbox, "sandbox", "authenticated", visible), [samplePdf.id]);
    assert.deepEqual(await context(USERS.tenant, "", "", "authenticated", visible), [first.id, second.id, otherPdf.id].sort());
    assert.deepEqual(await context(USERS.tenant, sandbox, "live", "authenticated", visible), []);
    assert.deepEqual(await context(USERS.tenant, otherOrg, "live", "authenticated", visible), [otherPdf.id]);
    assert.deepEqual(await context(USERS.tenant, ORG2_ID, "live", "authenticated", visible), []);
    assert.deepEqual(await context(USERS.owner2, org, "live", "authenticated", visible), []);
    await assert.rejects(context("", org, "live", "anon", visible), (error: unknown) => (error as { code?: string }).code === "42501");
    const list = await context(USERS.tenant, org, "live", "authenticated", () => client.query<{ id: string; current: boolean }>(TENANT_SIGNED_PDFS_QUERY, [org, live.lease]));
    assert.deepEqual(list.rows.map((row) => [row.id, row.current]), [[first.id, true], [second.id, false]]);
    await client.query(`UPDATE leases SET document_file_id=NULL WHERE id=$1`, [live.lease]);
    const fallback = await context(USERS.tenant, org, "live", "authenticated", () => client.query<{ id: string; current: boolean }>(TENANT_SIGNED_PDFS_QUERY, [org, live.lease]));
    assert.equal(fallback.rows.filter((row) => row.current).length, 1);
    assert.equal(fallback.rows.find((row) => row.current)?.id, [first.id, second.id].sort().at(-1));
    // Exercise the trigger even when a deployment has separately granted UPDATE.
    await client.query(`GRANT UPDATE ON lease_signed_pdfs TO service_role`);
    for (const role of ["authenticated", "service_role"] as const) {
      await assert.rejects(context(USERS.admin, org, "live", role, () => client.query(`DELETE FROM lease_signed_pdfs WHERE id=$1`, [second.id])), (error: unknown) => (error as { code?: string }).code === "42501");
      await assert.rejects(context(USERS.admin, org, "live", role, () => client.query(`UPDATE lease_signed_pdfs SET content=$2 WHERE id=$1`, [second.id, Buffer.from("%PDF-1.4\nchanged")])) , (error: unknown) => (error as { code?: string }).code === "42501");
    }
    // A real parent-file cascade is retained. It is not a direct version delete.
    await client.query(`DELETE FROM files WHERE id=$1`, [samplePdf.file]);
    assert.equal((await client.query(`SELECT id FROM lease_signed_pdfs WHERE id=$1`, [samplePdf.id])).rowCount, 0);
    const cascadePdf = await sample.pdf();
    await client.query(`DELETE FROM leases WHERE id=$1`, [sample.lease]);
    assert.equal((await client.query(`SELECT id FROM lease_signed_pdfs WHERE id=$1`, [cascadePdf.id])).rowCount, 0);
    const oldPaper = await live.pdf();
    const replacementPath = `${org}/${live.lease}/${randomUUID()}.pdf`;
    const replacementFile = (await client.query<{ id: string }>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
      VALUES ($1,'lease-documents-private',$2,'replacement.pdf','application/pdf',$3,$4) RETURNING id::text`, [org, replacementPath, Buffer.from("%PDF-1.4\nold").length, USERS.admin])).rows[0].id;
    await client.query("SAVEPOINT b004_reason_code");
    try {
      await assert.rejects(client.query(`INSERT INTO lease_signed_pdfs(org_id,lease_id,file_id,object_path,content,replace_reason,supersedes_id)
        VALUES ($1,$2,$3,$4,$5,'Corrected paper copy',$6)`, [org, live.lease, replacementFile, replacementPath, Buffer.from("%PDF-1.4\nnew"), oldPaper.id]),
        (error: unknown) => (error as { code?: string; constraint?: string }).code === "23514" && (error as { constraint?: string }).constraint === "lease_signed_pdfs_replace_reason_code");
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT b004_reason_code");
      await client.query("RELEASE SAVEPOINT b004_reason_code");
    }
    const replacement = (await client.query<{ id: string }>(`INSERT INTO lease_signed_pdfs(org_id,lease_id,file_id,object_path,content,replace_reason,supersedes_id)
      VALUES ($1,$2,$3,$4,$5,'corrected_signature',$6) RETURNING id::text`, [org, live.lease, replacementFile, replacementPath, Buffer.from("%PDF-1.4\nnew"), oldPaper.id])).rows[0].id;
    const beforeDelete = (await client.query<{ content: Buffer }>(`SELECT content FROM lease_signed_pdfs WHERE id=$1`, [oldPaper.id])).rows[0].content;
    for (const role of ["authenticated", "service_role"] as const) {
      await assert.rejects(context(USERS.admin, org, "live", role, () => client.query(`DELETE FROM lease_signed_pdfs WHERE id=$1`, [oldPaper.id])), (error: unknown) => (error as { code?: string }).code === "42501");
    }
    const afterDelete = await client.query<{ id: string; reason: string | null; supersedes: string | null; content: Buffer }>(
      `SELECT id::text, replace_reason AS reason, supersedes_id::text AS supersedes, content FROM lease_signed_pdfs WHERE id=ANY($1::uuid[])`,
      [[oldPaper.id, replacement]]);
    const keptOld = afterDelete.rows.find((row) => row.id === oldPaper.id);
    const keptNew = afterDelete.rows.find((row) => row.id === replacement);
    assert.ok(keptOld);
    assert.deepEqual(keptOld.content, beforeDelete);
    assert.equal(keptOld.reason, null);
    assert.equal(keptNew?.supersedes, oldPaper.id);
    assert.equal(keptNew?.reason, "corrected_signature");
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_signed_pdf":false}'::jsonb WHERE id=$1`, [org]);
    assert.deepEqual(await context(USERS.tenant, org, "live", "authenticated", visible), []);
    await client.query(`UPDATE organizations SET feature_flags=feature_flags || '{"tenant_signed_pdf":true}'::jsonb WHERE id=$1`, [org]);
    await client.query(`DELETE FROM platform_settings WHERE key='tenant_signed_pdf'`);
    assert.deepEqual(await context(USERS.tenant, org, "live", "authenticated", visible), []);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
