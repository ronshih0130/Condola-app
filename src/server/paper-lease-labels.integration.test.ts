import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { disposableDbUrl } from "./test-disposable-db";
import type { Session } from "./types";

const url = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
process.env.PAPER_LEASE_VERSIONS_ENABLED = "true";

test("paper history shows only same-org visible uploader names with org timezone", async () => {
  const { listPaperLeaseVersions } = await import("./paper-lease-versions");
  const db = new Client({ connectionString: url });
  await db.connect();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  let org = "";
  let otherOrg = "";
  let lease = "";
  try {
    for (const id of ids) await db.query("INSERT INTO auth.users(id) VALUES ($1)", [id]);
    for (const [id, name] of [[ids[0], "Viewer"], [ids[1], "  Colleague  "], [ids[2], "  "], [ids[3], "Other firm"], [ids[4], "Removed"]] as const)
      await db.query("INSERT INTO profiles(id,display_name) VALUES ($1,$2)", [id, name]);
    org = (await db.query<{id:string}>(`INSERT INTO organizations(name,country_code,default_currency,timezone,feature_flags)
      VALUES ('Labels fixture','TW','TWD','America/Los_Angeles','{"paper_lease_versions":true}') RETURNING id::text`)).rows[0].id;
    otherOrg = (await db.query<{id:string}>(`INSERT INTO organizations(name,country_code,default_currency,feature_flags)
      VALUES ('Other labels fixture','TW','TWD','{"paper_lease_versions":true}') RETURNING id::text`)).rows[0].id;
    for (const id of [ids[0], ids[1], ids[2]])
      await db.query("INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'manager')", [org,id]);
    await db.query("INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'manager')", [otherOrg,ids[3]]);
    await db.query("INSERT INTO org_members(org_id,user_id,role,status) VALUES ($1,$2,'manager','removed')", [org,ids[4]]);
    const property = (await db.query<{id:string}>(`INSERT INTO properties(org_id,name,country_code,currency,timezone,default_rental_mode)
      VALUES ($1,'Labels','TW','TWD','America/Los_Angeles','whole_unit') RETURNING id::text`,[org])).rows[0].id;
    const unit = (await db.query<{id:string}>(`INSERT INTO units(org_id,property_id,label,rental_mode)
      VALUES ($1,$2,'Labels','whole_unit') RETURNING id::text`,[org,property])).rows[0].id;
    lease = (await db.query<{id:string}>(`INSERT INTO leases(org_id,property_id,unit_id,target_unit_id,status,start_date,currency,rent_amount_minor)
      VALUES ($1,$2,$3,$3,'active',current_date,'TWD',0) RETURNING id::text`,[org,property,unit])).rows[0].id;
    const bytes = Buffer.from("%PDF-1.4\nfixture\n%%EOF");
    for (const [index, uploader] of [ids[1],ids[2],ids[3],ids[4],null].entries()) {
      const path = `${org}/${lease}/${randomUUID()}.pdf`;
      const file = (await db.query<{id:string}>(`INSERT INTO files(org_id,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by)
        VALUES ($1,'lease-documents-private',$2,$3,'application/pdf',$4,$5) RETURNING id::text`,
        [org,path,`label-${index}.pdf`,bytes.length,uploader])).rows[0].id;
      await db.query(`INSERT INTO lease_signed_pdfs(org_id,lease_id,file_id,object_path,content)
        VALUES ($1,$2,$3,$4,$5)`,[org,lease,file,path,bytes]);
    }
    const session: Session = {userId:ids[0],sessionId:"synthetic",email:"",name:"Viewer",kind:"staff",role:"manager",
      orgId:org,liveOrgId:org,environment:"live",locale:"zh-TW",calendar:"roc",leaseId:null};
    const rows = (await listPaperLeaseVersions(session, lease))!;
    assert.equal(rows.length,5);
    const name = (file: string) => rows.find(row => row.file_name === file)?.uploader_name;
    assert.equal(name("label-0.pdf"),"Colleague");
    for (const i of [1,2,3,4]) assert.equal(name(`label-${i}.pdf`),null);
    assert.ok(rows.every(row => row.timezone === "America/Los_Angeles" && !("uploaded_by" in row)));
    assert.equal((await listPaperLeaseVersions({...session,orgId:otherOrg,liveOrgId:otherOrg},lease))?.length ?? 0,0);
    assert.equal(await listPaperLeaseVersions({...session,kind:"tenant",role:null},lease),null);
    await db.query(`UPDATE organizations SET feature_flags='{"paper_lease_versions":false}' WHERE id=$1`,[org]);
    assert.equal(await listPaperLeaseVersions(session,lease),null);
  } finally {
    if (lease) await db.query("DELETE FROM leases WHERE id=$1",[lease]);
    if (org) await db.query("DELETE FROM organizations WHERE id=$1",[org]);
    if (otherOrg) await db.query("DELETE FROM organizations WHERE id=$1",[otherOrg]);
    await db.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])",[ids]);
    await db.end();
  }
});
