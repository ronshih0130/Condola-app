import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";
import { ORG2_ID, USERS } from "./ids";
import { recordMoveOutNotice } from "./move-out-notice";

const databaseUrl = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;

test("B002 fixed retention, photo boundaries and direct purge guard", async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const createdOrg = await client.query<{ id: string }>(
      `INSERT INTO organizations (name,country_code,default_currency) VALUES ('B002 fixture','TW','TWD') RETURNING id::text`);
    const org = createdOrg.rows[0].id;
    await client.query(`INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'admin')`, [org, USERS.admin]);
    const contact = await client.query<{ id: string }>(
      `INSERT INTO contacts (org_id, user_id, is_tenant, display_name) VALUES ($1,$2,true,'B002 fixture') RETURNING id::text`, [org, USERS.tenant]);
    const property = await client.query<{ id: string }>(
      `INSERT INTO properties (org_id,name,country_code,currency,timezone,default_rental_mode)
       VALUES ($1,'B002 fixture','TW','TWD','Asia/Taipei','whole_unit') RETURNING id::text`, [org]);
    const unit = await client.query<{ id: string }>(
      `INSERT INTO units (org_id,property_id,label,rental_mode) VALUES ($1,$2,'B002','whole_unit') RETURNING id::text`, [org, property.rows[0].id]);
    const lease = await client.query<{ id: string }>(
      `INSERT INTO leases (org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor)
       VALUES ($1,$2,$3,$3,'active',(timezone('Asia/Taipei',now()))::date-1000,'2026-01-01','TWD',0) RETURNING id::text`, [org, property.rows[0].id, unit.rows[0].id]);
    const leaseId = lease.rows[0].id;
    const indefiniteUnit = (await client.query<{ id: string }>(
      `INSERT INTO units(org_id,property_id,label,rental_mode) VALUES ($1,$2,'B002 indefinite','whole_unit') RETURNING id::text`, [org, property.rows[0].id])).rows[0].id;
    const indefinite = (await client.query<{ id: string }>(
      `INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor,id_retention_auto_end)
       VALUES ($1,$2,$3,$3,'active','2025-01-01','TWD',0,false) RETURNING id::text`, [org, property.rows[0].id, indefiniteUnit])).rows[0].id;
    assert.equal((await client.query(`SELECT id_retention_auto_end FROM leases WHERE id=$1`, [indefinite])).rows[0].id_retention_auto_end, false);
    await client.query(`UPDATE leases SET status='terminated',terminated_on='2025-10-01',id_retention_auto_end=false WHERE id=$1`, [indefinite]);
    const auto = (await client.query(`SELECT end_date::text,id_retention_auto_end FROM leases WHERE id=$1`, [indefinite])).rows[0];
    assert.deepEqual(auto, { end_date: "2025-10-01", id_retention_auto_end: true });
    await client.query(`UPDATE leases SET moved_out_on='2025-11-01',id_retention_auto_end=false WHERE id=$1`, [indefinite]);
    assert.equal((await client.query(`SELECT id_document_delete_after($1,$2,now())::text AS due`, [indefinite, org])).rows[0].due, "2026-01-30");
    const due = async () => (await client.query<{ due: string }>(
      `SELECT id_document_delete_after($1,$2,'2025-01-01 17:00:00+00')::text AS due`, [leaseId, org])).rows[0].due;
    await client.query(`UPDATE leases SET moved_out_on='2025-09-01' WHERE id=$1`, [leaseId]);
    assert.equal(await due(), "2026-04-01");
    await client.query(`UPDATE leases SET terminated_on='2025-12-01' WHERE id=$1`, [leaseId]);
    assert.equal(await due(), "2026-03-01");
    await client.query(`UPDATE leases SET status='draft', esign_status='voided' WHERE id=$1`, [leaseId]);
    assert.equal(await due(), "2025-04-02");
    assert.equal((await client.query<{ due: string }>(`SELECT id_document_delete_after($1,$2,'2025-01-01 17:00:00+00')::text AS due`, [leaseId, ORG2_ID])).rows[0].due, "9999-12-31");
    assert.equal((await client.query<{ days: number }>(`SELECT id_document_keep_days() AS days`)).rows[0].days, 90);
    await client.query(`UPDATE leases SET status='active', esign_status='not_sent', end_date=(timezone('Asia/Taipei',now()))::date-90 WHERE id=$1`, [leaseId]);
    const doc = await client.query<{ id: string }>(
      `INSERT INTO identity_documents (org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref)
       VALUES ($1,$2,$3,'passport','A***CD',$4,'fixture-key-ref') RETURNING id::text`,
      [org, contact.rows[0].id, leaseId, `${org}/b002/doc`]);
    const id = doc.rows[0].id;
    await client.query(`INSERT INTO identity_document_photos (org_id,document_id,slot,storage_bucket,storage_path,mime_type,size_bytes,sha256)
      VALUES ($1,$2,'front','id-documents-private',$3,'image/jpeg',1200,$4)`,
      [org, id, `${org}/b002/photo`, "a".repeat(64)]);
    // Stale future cache must not make an expired document readable or prevent preview.
    await client.query(`UPDATE identity_documents SET delete_after=(timezone('Asia/Taipei',now()))::date+100 WHERE id=$1`, [id]);
    for (const actor of [USERS.admin, USERS.tenant]) {
      const gate = await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,$3,'live')`, [actor, id, org]);
      assert.equal(gate.rowCount, 0);
      assert.equal((await client.query(`SELECT 1 FROM id_photo_open(NULL,$1,$2,'front',$3,'live')`, [actor, id, org])).rowCount, 0);
    }
    const preview = await client.query<{ document_id: string; storage_path: string }>(
      `SELECT document_id::text, storage_path FROM preview_due_identity_documents(1000) WHERE document_id=$1`, [id]);
    assert.deepEqual(preview.rows.map((row) => row.document_id), [id, id]);
    assert.deepEqual(preview.rows.map((row) => row.storage_path).sort(), [`${org}/b002/doc`, `${org}/b002/photo`].sort());
    // Re-enable a future date: only the exact selected live org/environment can read it.
    await client.query(`UPDATE leases SET end_date=(timezone('Asia/Taipei',now()))::date-89, terminated_on=NULL WHERE id=$1`, [leaseId]);
    for (const actor of [USERS.admin, USERS.tenant]) {
      assert.equal((await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,$3,'live')`, [actor, id, org])).rowCount, 1);
      assert.equal((await client.query(`SELECT 1 FROM id_photo_open(NULL,$1,$2,'front',$3,'live')`, [actor, id, org])).rowCount, 1);
      assert.equal((await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,$3,'sandbox')`, [actor, id, org])).rowCount, 0);
      assert.equal((await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,$3,'live')`, [actor, id, ORG2_ID])).rowCount, 0);
      assert.equal((await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,NULL,NULL)`, [actor, id])).rowCount, 1, `legacy null gate ${actor}`);
      assert.equal((await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,NULL,NULL)`, [USERS.coastAdmin, id])).rowCount, 0);
    }
    await client.query(`CREATE TEMP TABLE b002_old_caller (n integer)`);
    for (const value of [null, '"off"', '"dry_run"', 'true', '"ON"']) {
      await client.query(`DELETE FROM platform_settings WHERE key='ID_PURGE_ENABLED'`);
      if (value !== null) await client.query(`INSERT INTO platform_settings(key,value) VALUES ('ID_PURGE_ENABLED',$1::jsonb)`, [value]);
      await client.query("SAVEPOINT old_caller");
      await client.query(`INSERT INTO b002_old_caller VALUES (1)`);
      await assert.rejects(client.query(`SELECT * FROM purge_due_identity_documents(1)`), (error: unknown) => (error as { code?: string }).code === "42501");
      await client.query("ROLLBACK TO SAVEPOINT old_caller");
      assert.equal((await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM b002_old_caller`)).rows[0].n, "0");
    }
    // Make the original document due and create an independent future document.
    await client.query(`UPDATE leases SET end_date=(timezone('Asia/Taipei',now()))::date-90, terminated_on=NULL WHERE id=$1`, [leaseId]);
    const freshContact = await client.query<{ id: string }>(
      `INSERT INTO contacts(org_id,is_tenant,display_name) VALUES ($1,true,'B002 future') RETURNING id::text`, [org]);
    const freshDoc = await client.query<{ id: string }>(
      `INSERT INTO identity_documents(org_id,contact_id,doc_type,number_masked,storage_path,encryption_key_ref)
       VALUES ($1,$2,'passport','A***CD',$3,'fixture-key-ref') RETURNING id::text`,
      [org, freshContact.rows[0].id, `${org}/b002/future-doc`]);
    const futureId = freshDoc.rows[0].id;
    const futurePath = `${org}/b002/future-photo`;
    await client.query(`INSERT INTO identity_document_photos(org_id,document_id,slot,storage_bucket,storage_path,mime_type,size_bytes,sha256)
      VALUES ($1,$2,'front','id-documents-private',$3,'image/jpeg',1200,$4)`, [org, futureId, futurePath, "b".repeat(64)]);
    for (const path of [`${org}/b002/photo`, futurePath]) {
      await client.query(`INSERT INTO id_document_objects(bucket,path,mime_type,byte_size,sha256,ciphertext)
        VALUES ('id-documents-private',$1,'image/jpeg',1,$2,$3)`, [path, "c".repeat(64), Buffer.from([1])]);
      await client.query(`INSERT INTO id_document_wm_objects(bucket,path,mime_type,byte_size,sha256,ciphertext)
        VALUES ('id-documents-private',$1,'image/jpeg',1,$2,$3)`, [path + ".wm", "d".repeat(64), Buffer.from([2])]);
    }
    await client.query(`INSERT INTO platform_settings(key,value) VALUES ('ID_PURGE_ENABLED','"on"') ON CONFLICT (key) DO UPDATE SET value=excluded.value`);
    const purged = await client.query<{ document_id: string; storage_path: string }>(
      `SELECT document_id::text,storage_path FROM purge_due_identity_documents(1000)`);
    assert.deepEqual(purged.rows.filter((row) => row.document_id === id).map((row) => row.storage_path).sort(), [`${org}/b002/doc`, `${org}/b002/photo`].sort());
    assert.equal(purged.rows.some((row) => row.document_id === futureId), false);
    const state = await client.query<{ deleted: boolean; photos: string; objects: string; watermarks: string; audits: string }>(
      `SELECT d.deleted_at IS NOT NULL AS deleted,
              (SELECT count(*)::text FROM identity_document_photos p WHERE p.document_id=d.id) AS photos,
              (SELECT count(*)::text FROM id_document_objects o WHERE o.path=$2) AS objects,
              (SELECT count(*)::text FROM id_document_wm_objects w WHERE w.path=$2||'.wm') AS watermarks,
              (SELECT count(*)::text FROM audit_log a WHERE a.org_id=d.org_id AND a.row_id=d.id::text AND a.event_type='id_document_purged') AS audits
         FROM identity_documents d WHERE d.id=$1`, [id, `${org}/b002/photo`]);
    assert.deepEqual(state.rows[0], { deleted: true, photos: "0", objects: "0", watermarks: "0", audits: "1" });
    const intact = await client.query<{ deleted: boolean; photos: string; objects: string; watermarks: string }>(
      `SELECT d.deleted_at IS NOT NULL AS deleted,
              (SELECT count(*)::text FROM identity_document_photos p WHERE p.document_id=d.id) AS photos,
              (SELECT count(*)::text FROM id_document_objects o WHERE o.path=$2) AS objects,
              (SELECT count(*)::text FROM id_document_wm_objects w WHERE w.path=$2||'.wm') AS watermarks
         FROM identity_documents d WHERE d.id=$1`, [futureId, futurePath]);
    assert.deepEqual(intact.rows[0], { deleted: false, photos: "1", objects: "1", watermarks: "1" });
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

test("move-out audit records authenticated actor and both corrections", async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const previous = process.env.MOVE_OUT_NOTICE_ENABLED;
  process.env.MOVE_OUT_NOTICE_ENABLED = "true";
  const moveOutNoticeSetting = await client.query(`SELECT value FROM platform_settings WHERE key='move_out_notice'`);
  try {
    const org = (await client.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency) VALUES ('B002 audit','TW','TWD') RETURNING id::text`)).rows[0].id;
    await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'admin','active')`, [org, USERS.admin]);
    await client.query(`INSERT INTO platform_settings(key, value) VALUES ('move_out_notice', jsonb_build_object('enabled', true, 'allowed_org_ids', jsonb_build_array($1::text))) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [org]);
    await client.query(`UPDATE organizations SET feature_flags = jsonb_set(coalesce(feature_flags, '{}'::jsonb), '{move_out_notice}', 'true'::jsonb, true) WHERE id IN ($1)`, [org]);
    const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'B002 audit','TW','TWD','Asia/Taipei') RETURNING id::text`, [org])).rows[0].id;
    const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'B002 audit') RETURNING id::text`, [org, property])).rows[0].id;
    const lease = (await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active','2025-01-01','TWD',0) RETURNING id::text`, [org, property, unit])).rows[0].id;
    const input = { orgId: org, liveOrgId: org, environment: "live" as const, leaseId: lease, actorUserId: USERS.admin };
    assert.deepEqual(await recordMoveOutNotice(client, { ...input, movedOutOn: "2025-10-01" }), { ok: true });
    assert.deepEqual(await recordMoveOutNotice(client, { ...input, movedOutOn: "2025-11-01", reason: "Synthetic correction" }), { ok: true });
    const rows = (await client.query(`SELECT actor_user_id::text AS actor,reason,old_row->>'moved_out_on' AS old_date,new_row->>'moved_out_on' AS new_date
      FROM audit_log WHERE org_id=$1 AND table_name='leases' AND row_id=$2 AND action='update'
       AND changed_cols @> ARRAY['moved_out_on']::text[] ORDER BY id`, [org, lease])).rows;
    assert.deepEqual(rows, [
      { actor: USERS.admin, reason: "move-out notice (CAP-M-13)", old_date: null, new_date: "2025-10-01" },
      { actor: USERS.admin, reason: "Synthetic correction", old_date: "2025-10-01", new_date: "2025-11-01" },
    ]);
    assert.deepEqual(await recordMoveOutNotice(client, { ...input, actorUserId: USERS.tenant, movedOutOn: "2025-12-01" }), { ok: false, reason: "forbidden" });
  } finally {
    if (previous === undefined) delete process.env.MOVE_OUT_NOTICE_ENABLED; else process.env.MOVE_OUT_NOTICE_ENABLED = previous;
    if (moveOutNoticeSetting.rows.length) await client.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='move_out_notice'`, [JSON.stringify(moveOutNoticeSetting.rows[0].value)]);
    else await client.query(`DELETE FROM platform_settings WHERE key='move_out_notice'`);
    await client.end();
  }
});

test("purge and retention correction serialize on the lease before the document", async () => {
  const first = new Client({ connectionString: databaseUrl });
  const second = new Client({ connectionString: databaseUrl });
  const observer = new Client({ connectionString: databaseUrl });
  await Promise.all([first.connect(), second.connect(), observer.connect()]);
  const setting = await observer.query(`SELECT value FROM platform_settings WHERE key='ID_PURGE_ENABLED'`);
  async function fixture() {
    const org = (await observer.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency) VALUES ('B002 race','TW','TWD') RETURNING id::text`)).rows[0].id;
    const contact = (await observer.query<{ id: string }>(`INSERT INTO contacts(org_id,is_tenant,display_name) VALUES ($1,true,'B002 race') RETURNING id::text`, [org])).rows[0].id;
    const property = (await observer.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'B002 race','TW','TWD','Asia/Taipei') RETURNING id::text`, [org])).rows[0].id;
    const unit = (await observer.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,'B002 race') RETURNING id::text`, [org, property])).rows[0].id;
    const lease = (await observer.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor) VALUES ($1,$2,$3,$3,'active',(timezone('Asia/Taipei',now()))::date-1000,(timezone('Asia/Taipei',now()))::date-100,'TWD',0) RETURNING id::text`, [org, property, unit])).rows[0].id;
    const document = (await observer.query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref) VALUES ($1,$2,$3,'passport','A***CD',$4,'fixture-key-ref') RETURNING id::text`, [org, contact, lease, `${org}/race/document`])).rows[0].id;
    return { lease, document };
  }
  try {
    await observer.query(`INSERT INTO platform_settings(key,value) VALUES ('ID_PURGE_ENABLED','"on"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    const correctionFirst = await fixture();
    await first.query("BEGIN");
    await first.query(`UPDATE leases SET end_date=(timezone('Asia/Taipei',now()))::date+100 WHERE id=$1`, [correctionFirst.lease]);
    const skipped = await second.query(`SELECT document_id FROM purge_due_identity_documents(1000)`);
    assert.equal(skipped.rows.some((row) => row.document_id === correctionFirst.document), false);
    await first.query("COMMIT");
    assert.equal((await observer.query(`SELECT deleted_at FROM identity_documents WHERE id=$1`, [correctionFirst.document])).rows[0].deleted_at, null);

    const purgeFirst = await fixture();
    await first.query("BEGIN");
    const purged = await first.query(`SELECT document_id FROM purge_due_identity_documents(1000)`);
    assert.equal(purged.rows.some((row) => row.document_id === purgeFirst.document), true);
    const pid = (await second.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
    const correction = second.query(`UPDATE leases SET end_date=(timezone('Asia/Taipei',now()))::date+100 WHERE id=$1`, [purgeFirst.lease]);
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      waiting = (await observer.query<{ waiting: boolean }>(`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1`, [pid])).rows[0]?.waiting === true;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "correction must wait for the purge lease lock");
    await first.query("COMMIT");
    await correction;
    assert.notEqual((await observer.query(`SELECT deleted_at FROM identity_documents WHERE id=$1`, [purgeFirst.document])).rows[0].deleted_at, null);
  } finally {
    await first.query("ROLLBACK").catch(() => undefined);
    if (setting.rows.length) await observer.query(`UPDATE platform_settings SET value=$1::jsonb WHERE key='ID_PURGE_ENABLED'`, [JSON.stringify(setting.rows[0].value)]);
    else await observer.query(`DELETE FROM platform_settings WHERE key='ID_PURGE_ENABLED'`);
    await Promise.all([first.end(), second.end(), observer.end()]);
  }
});

test("retention expiry uses the Taipei policy date independently of database time zone", async () => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const zone of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT set_config('TimeZone',$1,true)`, [zone]);
        await client.query(`INSERT INTO platform_settings(key,value) VALUES ('ID_PURGE_ENABLED','"on"') ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
        const org = (await client.query<{ id: string }>(`INSERT INTO organizations(name,country_code,default_currency) VALUES ('B002 clock','TW','TWD') RETURNING id::text`)).rows[0].id;
        await client.query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'admin','active')`, [org, USERS.admin]);
        const contact = (await client.query<{ id: string }>(`INSERT INTO contacts(org_id,user_id,is_tenant,display_name) VALUES ($1,$2,true,'B002 clock') RETURNING id::text`, [org, USERS.tenant])).rows[0].id;
        const property = (await client.query<{ id: string }>(`INSERT INTO properties(org_id,name,country_code,currency,timezone) VALUES ($1,'B002 clock','TW','TWD','Asia/Taipei') RETURNING id::text`, [org])).rows[0].id;
        const docs: string[] = [];
        for (const days of [90, 89]) {
          const unit = (await client.query<{ id: string }>(`INSERT INTO units(org_id,property_id,label) VALUES ($1,$2,$3) RETURNING id::text`, [org, property, `clock-${days}`])).rows[0].id;
          const lease = (await client.query<{ id: string }>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,end_date,currency,rent_amount_minor)
            VALUES ($1,$2,$3,$3,'active',(timezone('Asia/Taipei',now()))::date-1000,(timezone('Asia/Taipei',now()))::date-$4::integer,'TWD',0) RETURNING id::text`, [org, property, unit, days])).rows[0].id;
          docs.push((await client.query<{ id: string }>(`INSERT INTO identity_documents(org_id,contact_id,lease_id,doc_type,number_masked,storage_path,encryption_key_ref) VALUES ($1,$2,$3,'passport','A***CD',$4,'fixture-key-ref') RETURNING id::text`, [org, contact, lease, `${org}/clock/${days}`])).rows[0].id);
        }
        assert.equal((await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,$3,'live')`, [USERS.admin, docs[0], org])).rowCount, 0, zone);
        assert.equal((await client.query(`SELECT 1 FROM id_photo_gate(NULL,$1,$2,$3,'live')`, [USERS.admin, docs[1], org])).rowCount, 1, zone);
        const preview = await client.query(`SELECT document_id::text FROM preview_due_identity_documents(1000) WHERE document_id=ANY($1::uuid[])`, [docs]);
        assert.deepEqual(preview.rows.map((row) => row.document_id), [docs[0]], zone);
        const purged = await client.query(`SELECT document_id::text FROM purge_due_identity_documents(1000) WHERE document_id=ANY($1::uuid[])`, [docs]);
        assert.deepEqual(purged.rows.map((row) => row.document_id), [docs[0]], zone);
        const state = await client.query(`SELECT id::text,deleted_at IS NOT NULL AS deleted FROM identity_documents WHERE id=ANY($1::uuid[])`, [docs]);
        const byId = new Map(state.rows.map((row) => [row.id, row.deleted]));
        assert.equal(byId.get(docs[0]), true, zone);
        assert.equal(byId.get(docs[1]), false, zone);
      } finally { await client.query("ROLLBACK"); }
    }
  } finally { await client.end(); }
});
