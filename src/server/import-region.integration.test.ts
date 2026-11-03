import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { tx } from "./db";
import { commitImportBatch, dryRunImport, previewImport, readImportBody } from "./import-batch";
import { loadImportRegion } from "./import-region-context";
import { ORG_ID, USERS } from "./ids";
import { disposableDbUrl } from "./test-disposable-db";
import { insertTestAuthSession } from "./test-auth-session";
import type { Session } from "./types";

const url = disposableDbUrl(process.env.DATABASE_URL, process.env.CONDOLA_RLS_DISPOSABLE).href;
const session: Session = {userId: USERS.admin,sessionId:"",email:"",name:"Synthetic",kind:"staff",role:"admin",
  orgId:ORG_ID,liveOrgId:ORG_ID,environment:"live",locale:"zh-TW",calendar:"gregorian",leaseId:null};

test("server selects regional profile on each operation and rejects mismatched targets without writes", async () => {
  const db = new Client({connectionString:url});
  await db.connect();
  const oldEnv = process.env.IMPORT_ERROR_DETAILS_ENABLED;
  const suffix = randomUUID().slice(0,8);
  const name = `region-${suffix}`;
  const badName = `region-blocked-${suffix}`;
  let propertyId = "";
  let legacyPropertyId = "";
  let managerSessionId = "";
  const org = (await db.query(`SELECT country_code,jurisdiction_id,default_currency,timezone,feature_flags FROM organizations WHERE id=$1`,[ORG_ID])).rows[0];
  try {
    session.sessionId=await insertTestAuthSession(db,USERS.admin);
    managerSessionId=await insertTestAuthSession(db,USERS.manager);
    process.env.IMPORT_ERROR_DETAILS_ENABLED = "true";
    const jurisdictions = await db.query<{id:string;code:string}>(`SELECT id::text,code FROM jurisdictions WHERE code IN ('TW','US-CA')`);
    const tw = jurisdictions.rows.find(r => r.code === "TW")!.id;
    const ca = jurisdictions.rows.find(r => r.code === "US-CA")!.id;
    await db.query(`UPDATE organizations SET country_code='TW',jurisdiction_id=$2,default_currency='TWD',timezone='America/Los_Angeles',
      feature_flags=feature_flags || '{"import_error_details":true}'::jsonb WHERE id=$1`,[ORG_ID,tw]);
    const profile = await tx(USERS.admin,c => loadImportRegion(c,ORG_ID),{orgId:ORG_ID,environment:"live"});
    assert.equal(profile?.timezone,"America/Los_Angeles");
    assert.equal(profile?.today,new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()));
    assert.equal((await tx(USERS.manager,c => loadImportRegion(c,ORG_ID),{orgId:ORG_ID,environment:"live"}))?.jurisdictionId,tw);
    await db.query("UPDATE organizations SET jurisdiction_id=NULL WHERE id=$1",[ORG_ID]);
    assert.equal((await tx(USERS.admin,c => loadImportRegion(c,ORG_ID),{orgId:ORG_ID,environment:"live"}))?.jurisdictionId,tw);
    await db.query("UPDATE organizations SET jurisdiction_id=$2 WHERE id=$1",[ORG_ID,tw]);
    const row = {line:7,propertyName:name,address:`台北測試路${suffix}號`,ownerName:"測試屋主",ownerEmail:"",
      rentalMode:"整層",unitLabel:"5F",roomLabel:"",roomType:"",area:"12",rent:"10000",tenantName:"測試租客",
      tenantPhone:"0912777555",tenantEmail:"",startDate:"2027-11-01",endDate:"2028-10-31",deposit:"20000",
      dueDay:"5",electricity:"",rate:"",billKwh:"",billAmount:"",opening:"",depositReason:"",rateReason:"",notes:""};
    const body = await readImportBody(new Request("http://localhost/import",{method:"POST",body:JSON.stringify({
      mode:"preview",fileName:"synthetic.csv",rows:[row],region:{country:"US",currency:"USD",timezone:"UTC"}})}));
    assert.deepEqual(Object.keys(body).sort(),["fileName","mode","rows"]);
    assert.equal((await previewImport(session,body)).length,0);
    assert.equal((await dryRunImport(session,body)).created.leases,1);
    const manager: Session = {...session,sessionId:managerSessionId,userId:USERS.manager,role:"manager"};
    assert.equal((await previewImport(manager,body)).length,0);
    assert.equal((await dryRunImport(manager,body)).created.leases,1);
    const created = await commitImportBatch(manager,body);
    assert.equal(created.created.properties,1);
    assert.equal(created.created.leases,1);
    const actual = (await db.query<{id:string;country_code:string;jurisdiction_id:string;currency:string;timezone:string;lease_currency:string}>(
      `SELECT p.id::text,p.country_code,p.jurisdiction_id::text,p.currency,p.timezone,l.currency AS lease_currency
         FROM properties p JOIN leases l ON l.property_id=p.id WHERE p.org_id=$1 AND p.name=$2`,[ORG_ID,name])).rows[0];
    propertyId = actual.id;
    assert.deepEqual([actual.country_code,actual.jurisdiction_id,actual.currency,actual.timezone,actual.lease_currency],
      ["TW",tw,"TWD","America/Los_Angeles","TWD"]);
    const existing = {...row,line:19,unitLabel:"6F",tenantPhone:"0912777556"};
    for (const changes of [
      {country:"US",jurisdiction:tw,currency:"TWD",timezone:"America/Los_Angeles"},
      {country:"TW",jurisdiction:ca,currency:"TWD",timezone:"America/Los_Angeles"},
      {country:"TW",jurisdiction:tw,currency:"USD",timezone:"America/Los_Angeles"},
      {country:"TW",jurisdiction:tw,currency:"TWD",timezone:"Asia/Taipei"},
    ]) {
      await db.query("UPDATE properties SET country_code=$2,jurisdiction_id=$3,currency=$4,timezone=$5 WHERE id=$1",
        [propertyId,changes.country,changes.jurisdiction,changes.currency,changes.timezone]);
      const before = (await db.query("SELECT country_code,jurisdiction_id,currency,timezone FROM properties WHERE id=$1",[propertyId])).rows[0];
      for (const mode of [previewImport,dryRunImport,commitImportBatch]) {
        const result = await mode(manager,{fileName:"conflict.csv",rows:[existing]});
        const issues = Array.isArray(result) ? result : result.errors;
        assert.ok(issues.some(issue => issue.key === "im_region_conflict" && issue.line === 19));
      }
      assert.deepEqual((await db.query("SELECT country_code,jurisdiction_id,currency,timezone FROM properties WHERE id=$1",[propertyId])).rows[0],before);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM leases WHERE property_id=$1",[propertyId])).rows[0].n,1);
    }
    for (const [country,jurisdiction,currency] of [["US",ca,"USD"],["TW",ca,"TWD"],["TW",tw,"USD"],["ZZ",null,"TWD"]] as const) {
      await db.query("UPDATE organizations SET country_code=$2,jurisdiction_id=$3,default_currency=$4 WHERE id=$1",[ORG_ID,country,jurisdiction,currency]);
      for (const mode of [previewImport,dryRunImport,commitImportBatch])
        await assert.rejects(mode(session,{fileName:"blocked.csv",rows:[{...row,propertyName:badName}]}),/im_region_unavailable/);
      assert.deepEqual(await previewImport(session,{fileName:"empty.csv",rows:[]}),[]);
      assert.equal((await dryRunImport(session,{fileName:"empty.csv",rows:[]})).created.leases,0);
      assert.equal((await commitImportBatch(session,{fileName:"empty.csv",rows:[]})).created.leases,0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM properties WHERE org_id=$1 AND name=$2",[ORG_ID,badName])).rows[0].n,0);
    }
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"import_error_details":false}'::jsonb WHERE id=$1`,[ORG_ID]);
    assert.equal(await tx(USERS.admin,c => loadImportRegion(c,ORG_ID),{orgId:ORG_ID,environment:"live"}),null);
    await assert.doesNotReject(previewImport(session,{fileName:"legacy.csv",rows:[{...row,propertyName:badName}]}));
    const legacy = await commitImportBatch(session,{fileName:"legacy.csv",rows:[{...row,propertyName:badName,address:`台北舊路${suffix}號`,tenantPhone:"0912777557"}]});
    assert.equal(legacy.created.leases,1);
    const oldProperty = (await db.query<{id:string;country_code:string;currency:string;timezone:string}>(`SELECT id::text,country_code,currency,timezone
      FROM properties WHERE org_id=$1 AND name=$2`,[ORG_ID,badName])).rows[0];
    legacyPropertyId=oldProperty.id;
    assert.deepEqual([oldProperty.country_code,oldProperty.currency,oldProperty.timezone],["TW","TWD","Asia/Taipei"]);
    await db.query(`UPDATE organizations SET feature_flags=feature_flags || '{"import_error_details":true}'::jsonb WHERE id=$1`,[ORG_ID]);
    process.env.IMPORT_ERROR_DETAILS_ENABLED = "false";
    assert.equal(await tx(USERS.admin,c => loadImportRegion(c,ORG_ID),{orgId:ORG_ID,environment:"live"}),null);
    await assert.doesNotReject(previewImport(session,{fileName:"legacy-global.csv",rows:[]}));
  } finally {
    for(const id of [session.sessionId,managerSessionId])if(id)await db.query(`DELETE FROM auth_sessions WHERE id=$1::uuid`,[id]);
    if (oldEnv === undefined) delete process.env.IMPORT_ERROR_DETAILS_ENABLED; else process.env.IMPORT_ERROR_DETAILS_ENABLED=oldEnv;
    if (propertyId) { await db.query("DELETE FROM leases WHERE property_id=$1",[propertyId]); await db.query("DELETE FROM properties WHERE id=$1",[propertyId]); }
    if (legacyPropertyId) { await db.query("DELETE FROM leases WHERE property_id=$1",[legacyPropertyId]); await db.query("DELETE FROM properties WHERE id=$1",[legacyPropertyId]); }
    await db.query("UPDATE organizations SET country_code=$2,jurisdiction_id=$3,default_currency=$4,timezone=$5,feature_flags=$6 WHERE id=$1",
      [ORG_ID,org.country_code,org.jurisdiction_id,org.default_currency,org.timezone,org.feature_flags]);
    await db.end();
  }
});
