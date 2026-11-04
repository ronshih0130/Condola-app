import assert from "node:assert/strict";
import test from "node:test";
import { query } from "./db";
import { generateStatement } from "./domain";
import { FlowError } from "./errors";
import { ORG_ID, ORG2_ID, USERS } from "./ids";
import { statementPreview } from "./statement-preview";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE);
const admin: Session = { userId:USERS.admin,sessionId:"b008",email:"admin@example.invalid",name:"B008",kind:"staff",role:"admin",orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"en",calendar:"gregorian",leaseId:null };
const manager: Session = { ...admin,userId:USERS.manager,role:"manager" };

test("preview is read-only, stale sources block issue and identical sources issue matching frozen amounts", async () => {
  const owner = (await query<{ owner: string; property: string }>(`SELECT po.owner_contact_id::text AS owner,po.property_id::text AS property FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' ORDER BY p.name LIMIT 1`,[ORG_ID])).rows[0];
  const month = "2099-06";
  assert.equal(await statementPreview(admin,owner.owner,month),null);
  const expense = (await query<{ id: string }>(`INSERT INTO expenses(org_id,property_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES ($1,$2,'fixture','TWD',1234,'2099-06-12','owner','owner','approved') RETURNING id::text`,[ORG_ID,owner.property])).rows[0].id;
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  try {
    const before = await query(`SELECT (SELECT count(*) FROM owner_statements)::int AS statements,(SELECT count(*) FROM owner_statement_lines)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audit`);
    await assert.rejects(() => generateStatement(admin,{ownerContactId:owner.owner,month}), (e:unknown) => e instanceof FlowError && e.key === "errors.statementPreviewChanged");
    assert.deepEqual((await query(`SELECT (SELECT count(*) FROM owner_statements)::int AS statements,(SELECT count(*) FROM owner_statement_lines)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audit`)).rows,before.rows);
    const preview = await statementPreview(manager,owner.owner,month);
    assert.ok(preview);
    assert.equal(preview.expenseTotal,1234);
    assert.equal(preview.closing,preview.opening+preview.rent+preview.other-preview.fee-preview.expenseTotal);
    assert.deepEqual((await query(`SELECT (SELECT count(*) FROM owner_statements)::int AS statements,(SELECT count(*) FROM owner_statement_lines)::int AS lines,(SELECT count(*) FROM audit_log)::int AS audit`)).rows,before.rows);
    await assert.rejects(() => generateStatement(manager,{ownerContactId:owner.owner,month,previewFingerprint:preview.fingerprint}), (e:unknown) => e instanceof FlowError && e.key === "errors.forbidden");
    await query(`UPDATE expenses SET amount_minor=4321 WHERE id=$1`,[expense]);
    await assert.rejects(() => generateStatement(admin,{ownerContactId:owner.owner,month,previewFingerprint:preview.fingerprint}), (e:unknown) => e instanceof FlowError && e.key === "errors.statementPreviewChanged");
    assert.equal((await query(`SELECT count(*)::int AS n FROM owner_statements WHERE owner_contact_id=$1 AND period_start='2099-06-01'`,[owner.owner])).rows[0].n,0);
    const fresh = await statementPreview(admin,owner.owner,month); assert.ok(fresh);
    assert.equal(fresh.expenseTotal,4321); assert.notEqual(fresh.fingerprint,preview.fingerprint);
    const result = await generateStatement(admin,{ownerContactId:owner.owner,month,previewFingerprint:fresh.fingerprint});
    const stored = (await query(`SELECT opening_balance_minor::text AS opening,rent_received_minor::text AS rent,other_income_minor::text AS other,management_fee_minor::text AS fee,expenses_minor::text AS expenses,closing_balance_minor::text AS closing FROM owner_statements WHERE id=$1`,[result.statementId])).rows[0];
    assert.deepEqual(Object.fromEntries(Object.entries(stored).map(([k,v]) => [k,Number(v)])),{opening:fresh.opening,rent:fresh.rent,other:fresh.other,fee:fresh.fee,expenses:fresh.expenseTotal,closing:fresh.closing});
    const replay = await generateStatement(admin,{ownerContactId:owner.owner,month,previewFingerprint:fresh.fingerprint});
    assert.equal(replay.statementId,result.statementId);
    assert.deepEqual((await query(`SELECT opening_balance_minor::text AS opening,rent_received_minor::text AS rent,other_income_minor::text AS other,management_fee_minor::text AS fee,expenses_minor::text AS expenses,closing_balance_minor::text AS closing FROM owner_statements WHERE id=$1`,[result.statementId])).rows[0],stored);
  } finally {
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});

test("open-ticket expenses retain legacy OFF totals and are excluded from ON preview and issuance", async () => {
  const owner=(await query<{owner:string;property:string}>(`SELECT po.owner_contact_id::text AS owner,po.property_id::text AS property FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' ORDER BY p.name LIMIT 1`,[ORG_ID])).rows[0];
  try {
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
    const ticket=(await query<{id:string}>(`INSERT INTO maintenance_tickets(org_id,ticket_number,property_id,category,priority,status,title,currency) SELECT $1,coalesce(max(ticket_number),0)+1,$2,'other','normal','open','B008 open repair','TWD' FROM maintenance_tickets WHERE org_id=$1 RETURNING id::text`,[ORG_ID,owner.property])).rows[0].id;
    for (const date of ['2099-12-12','2100-01-12']) {
      await query(`INSERT INTO expenses(org_id,property_id,ticket_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES ($1,$2,$3,'fixture','TWD',1234,$4::date,'owner','owner','approved')`,[ORG_ID,owner.property,ticket,date]);
    }
    assert.equal(await statementPreview(admin,owner.owner,"2099-12"),null);
    const legacy=await generateStatement(admin,{ownerContactId:owner.owner,month:"2099-12"});
    assert.equal((await query<{amount:string}>(`SELECT expenses_minor::text AS amount FROM owner_statements WHERE id=$1`,[legacy.statementId])).rows[0].amount,'1234');

    await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    const preview=await statementPreview(admin,owner.owner,"2100-01");assert.ok(preview);
    assert.equal(preview.expenseTotal,0);
    assert.equal(preview.expenses.some(expense=>expense.ticket_id===ticket),false);
    const issued=await generateStatement(admin,{ownerContactId:owner.owner,month:"2100-01",previewFingerprint:preview.fingerprint});
    const stored=(await query<{amount:string;closing:string}>(`SELECT expenses_minor::text AS amount,closing_balance_minor::text AS closing FROM owner_statements WHERE id=$1`,[issued.statementId])).rows[0];
    assert.equal(stored.amount,'0');
    assert.equal(Number(stored.closing),preview.closing);
  } finally {
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});

test("OFF issuance uses legacy read-committed isolation during a concurrent expense update", async () => {
  const { Client } = await import("pg");
  const owner=(await query<{owner:string;property:string}>(`SELECT po.owner_contact_id::text AS owner,po.property_id::text AS property FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' ORDER BY p.name LIMIT 1`,[ORG_ID])).rows[0];
  await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  const expense=(await query<{id:string}>(`INSERT INTO expenses(org_id,property_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES ($1,$2,'fixture','TWD',1000,'2099-08-10','owner','owner','approved') RETURNING id::text`,[ORG_ID,owner.property])).rows[0].id;
  await query(`CREATE FUNCTION public.b008_test_read_committed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'unexpected isolation'; END IF; IF NEW.period_start='2099-07-01' THEN RAISE EXCEPTION 'fixture serialization error' USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER b008_test_read_committed BEFORE INSERT ON owner_statements FOR EACH ROW EXECUTE FUNCTION public.b008_test_read_committed()`);
  const writer=new Client({connectionString:process.env.DATABASE_URL}); await writer.connect();
  try {
    await writer.query("BEGIN");
    await writer.query(`UPDATE expenses SET amount_minor=1100 WHERE id=$1`,[expense]);
    const result=await generateStatement(admin,{ownerContactId:owner.owner,month:"2099-08"});
    const stored=(await query<{amount:string}>(`SELECT expenses_minor::text AS amount FROM owner_statements WHERE id=$1`,[result.statementId])).rows[0];
    assert.equal(Number(stored.amount),1000);
    await writer.query("COMMIT");
    await assert.rejects(() => generateStatement(admin,{ownerContactId:owner.owner,month:"2099-07"}), (e:unknown) => e instanceof FlowError && e.key === "errors.generic" && (e.cause as { code?:string })?.code === "40001");
  } finally {
    await writer.query("ROLLBACK"); await writer.end();
    await query(`DROP TRIGGER b008_test_read_committed ON owner_statements; DROP FUNCTION public.b008_test_read_committed()`);
  }
});

test("concurrent expense insert, update and void are ordered after the issuance snapshot", async () => {
  const { Client } = await import("pg");
  const owner=(await query<{owner:string;property:string}>(`SELECT po.owner_contact_id::text AS owner,po.property_id::text AS property FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' ORDER BY p.name LIMIT 1`,[ORG_ID])).rows[0];
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  try {
    for (const [month,change] of [["2099-09","insert"],["2099-10","update"],["2099-11","void"]] as const) {
      const expense=(await query<{id:string}>(`INSERT INTO expenses(org_id,property_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES ($1,$2,'fixture','TWD',1000,$3::date,'owner','owner','approved') RETURNING id::text`,[ORG_ID,owner.property,`${month}-10`])).rows[0].id;
      const preview=await statementPreview(admin,owner.owner,month); assert.ok(preview);
      const writer=new Client({connectionString:process.env.DATABASE_URL}); await writer.connect();
      try {
        await writer.query("BEGIN");
        if (change === "insert") await writer.query(`INSERT INTO expenses(org_id,property_id,category,currency,amount_minor,incurred_on,paid_by,bill_to,status) VALUES ($1,$2,'fixture','TWD',500,$3::date,'owner','owner','approved')`,[ORG_ID,owner.property,`${month}-12`]);
        if (change === "update") await writer.query(`UPDATE expenses SET amount_minor=1100 WHERE id=$1`,[expense]);
        if (change === "void") await writer.query(`UPDATE expenses SET status='void' WHERE id=$1`,[expense]);
        const issued=await generateStatement(admin,{ownerContactId:owner.owner,month,previewFingerprint:preview.fingerprint});
        const stored=(await query<{amount:string}>(`SELECT expenses_minor::text AS amount FROM owner_statements WHERE id=$1`,[issued.statementId])).rows[0];
        assert.equal(Number(stored.amount),preview.expenseTotal);
        await writer.query("COMMIT");
        const later=await statementPreview(admin,owner.owner,month); assert.ok(later);
        assert.notEqual(later.fingerprint,preview.fingerprint);
        assert.notEqual(later.expenseTotal,preview.expenseTotal);
      } finally { await writer.query("ROLLBACK"); await writer.end(); }
    }
  } finally {
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});

test("confirmed allocations expose deposit exclusion, residual and recorded line sources", async () => {
  const payment=(await query<{id:string;owner:string;month:string;amount:string;allocation:string;allocated:string;invoice:string}>(`SELECT p.id::text,po.owner_contact_id::text AS owner,to_char(p.paid_on,'YYYY-MM') AS month,p.amount_minor::text AS amount,a.id::text AS allocation,a.amount_minor::text AS allocated,a.invoice_id::text AS invoice FROM payments p JOIN payment_allocations a ON a.payment_id=p.id JOIN leases l ON l.id=p.lease_id JOIN property_owners po ON po.property_id=l.property_id WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];
  assert.ok(payment);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  let line="";
  try {
    line=(await query<{id:string}>(`INSERT INTO invoice_lines(org_id,invoice_id,line_no,charge_type,description,quantity,unit_amount_minor,amount_minor,service_period) VALUES ($1,$2,99,'deposit','B008 deposit',1,500000,500000,'[2026-10-01,2026-11-01)'::daterange) RETURNING id::text`,[ORG_ID,payment.invoice])).rows[0].id;
    await query(`UPDATE payments SET amount_minor=$2 WHERE id=$1`,[payment.id,Number(payment.amount)+1000000]);
    await query(`UPDATE payment_allocations SET amount_minor=$2 WHERE id=$1`,[payment.allocation,Number(payment.allocated)+500000]);
    const result=await statementPreview(admin,payment.owner,payment.month); assert.ok(result);
    const source=result.payments.find((p)=>p.id===payment.id); assert.ok(source);
    const allocation=source.allocations.find((a)=>a.id===payment.allocation); assert.ok(allocation);
    assert.equal(allocation.attributed.deposit,500000);
    assert.equal(source.unallocated,500000);
    assert.equal(allocation.residual,0);
    assert.equal(allocation.lines.find((l)=>l.id===line)?.service_period,"[2026-10-01,2026-11-01)");
    assert.equal(result.rent,result.propertyAmounts.reduce((sum,p)=>sum+p.rent,0));
  } finally {
    await query(`UPDATE payment_allocations SET amount_minor=$2 WHERE id=$1`,[payment.allocation,payment.allocated]);
    await query(`UPDATE payments SET amount_minor=$2 WHERE id=$1`,[payment.id,payment.amount]);
    if (line) await query(`DELETE FROM invoice_lines WHERE id=$1`,[line]);
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});

test("confirmed rent, owner isolation, fee and prior issued balance match the generated statement", async () => {
  const row=(await query<{id:string;owner:string;paid_on:string}>(`SELECT p.id::text,po.owner_contact_id::text AS owner,p.paid_on::text FROM payments p JOIN leases l ON l.id=p.lease_id JOIN property_owners po ON po.property_id=l.property_id WHERE p.org_id=$1 AND p.status='confirmed' LIMIT 1`,[ORG_ID])).rows[0];
  const other=(await query<{owner:string}>(`SELECT DISTINCT po.owner_contact_id::text AS owner FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' AND po.owner_contact_id<>$2 LIMIT 1`,[ORG_ID,row.owner])).rows[0];
  assert.ok(row); assert.ok(other);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  try {
    await query(`UPDATE payments SET paid_on='2099-04-15' WHERE id=$1`,[row.id]);
    const preview=await statementPreview(admin,row.owner,"2099-04"); assert.ok(preview);
    const otherPreview=await statementPreview(admin,other.owner,"2099-04"); assert.ok(otherPreview);
    assert.equal(preview.rent,1000000);
    assert.equal(preview.fee,80000);
    assert.ok(preview.previous);
    assert.equal(preview.opening,Number(preview.previous.closing_balance_minor));
    assert.equal(otherPreview.payments.some((p)=>p.id===row.id),false);
    const issued=await generateStatement(admin,{ownerContactId:row.owner,month:"2099-04",previewFingerprint:preview.fingerprint});
    const stored=(await query<{rent:string;fee:string;opening:string;closing:string}>(`SELECT rent_received_minor::text AS rent,management_fee_minor::text AS fee,opening_balance_minor::text AS opening,closing_balance_minor::text AS closing FROM owner_statements WHERE id=$1`,[issued.statementId])).rows[0];
    assert.deepEqual([Number(stored.rent),Number(stored.fee),Number(stored.opening),Number(stored.closing)],[preview.rent,preview.fee,preview.opening,preview.closing]);
  } finally {
    await query(`UPDATE payments SET paid_on=$2::date WHERE id=$1`,[row.id,row.paid_on]);
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});

test("mixed currency property ownership fails closed", async () => {
  const owner=(await query<{id:string}>(`SELECT po.owner_contact_id::text AS id FROM property_owners po JOIN properties p ON p.id=po.property_id WHERE po.org_id=$1 AND p.currency='TWD' LIMIT 1`,[ORG_ID])).rows[0].id;
  const usd=(await query<{id:string}>(`SELECT id::text FROM properties WHERE org_id=$1 AND currency='USD' LIMIT 1`,[ORG_ID])).rows[0].id;
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  const association=(await query<{id:string}>(`INSERT INTO property_owners(org_id,property_id,owner_contact_id,is_primary) VALUES ($1,$2,$3,false) RETURNING id::text`,[ORG_ID,usd,owner])).rows[0].id;
  try {
    await assert.rejects(() => statementPreview(admin,owner,"2099-03"), (e:unknown) => e instanceof FlowError && e.key === "errors.currency");
    await assert.rejects(() => generateStatement(admin,{ownerContactId:owner,month:"2099-03",previewFingerprint:"fixture"}), (e:unknown) => e instanceof FlowError && e.key === "errors.currency");
  } finally {
    await query(`DELETE FROM property_owners WHERE id=$1`,[association]);
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});

test("preview rejects unauthorized roles and cross-organization or sandbox owner targets", async () => {
  const owner=(await query<{id:string}>(`SELECT owner_contact_id::text AS id FROM property_owners WHERE org_id=$1 LIMIT 1`,[ORG_ID])).rows[0].id;
  const sandbox=(await query<{id:string}>(`INSERT INTO organizations(name,country_code,default_currency,feature_flags,environment,live_org_id) VALUES ('B008 isolated sandbox','TW','TWD','{"billing_previews":true}','sandbox',$1) RETURNING id::text`,[ORG_ID])).rows[0].id;
  await query(`INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'admin','active')`,[sandbox,USERS.admin]);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text,$2::text,$3::text)) WHERE key='billing_previews'`,[ORG_ID,ORG2_ID,sandbox]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=ANY($1::uuid[])`,[[ORG_ID,ORG2_ID]]);
  try {
    await assert.rejects(() => statementPreview({...admin,userId:USERS.maintenance,role:"maintenance"},owner,"2099-02"), (e:unknown) => e instanceof FlowError && e.key === "errors.forbidden");
    await assert.rejects(() => statementPreview({...admin,userId:USERS.coastAdmin,orgId:ORG2_ID,liveOrgId:ORG2_ID},owner,"2099-02"), (e:unknown) => e instanceof FlowError && e.key === "errors.notFound");
    await assert.rejects(() => statementPreview({...admin,orgId:sandbox,environment:"sandbox"},owner,"2099-02"), (e:unknown) => e instanceof FlowError && e.key === "errors.notFound");
  } finally {
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=ANY($1::uuid[])`,[[ORG_ID,ORG2_ID]]);
    await query(`DELETE FROM organizations WHERE id=$1`,[sandbox]);
  }
});

test("a concurrent real ledger reversal is ordered against issuance", async () => {
  const { Client } = await import("pg");
  const payment=(await query<{id:string;ledger:string;owner:string;month:string}>(`SELECT p.id::text,p.ledger_transaction_id::text AS ledger,po.owner_contact_id::text AS owner,to_char(p.paid_on,'YYYY-MM') AS month FROM payments p JOIN leases l ON l.id=p.lease_id JOIN property_owners po ON po.property_id=l.property_id WHERE p.org_id=$1 AND p.status='confirmed' AND p.ledger_transaction_id IS NOT NULL LIMIT 1`,[ORG_ID])).rows[0];
  assert.ok(payment);
  await query(`UPDATE platform_settings SET value=jsonb_build_object('enabled',true,'allowed_org_ids',jsonb_build_array($1::text)) WHERE key='billing_previews'`,[ORG_ID]);
  await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":true}'::jsonb WHERE id=$1`,[ORG_ID]);
  const writer=new Client({connectionString:process.env.DATABASE_URL}); await writer.connect();
  try {
    const preview=await statementPreview(admin,payment.owner,payment.month); assert.ok(preview);
    assert.ok(preview.payments.some((row)=>row.id===payment.id));
    await writer.query("BEGIN");
    await writer.query(`SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('app.active_org_id',$2,true),set_config('app.env','live',true)`,[USERS.admin,ORG_ID]);
    await writer.query("SET LOCAL ROLE authenticated");
    await writer.query(`SELECT post_reversal($1::uuid,'B008 concurrent fixture')`,[payment.ledger]);
    await writer.query(`UPDATE payments SET status='reversed' WHERE id=$1 AND org_id=$2`,[payment.id,ORG_ID]);
    const issue = generateStatement(admin,{ownerContactId:payment.owner,month:payment.month,previewFingerprint:preview.fingerprint}).then((result) => ({ result, error:null }), (error:unknown) => ({ result:null,error }));
    let waiting=false;
    for (let attempt=0;attempt<40;attempt++) {
      const blocked=await query<{waiting:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%UPDATE invoices i%') AS waiting`);
      if (blocked.rows[0].waiting) { waiting=true; break; }
      await new Promise((resolve) => setTimeout(resolve,50));
    }
    assert.equal(waiting,true,"issuance reaches the invoice lock held by reversal");
    await writer.query("COMMIT");
    const outcome=await issue;
    assert.ok(outcome.error instanceof FlowError);
    assert.equal(outcome.error.key,"errors.statementPreviewChanged");
    assert.equal((await query(`SELECT count(*)::int AS n FROM owner_statements WHERE owner_contact_id=$1 AND period_start=$2::date AND status <> 'void'`,[payment.owner,`${payment.month}-01`])).rows[0].n,0);
    const later=await statementPreview(admin,payment.owner,payment.month); assert.ok(later);
    assert.equal(later.payments.some((row)=>row.id===payment.id),false);
    assert.notEqual(later.fingerprint,preview.fingerprint);
  } finally {
    await writer.query("ROLLBACK"); await writer.end();
    await query(`UPDATE platform_settings SET value='{"enabled":false,"allowed_org_ids":[]}'::jsonb WHERE key='billing_previews'`);
    await query(`UPDATE organizations SET feature_flags=feature_flags || '{"billing_previews":false}'::jsonb WHERE id=$1`,[ORG_ID]);
  }
});
