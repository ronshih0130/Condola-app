import assert from 'node:assert/strict';
import test from 'node:test';
import { parseStaffDisplayName,staffProfileVersion,validStaffProfileVersion } from './staff-profile-rules';

test('display names reject blank, controls and oversized input without changing ordinary names',()=>{
 assert.equal(parseStaffDisplayName('  王小美  '),'王小美');assert.equal(parseStaffDisplayName('Jamie Lin'),'Jamie Lin');
 for(const value of ['', '   ', 'A\nB', 'A\u0000B', 'a'.repeat(101), null, ['Jamie']])assert.equal(parseStaffDisplayName(value),null);
 assert.equal(parseStaffDisplayName('a'.repeat(100)),'a'.repeat(100));
});
test('version binds the existing row to the authenticated actor and scope',()=>{
 const scope={userId:'user',orgId:'org',liveOrgId:'org',sessionId:'session',environment:'live' as const};
 const value=staffProfileVersion(scope,'2026-01-01T00:00:00.000001Z','Name');assert.equal(validStaffProfileVersion(value),true);
 for(const changed of [{...scope,userId:'other'},{...scope,orgId:'other'},{...scope,sessionId:'other'},{...scope,environment:'sandbox' as const}])assert.notEqual(staffProfileVersion(changed,'2026-01-01T00:00:00.000001Z','Name'),value);
 assert.notEqual(staffProfileVersion(scope,'2026-01-01T00:00:00.000002Z','Name'),value);assert.notEqual(staffProfileVersion(scope,'2026-01-01T00:00:00.000001Z','Other'),value);assert.equal(validStaffProfileVersion('bad'),false);
});

test('account page never accepts a success claim from the query string',async()=>{
 const {readFileSync}=await import('node:fs');const page=readFileSync(new URL('../app/m/account/page.tsx',import.meta.url),'utf8');const action=readFileSync(new URL('./staff-profile-actions.ts',import.meta.url),'utf8');
 assert.ok(page.includes("['stale','invalid','unavailable']"));assert.ok(!page.includes("['updated','unchanged','stale'"));assert.ok(action.includes("if(result==='updated'||result==='unchanged')redirect('/m/account')"));
});
