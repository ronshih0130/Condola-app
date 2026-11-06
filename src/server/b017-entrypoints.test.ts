import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createHash } from "node:crypto";
import boundaries from "./b017-non-feature-boundaries.json";
import permissions from "./b017-entry-permissions.json";

const walk = (dir: string): string[] => readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const files=walk("src").filter(f=>/\.tsx?$/.test(f)&&! /\.(test|spec)\./.test(f));
const config=ts.readConfigFile("tsconfig.json",ts.sys.readFile);
const options=ts.parseJsonConfigFileContent(config.config,ts.sys,process.cwd()).options;
const program=ts.createProgram(files,options),checker=program.getTypeChecker();
const guards=new Set(["guardEffectiveSession","requireEffectivePerm","assertCustomAuthorityOn","customAuthorityAllowsOn","withEffectiveAuthority"]);
function nodes(node:ts.Node):ts.Node[]{const all:ts.Node[]=[];function visit(n:ts.Node){all.push(n);ts.forEachChild(n,visit);}visit(node);return all;}
function declaration(call:ts.CallExpression) {
  let symbol=checker.getSymbolAtLocation(call.expression);if(symbol?.flags && symbol.flags & ts.SymbolFlags.Alias) symbol=checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration;
}
function separateBoundary(file: string, name: string, fn: ts.Node) {
  const boundary = (boundaries as Record<string,{reason:string;sha256:string}>)[`${file}#${name}`];
  if (!boundary) return false;
  assert.ok(boundary.reason.length > 10);
  assert.equal(createHash("sha256").update(fn.getText()).digest("hex"),boundary.sha256,`${file}#${name}: review changed non-feature boundary`);
  return true;
}
function guarded(node:ts.Node,seen=new Set<ts.Node>(), key?: string | null):boolean {
  if(seen.has(node))return false;seen.add(node);
  return nodes(node).filter(ts.isCallExpression).some(call=>{
    const target=declaration(call);if(!target)return false;
    if(target.getSourceFile().fileName.endsWith("/b017-custom-role-governance.ts")&&guards.has(call.expression.getText())) {
      const argument=call.arguments[call.expression.getText()==="guardEffectiveSession"?1:2];
      return key===undefined || (key===null ? argument?.kind===ts.SyntaxKind.NullKeyword : !!argument && ts.isStringLiteral(argument) && argument.text===key);
    }
    if(target.getSourceFile().fileName.includes("node_modules"))return false;
    return (ts.isFunctionDeclaration(target)||ts.isVariableDeclaration(target)||ts.isArrowFunction(target))&&guarded(target,seen,key);
  });
}

test("B017 every mapped exported operation has a central guard; new mappings require explicit review",()=>{
  for(const [id,key] of Object.entries(permissions)) {
    const [file,name]=id.split("#"),source=program.getSourceFile(file);assert.ok(source,id);
    const fn=source.statements.find((n):n is ts.FunctionDeclaration=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(fn,id);
    // Public/token/account entry exclusions are separately exhaustively inventoried below.
    if(key!==null)assert.ok(guarded(fn,new Set(),key),`${id}: mapped key lacks its explicit central guard`);
  }
});

test("B017 enumerate all routes, use-server actions, and their exported Session writers",()=>{
  const missing:string[]=[];
  for(const file of files) {
    const source=program.getSourceFile(file)!;
    const entry=file.endsWith('/route.ts')||source.statements.some(n=>ts.isExpressionStatement(n)&&ts.isStringLiteral(n.expression)&&n.expression.text==='use server');
    if(!entry)continue;
    const moduleSymbol=checker.getSymbolAtLocation(source);if(!moduleSymbol)continue;
    for(const symbol of checker.getExportsOfModule(moduleSymbol)) {
      if(!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(symbol.name)&&file.endsWith('/route.ts'))continue;
      const fn=symbol.valueDeclaration;
      if(!fn && !(symbol.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias))) continue; // type-only exports
      if(!fn||!ts.isFunctionDeclaration(fn)) { missing.push(`${file}#${symbol.name}: review non-function export or re-export`); continue; }
      if(!separateBoundary(file,symbol.name,fn)&&(!Object.hasOwn(permissions,`${file}#${symbol.name}`)||!guarded(fn)))missing.push(`${file}#${symbol.name}`);
    }
  }
  assert.deepEqual(missing,[],"unmapped entry must explicitly deny custom-role staff or declare a non-staff boundary");
});

test("B017 exported transaction writers with a Session cannot omit the central guard",()=>{
  const missing:string[]=[];
  for(const file of files.filter(f=>f.startsWith('src/server/'))) {
    if(['/db.ts','/org-guard.ts','/b017-custom-role-governance.ts','/partner-consent-submit.ts'].some(s=>file.endsWith(s)))continue;
    const source=program.getSourceFile(file)!;
    for(const fn of source.statements.filter(ts.isFunctionDeclaration)) {
      if(!fn.body||!fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)||!fn.parameters.some(p=>p.type?.getText().includes('Session')))continue;
      const calls=nodes(fn.body).filter(ts.isCallExpression);
      if(!calls.some(c=>['tx','svc','withClient','svcOn','txForSession'].includes(c.expression.getText())))continue;
      if(!separateBoundary(file,fn.name!.text,fn)&&!guarded(fn))missing.push(`${file}#${fn.name?.text}`);
    }
  }
  assert.deepEqual(missing,[]);
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
