import test from 'node:test';
import assert from 'node:assert/strict';
import { isArchiveCommand, isArchiveRef, sameArchiveScope } from './record-archive';

const actor='12345678-1234-4234-8234-123456789abc';
const org='23456789-1234-4234-8234-123456789abc';
const ref={kind:'room' as const,id:'3456789a-1234-4234-8234-123456789abc'};
const scope={actorId:actor,orgId:org,liveOrgId:org,environment:'live' as const};
const command={ref,desired:'archived' as const,expectedVersion:'a'.repeat(64),renderedScope:scope,reason:'Ended tenancy',requestId:actor};

test('archive commands require a concrete target, scope, original version and meaningful bounded reason',()=>{
  assert.equal(isArchiveCommand(command),true);
  for(const invalid of [
    {...command,ref:{...ref,kind:'contact'}}, {...command,ref:{...ref,id:'no'}},
    {...command,reason:'  \n\t'}, {...command,reason:'x'.repeat(501)},
    {...command,expectedVersion:'a'.repeat(63)}, {...command,requestId:'not-a-uuid'},
    {...command,renderedScope:{...scope,environment:'other'}},
  ]) assert.equal(isArchiveCommand(invalid),false);
  assert.equal(isArchiveRef(null),false);
});

test('rendered scope changes invalidate an old tab even for the same target',()=>{
  assert.equal(sameArchiveScope(scope,{...scope,actorId:actor.toUpperCase()}),true);
  assert.equal(sameArchiveScope(scope,{...scope,actorId:ref.id}),false);
  assert.equal(sameArchiveScope(scope,{...scope,orgId:ref.id}),false);
  assert.equal(sameArchiveScope(scope,{...scope,environment:'sandbox'}),false);
  assert.equal(sameArchiveScope(scope,{}),false);
});
