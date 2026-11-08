import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createHash } from "node:crypto";
import boundaries from "./b017-non-feature-boundaries.json";
import permissions from "./b017-entry-permissions.json";
import { PERMS } from "./perms";

const walk = (dir: string): string[] => readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const files=walk("src").filter(f=>/\.tsx?$/.test(f)&&! /\.(test|spec)\./.test(f));
const config=ts.readConfigFile("tsconfig.json",ts.sys.readFile);
const options=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd()).options;
const program=ts.createProgram(files,options),checker=program.getTypeChecker();
function nodes(node:ts.Node):ts.Node[]{const all:ts.Node[]=[];function visit(n:ts.Node){all.push(n);ts.forEachChild(n,visit);}visit(node);return all;}
function declaration(call:ts.CallExpression) {
  let symbol=checker.getSymbolAtLocation(call.expression);if(symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol=checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration;
}
function idOf(node:ts.Node) {
  const named=node as ts.FunctionDeclaration;
  return `${path.relative(process.cwd(),node.getSourceFile().fileName)}#${named.name?.getText() ?? (ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : 'default')}`;
}
function separateBoundary(file: string, name: string, fn: ts.Node) {
  const boundary = (boundaries as Record<string,{reason:string;sha256:string}>)[`${file}#${name}`];
  if (!boundary) return false;
  assert.ok(boundary.reason.length > 10);
  assert.equal(createHash("sha256").update(fn.getText()).digest("hex"),boundary.sha256,`${file}#${name}: review changed non-feature boundary`);
  return true;
}
const guardNames = new Set(['guardEffectiveSession','requireEffectivePerm','assertCustomAuthorityOn','withEffectiveReadAuthority']);
// These establish identity/consent, not business-data authority. Their own implementations
// remain separately inventoried. No arbitrary helper is excluded by name alone.
const bootstrap = new Set(['src/server/session.ts#getSession','src/server/session.ts#readSession','src/server/session.ts#readSessionOn',
  'src/server/consent-gate.ts#requireCurrentConsent','src/server/consent-gate.ts#requireApiConsent']);
// `opaque`: a call written in a route file whose project target the scanner cannot traverse
// (object-literal handler, class method, callback parameter, factory result). A route with one
// needs a mapped guard (entry-permissions, verified above) or an inventoried classification.
type State = { keys:Set<string>; violations:string[]; db:boolean; guards:Set<string>; opaque:string[] };
function inspect(fn:ts.Node, expected?:string|null, resolve:(call:ts.CallExpression)=>ts.Node|undefined=declaration):State {
  const state:State={keys:new Set(),violations:[],db:false,guards:new Set(),opaque:[]};
  const active=new Set<ts.Node>();
  function visit(n:ts.Node,s:State) {
    if(ts.isFunctionLike(n) && n!==fn) return; // Definitions do not execute at declaration time.
    if(ts.isIfStatement(n)) {
      visit(n.expression,s);
      const yes={...s,keys:new Set(s.keys)},no={...s,keys:new Set(s.keys)};
      visit(n.thenStatement,yes);if(n.elseStatement)visit(n.elseStatement,no);
      s.db ||= yes.db || no.db;
      s.keys=new Set([...yes.keys].filter(k=>no.keys.has(k)));return;
    }
    if(ts.isForStatement(n)||ts.isForOfStatement(n)||ts.isForInStatement(n)||ts.isWhileStatement(n)||ts.isDoStatement(n)) {
      ts.forEachChild(n,c=>visit(c,{...s,keys:new Set(s.keys)}));return;
    }
    if(ts.isTryStatement(n)) {
      const yes={...s,keys:new Set(s.keys)},no={...s,keys:new Set(s.keys)};
      visit(n.tryBlock,yes);if(n.catchClause)visit(n.catchClause.block,no);
      s.keys=n.catchClause?new Set([...yes.keys].filter(k=>no.keys.has(k))):yes.keys;
      if(n.finallyBlock)visit(n.finallyBlock,s);return;
    }
    if(ts.isCallExpression(n)) {
      if(n.expression.getText()==='Promise.all' || n.expression.getText()==='Promise.allSettled') {
        for(const arg of n.arguments) if(ts.isArrayLiteralExpression(arg)) for(const item of arg.elements)visit(item,{...s,keys:new Set(s.keys)});
        return;
      }
      // JS evaluates argument expressions before invoking a guard/helper.
      for(const arg of n.arguments) if(!ts.isFunctionLike(arg)) visit(arg,s);
      const target=resolve(n),id=target?idOf(target):'';
      const name=n.expression.getText();
      if(bootstrap.has(id))return;
      if(target && target.getSourceFile().fileName.endsWith('/b017-custom-role-governance.ts') && guardNames.has(name)) {
        const arg=n.arguments[name==='guardEffectiveSession'?1:2];
        const key=arg?.kind===ts.SyntaxKind.NullKeyword?'null':arg&&ts.isStringLiteral(arg)?arg.text:undefined;
        if(key){s.keys.add(key);s.guards.add(key);}
        for(const arg of n.arguments) if(ts.isArrowFunction(arg)||ts.isFunctionExpression(arg))visit(arg.body,s);
        return;
      }
      const dbCall=(target && /\/db\.ts$/.test(target.getSourceFile().fileName) && ['tx','svc','withClient','svcOn','query','many','one','maybe','withDeferredClient'].includes(name)) || /\.query$/.test(name);
      if(dbCall) {
        s.db=true;
        if(!s.keys.size || (expected!==undefined && !s.keys.has(String(expected))))s.violations.push(`${name}@${n.getSourceFile().fileName}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line+1}`);
        return;
      }
      const traversable=!!target&&((ts.isFunctionDeclaration(target)&&!!target.body)||(ts.isVariableDeclaration(target)&&!!target.initializer&&(ts.isArrowFunction(target.initializer)||ts.isFunctionExpression(target.initializer))));
      if(target && !traversable && !ts.isFunctionDeclaration(target) && !ts.isPropertySignature(target) && !ts.isMethodSignature(target) && /\/route\.tsx?$/.test(n.getSourceFile().fileName) && !/node_modules|\.d\.ts$/.test(target.getSourceFile().fileName))
        s.opaque.push(`${name}@${n.getSourceFile().fileName}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line+1}`);
      if(target && !target.getSourceFile().fileName.includes('node_modules') && !active.has(target)) {
        if(ts.isFunctionDeclaration(target)&&target.body) {
          const [file,nm]=id.split('#');
          if(separateBoundary(file,nm,target) && !(boundaries as Record<string,{reason:string}>)[id].reason.startsWith('Internal:'))return;
          active.add(target);visit(target.body,s);active.delete(target);
        } else if(ts.isVariableDeclaration(target)&&target.initializer&&(ts.isArrowFunction(target.initializer)||ts.isFunctionExpression(target.initializer))) {
          active.add(target);visit(target.initializer.body,s);active.delete(target);
        }
      }
      // Callback bodies may run without a sibling callback or a later guard.
      for(const arg of n.arguments) if(ts.isArrowFunction(arg)||ts.isFunctionExpression(arg))visit(arg.body,{...s,keys:new Set(s.keys)});
      return;
    }
    if(ts.isConditionalExpression(n)) {
      visit(n.condition,s);visit(n.whenTrue,{...s,keys:new Set(s.keys)});visit(n.whenFalse,{...s,keys:new Set(s.keys)});return;
    }
    ts.forEachChild(n,c=>visit(c,s));
  }
  active.add(fn);
  if(ts.isFunctionDeclaration(fn)&&fn.body)visit(fn.body,state);
  else if(ts.isVariableDeclaration(fn)&&fn.initializer&&(ts.isArrowFunction(fn.initializer)||ts.isFunctionExpression(fn.initializer)))visit(fn.initializer.body,state);
  else if(ts.isArrowFunction(fn)||ts.isFunctionExpression(fn))visit(fn.body,state);
  return state;
}

test('B017 mapped guards precede the first DB call, including null mappings',()=>{
  const failures:string[]=[];
  for(const [id,key] of Object.entries(permissions)) {
    const [file,name]=id.split('#'),source=program.getSourceFile(file);assert.ok(source,id);
    const fn=source.statements.find(n=>(ts.isFunctionDeclaration(n)||ts.isVariableStatement(n))&&nodes(n).some(x=>ts.isIdentifier(x)&&x.text===name));assert.ok(fn,id);
    if(separateBoundary(file,name,fn))continue;
    const result=inspect(fn,key);
    if(result.violations.length || !result.guards.has(String(key)))failures.push(`${id} [${key}]: ${result.violations.slice(0,3).join(', ') || 'missing matching guard'}`);
  }
  assert.deepEqual(failures,[]);
});

test('B017 every server module, TS/TSX route, page, layout and inline server action is scanned',()=>{
  const failures:string[]=[];
  for(const file of files) {
    const source=program.getSourceFile(file)!;
    if(source.statements.some(n=>ts.isExpressionStatement(n)&&ts.isStringLiteral(n.expression)&&n.expression.text==='use client'))continue;
    const isEntry=/\/(page|layout|route)\.tsx?$/.test(file)||source.statements.some(n=>ts.isExpressionStatement(n)&&ts.isStringLiteral(n.expression)&&n.expression.text==='use server');
    for(const fn of nodes(source).filter((n):n is ts.FunctionDeclaration|ts.ArrowFunction|ts.FunctionExpression=>ts.isFunctionDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n))) {
      const inline=!!fn.body&&nodes(fn.body).some(n=>ts.isExpressionStatement(n)&&ts.isStringLiteral(n.expression)&&n.expression.text==='use server');
      const variable=ts.isVariableDeclaration(fn.parent)?fn.parent:undefined;
      const exported=ts.isFunctionDeclaration(fn)?fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)
        : variable&&ts.isVariableStatement(variable.parent.parent)&&variable.parent.parent.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
      const session=fn.parameters.some(p=>p.type?.getText().includes('Session'));
      if(!inline && !(exported && (isEntry || ((file.startsWith('src/server/') || file.startsWith('src/components/')) && session))))continue;
      if(file==='src/server/b017-custom-role-governance.ts')continue; // guard implementation; integration tested
      const id=idOf(fn),[f,name]=id.split('#');
      if(separateBoundary(f,name,fn))continue;
      const result=inspect(fn);
      if(result.violations.length)failures.push(`${id}: ${result.violations.slice(0,3).join(', ')}`);
    }
  }
  assert.deepEqual(failures,[]);
});

// A route export the AST walk cannot follow (re-export, factory result, object-literal handler,
// or a function that delegates to one) must carry a reviewed classification in the boundary
// inventory, pinned by the hash of its exporting statement/function. Unlisted ones fail.
const HTTP_METHODS = new Set(['GET','HEAD','POST','PUT','DELETE','PATCH','OPTIONS']);
const ROUTE_CLASSES = new Set(['staff-guarded','portal-self-service','identity-establishment','bearer','webhook']);
type RouteBoundary = { classification?: string; key?: string; reason: string; sha256: string };
function routeExports(source: ts.SourceFile) {
  const out: { name: string; node: ts.Node; fn?: ts.Node }[] = [];
  for (const st of source.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(st) && exported && st.name && HTTP_METHODS.has(st.name.text)) out.push({ name: st.name.text, node: st, fn: st });
    else if (ts.isVariableStatement(st) && exported) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && HTTP_METHODS.has(d.name.text))
        out.push({ name: d.name.text, node: st, fn: d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : undefined });
    } else if (ts.isExportDeclaration(st)) {
      if (!st.exportClause) out.push({ name: '*', node: st });
      else if (ts.isNamedExports(st.exportClause)) for (const e of st.exportClause.elements) if (HTTP_METHODS.has(e.name.text)) out.push({ name: e.name.text, node: st });
    } else if (ts.isExportAssignment(st)) out.push({ name: 'default', node: st });
  }
  return out;
}
test('B017 every route export is scanned or carries an inventoried classification',()=>{
  const failures:string[]=[], seen=new Set<string>();
  for(const file of files.filter(f=>/\/route\.tsx?$/.test(f))) {
    const source=program.getSourceFile(file)!;
    for(const entry of routeExports(source)) {
      const id=`${file}#${entry.name}`, listed=(boundaries as Record<string,RouteBoundary>)[id];
      const opaque=entry.fn?inspect(entry.fn).opaque:[];
      const classified=!!listed?.classification;
      if(classified) {
        seen.add(id);
        if(!ROUTE_CLASSES.has(listed.classification!)) failures.push(`${id}: unknown classification ${listed.classification}`);
        if(listed.classification==='staff-guarded' && !PERMS.some(p=>p[0]===listed.key)) failures.push(`${id}: staff-guarded needs a permission key`);
        if(listed.classification!=='staff-guarded' && listed.key) failures.push(`${id}: only staff-guarded entries carry a key`);
        if(!(listed.reason.length>10)) failures.push(`${id}: reason required`);
        if(createHash("sha256").update(entry.node.getText()).digest("hex")!==listed.sha256) failures.push(`${id}: review changed route classification`);
      } else if(!entry.fn) failures.push(`${id}: route export is not a function the scanner can classify; add a classification`);
      else if(opaque.length && !(id in permissions)) failures.push(`${id}: delegates to an untraceable handler (${opaque.slice(0,2).join(', ')}); add a classification`);
    }
  }
  for(const [id,b] of Object.entries(boundaries as Record<string,RouteBoundary>)) if(b.classification && !seen.has(id)) failures.push(`${id}: stale route classification`);
  assert.deepEqual(failures,[]);
});

// Token-authenticated LINE handlers receive no Session, so the Session-parameter scan cannot see
// them. Any LINE function that admits staff by native org role must also apply a B017 key.
test('B017 LINE staff-role admission is paired with an effective-authority guard',()=>{
  const failures:string[]=[];
  const line=files.filter(f=>f.startsWith('src/server/line/')||f.startsWith('src/app/api/line/')||f.startsWith('src/app/(line)/'));
  assert.ok(line.length>=17);
  for(const file of line) for(const fn of nodes(program.getSourceFile(file)!).filter(n=>ts.isFunctionDeclaration(n)&&n.body)) {
    const staff=nodes(fn).some(n=>(ts.isNoSubstitutionTemplateLiteral(n)||ts.isStringLiteral(n)||ts.isTemplateHead(n)||ts.isTemplateMiddle(n)||ts.isTemplateTail(n))
      && /org_members[\s\S]*\brole\s+(IN|=|::)/i.test(n.text));
    if(!staff) continue;
    const guarded=nodes(fn).some(n=>ts.isCallExpression(n)&&['requireEffectivePerm','assertCustomAuthorityOn','withEffectiveAuthority','guardEffectiveSession'].includes(n.expression.getText())
      && n.arguments.some(a=>ts.isStringLiteral(a)&&/^[a-z]+\.[a-z]+$/.test(a.text)));
    if(!guarded) failures.push(`${idOf(fn)}: native staff role admits without a B017 key`);
  }
  assert.deepEqual(failures,[]);
});

test('R4 LINE staff unlink re-checks tenants.contact inside its transaction before writing',()=>{
  assert.deepEqual((boundaries as Record<string,RouteBoundary>)['src/app/api/line/links/[id]/route.ts#DELETE']?.classification,'staff-guarded');
  assert.equal((boundaries as Record<string,RouteBoundary>)['src/app/api/line/links/[id]/route.ts#DELETE']?.key,'tenants.contact');
  const unlink=program.getSourceFile('src/server/line/login-link.ts')!.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='unlinkLine')!.getText();
  const guard=unlink.indexOf('await requireEffectivePerm(c,');
  assert.ok(guard>0 && unlink.slice(guard,unlink.indexOf('\n',guard)).includes('"tenants.contact"'));
  assert.ok(unlink.indexOf('FOR UPDATE')<guard && guard<unlink.indexOf('UPDATE line_account_links'));
  assert.ok(unlink.lastIndexOf('lineTransaction(',guard)>=0);
});

test('R4 merged readers and the resend settle re-check their key inside the transaction',()=>{
  const body=(file:string,name:string)=>program.getSourceFile(file)!.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)!.getText();
  for(const [file,name,open,key] of [
    ['src/server/recipient-channels.ts','recipientChannelPlan','tx(session.userId, async (client) => withEffectiveAuthority(client, session,','"tenants.contact"'],
    ['src/server/vendor-document-invites.ts','vendorDocumentInvitesView','svc(session.userId, async (client) => withEffectiveAuthority(client, session,',"'tickets.update'"],
    ['src/server/portal-resend.ts','portalResendControl','tx(session.userId, async client => withEffectiveAuthority(client, session,','"leases.edit"'],
    ['src/server/portal-resend.ts','resendPortalInvite','const settle = (outcome: unknown) => tx(session.userId, async client => withEffectiveAuthority(client, session,','"leases.edit"'],
  ]) { const text=body(file,name),at=text.indexOf(open); assert.ok(at>0,`${name}: in-transaction re-check`); assert.ok(text.slice(at+open.length).trimStart().startsWith(key),`${name}: key`); }
});

test('R4 upload-recovery batch transactions fence staff photo authority before business SQL',()=>{
  const source=program.getSourceFile('src/server/upload-recovery.ts')!;
  const body=(name:string)=>source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name)!.getText();
  const batch=body('batchTx'),fence=batch.indexOf('await assertCustomAuthorityOn(client, session, "tickets.update", true);');
  assert.ok(batch.indexOf('withEffectiveAuthority(client, session, "tickets.update",')>0 && fence>0 && fence<batch.indexOf('return fn(client);'));
  assert.match(body('assertActor'),/session\.customRole && !canTicketPhotos\(session\)/);
  for(const name of ['ticketPhotoRecovery','prepareBatchPhoto','confirmBatchPhoto','submitBatchPhotos','discardBatchPhotos']) {
    const text=body(name),guard=text.indexOf('session = await guardEffectiveSession(session, "tickets.update");');
    assert.ok(guard>0 && guard<text.indexOf('assertActor('),name);
  }
});

// Independent semantic oracle: changing both the implementation and its inventory
// must not bless a settings-only key for a lease operation.
test('R4 deposit-policy key matches its native lease permission',()=>{
  assert.equal(permissions['src/server/deposit-rules-actions.ts#actionDepositPolicy'],'leases.edit');
  const source=program.getSourceFile('src/server/deposit-rules-actions.ts')!;
  assert.match(source.text,/guardEffectiveSession\(await getSession\(\), "leases.edit"\)/);
  assert.match(source.text,/can\(session, "leases.edit"\)/);
});

import { customAuthorityAllowsOn } from "./b017-custom-role-governance";
import { assertStaff, type Session } from "./types";
import type { Client } from "pg";
const native: Session={userId:"u",sessionId:"s",orgId:"o",liveOrgId:"o",environment:"live",kind:"staff",role:"manager",locale:"en",calendar:"gregorian",leaseId:null,name:"Fixture",email:"fixture@example.invalid"};
const cached: Session={...native,customRole:{orgId:"o",userId:"u",sessionId:"s",nativeRole:"manager",keys:["bank.reconcile"],photos:false,audit:false}};
test("R3 in-memory reader regression: durable OFF evaluates current native authority",async()=>{
  let role="manager";const calls:string[]=[];
  const client={async query(sql:string){calls.push(sql);if(sql.includes('current_user'))return {rows:[{role:'authenticated'}]};if(sql.includes('b017_resolve'))return {rows:[{authority:{enabled:false,nativeRole:role,keys:role==='accountant'?['bank.reconcile']:['props.view']}}]};return {rows:[]};}} as unknown as Client;
  assert.equal(await customAuthorityAllowsOn(client,cached,"bank.reconcile"),false);
  role="accountant";assert.equal(await customAuthorityAllowsOn(client,cached,"bank.reconcile"),true);
  assert.ok(calls.includes('SET LOCAL ROLE authenticated'));
});
test("R3 native staff checks require an explicit mapped key for a restricted assignment",()=>{
  const restricted={...cached,customRole:{...cached.customRole!,keys:[]}};
  assert.throws(()=>assertStaff(restricted,['manager']),/forbidden/);
  assert.throws(()=>assertStaff(restricted,['manager'],'leases.edit'),/forbidden/);
  assert.doesNotThrow(()=>assertStaff(native,['manager']));
  assert.doesNotThrow(()=>assertStaff({...restricted,customRole:{...restricted.customRole,keys:['leases.edit']}},['manager'],'leases.edit'));
});

test('R4 inventory rejects late, conditional, wrong/null, indirect and callback-only guards',()=>{
  function fixture(body:string, expected:string|null='props.view') {
    const source=ts.createSourceFile('src/app/example/page.tsx',`async function helper(){await db.query('SELECT secret')} export async function Page(){${body}}`,ts.ScriptTarget.Latest,true);
    const fn=source.statements[1];
    const resolve=(call:ts.CallExpression)=>call.expression.getText()==='guardEffectiveSession'
      ? program.getSourceFile('src/server/b017-custom-role-governance.ts')!.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='guardEffectiveSession')
      : call.expression.getText()==='helper'?source.statements[0]:undefined;
    return inspect(fn,expected,resolve);
  }
  assert.equal(fixture(`await guardEffectiveSession(s,'props.view'); await helper();`).violations.length,0);
  for(const body of [
    `await helper(); await guardEffectiveSession(s,'props.view');`,
    `if (condition) await guardEffectiveSession(s,'props.view'); await helper();`,
    `const later=()=>guardEffectiveSession(s,'props.view'); await helper();`,
    `await guardEffectiveSession(s,'settings.edit'); await helper();`,
    `for(const x of xs) await guardEffectiveSession(s,'props.view'); await helper();`,
    `try {await guardEffectiveSession(s,'props.view')} catch {} await helper();`,
    `await Promise.all([guardEffectiveSession(s,'props.view'),helper()]);`,
  ])assert.ok(fixture(body).violations.length,body);
  assert.ok(fixture(`await guardEffectiveSession(s,'props.view'); await helper();`,null).violations.length);
  assert.equal(fixture(`await guardEffectiveSession(s,null); await helper();`,null).violations.length,0);
});

test('R4 reviewed dynamic dispatcher and photo callback retain ordering and semantic keys',()=>{
  const flow=program.getSourceFile('src/app/api/flows/[action]/route.ts')!.text;
  const expected={createProperty:'props.edit',createLease:'leases.edit',updateLease:'leases.edit',simulateTenantSignature:'leases.edit',signLease:'leases.edit',recordPayment:'pay.record',confirmPayment:'pay.record',rejectPayment:'pay.record',importBankCsv:'bank.reconcile',approveMatch:'bank.reconcile',generateStatement:'stmt.generate',createTicket:'tickets.update',updateTicket:'tickets.update',postMessage:'messages.send',inviteTeammate:'team.manage',setOwnerPhoneVisibility:'settings.edit'};
  for(const [op,key] of Object.entries(expected)) assert.match(flow,new RegExp(`${op}:\\s*"${key.replace('.','\\.')}"`));
  assert.ok(flow.indexOf('await guardEffectiveSession')<flow.indexOf('await handler('));
  const photo=program.getSourceFile('src/server/id-docs.ts')!.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='serveSignedPhoto')!.getText();
  assert.ok(photo.indexOf('await authorize?.(client)')<photo.indexOf('await client.query'));
});

import { customRolesAdmitted, assertCustomRoleAdmission } from './b017-admission';
test('R4 malformed allowlist entry cannot disable another admitted organization; missing admission denies',()=>{
  const previous=process.env.CUSTOM_ROLES_ORG_ALLOWLIST;
  const org='00000000-0000-4000-8000-000000000001';
  try {
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST=JSON.stringify([org,'bad-id',null]);
    assert.equal(customRolesAdmitted(org),true);
    assert.doesNotThrow(()=>assertCustomRoleAdmission(org,true));
    process.env.CUSTOM_ROLES_ORG_ALLOWLIST='[]';
    assert.throws(()=>assertCustomRoleAdmission(org,true),/forbidden/);
    assert.doesNotThrow(()=>assertCustomRoleAdmission(org,false));
  } finally {if(previous===undefined)delete process.env.CUSTOM_ROLES_ORG_ALLOWLIST;else process.env.CUSTOM_ROLES_ORG_ALLOWLIST=previous;}
});
