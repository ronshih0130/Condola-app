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

// Lauren 2c r1/r3 (Codex review FAIL #1 and #2; round 3 approved by Ron, PR-045 a): what the scan reads from a gate
// call must be exactly what runs. So the spec is a plain object literal: only PropertyAssignment with an identifier key
// from the wrapper's known keys; no spread, computed or quoted key, method, accessor or duplicate key. A shorthand is
// allowed only for a data key the scan never treats as code (route `headers`) and never with a default. The code the
// scan inspects (spec.flag, the page, the route handler) must be an inline arrow / function expression written in the
// call: no identifier of any kind, so no binding can be reassigned (=, ++, for…of, for…in, destructuring, …) between
// the scanned declaration and the wrapper call. Anything else is a string reason, which the callers turn into a failure.
const ROUTE_SPEC_KEYS=new Set(['flagKey','flag','tag','headers','sameOrigin']),PAGE_SPEC_KEYS=new Set(['flagKey','flag']);
const SHORTHAND_DATA_KEYS=new Set(['headers']);
type FnNode=ts.ArrowFunction|ts.FunctionExpression;
function literalSpec(spec:ts.Expression,keys:Set<string>):Map<string,ts.PropertyAssignment|ts.ShorthandPropertyAssignment>|string {
  if(!ts.isObjectLiteralExpression(spec))return 'spec is not an inline object literal';
  const out=new Map<string,ts.PropertyAssignment|ts.ShorthandPropertyAssignment>();
  for(const p of spec.properties) {
    if(ts.isSpreadAssignment(p))return `spread in spec (${p.getText()})`;
    if(!ts.isPropertyAssignment(p)&&!ts.isShorthandPropertyAssignment(p))return `method or accessor in spec (${p.name?.getText()})`;
    if(!ts.isIdentifier(p.name))return `computed or quoted spec key (${p.name.getText()})`;
    const key=p.name.text;
    if(!keys.has(key))return `unexpected spec key ${key}`;
    if(out.has(key))return `duplicate spec key ${key}`;
    if(ts.isShorthandPropertyAssignment(p)&&(p.objectAssignmentInitializer||!SHORTHAND_DATA_KEYS.has(key)))return `shorthand spec key ${key}`;
    out.set(key,p);
  }
  return out;
}
/** The node itself when it is an inline arrow / function expression; anything else (identifier, call, cast, …) is not. */
const inlineFn=(n:ts.Node|undefined):FnNode|undefined=>n&&(ts.isArrowFunction(n)||ts.isFunctionExpression(n))?n:undefined;

// Lauren 2b: `export const POST = withFlagGate(spec, handler)` (src/server/flag-gate.ts). The wrapper itself runs only
// consent and session (bootstrap above) and the same-origin check, then spec.flag, then the handler; so the scan
// inspects the inline flag predicate and the inline handler in that order. Anything else stays unclassifiable.
function flagGated(node:ts.Node|undefined,name?:string,typeChecker=checker):{flag:ts.ArrowFunction|ts.FunctionExpression;handler:ts.ArrowFunction|ts.FunctionExpression}|undefined {
  const decl=node&&ts.isVariableStatement(node)?node.declarationList.declarations.find(d=>ts.isIdentifier(d.name)&&(!name||d.name.text===name)):node&&ts.isVariableDeclaration(node)?node:undefined;
  const call=decl?.initializer;
  if(!call||!ts.isCallExpression(call)||!ts.isIdentifier(call.expression)||call.expression.text!=='withFlagGate'||call.arguments.length!==2)return undefined;
  let symbol=typeChecker.getSymbolAtLocation(call.expression);if(symbol&&symbol.flags&ts.SymbolFlags.Alias)symbol=typeChecker.getAliasedSymbol(symbol);
  const target=symbol?.valueDeclaration; // = declaration(call) for the main program
  if(!target||!ts.isFunctionDeclaration(target)||!target.getSourceFile().fileName.endsWith('/server/flag-gate.ts'))return undefined;
  const [spec,handler]=call.arguments;
  // Lauren 2c r1: the flag the scan reads must be the one that runs (no spread, computed or duplicate key can replace it).
  const props=literalSpec(spec,ROUTE_SPEC_KEYS);
  if(typeof props==='string')return undefined;
  const flag=props.get('flag');
  const flagFn=flag&&ts.isPropertyAssignment(flag)?inlineFn(flag.initializer):undefined,handlerFn=inlineFn(handler);
  return flagFn&&handlerFn?{flag:flagFn,handler:handlerFn}:undefined;
}

// Lauren 2c: `export default withPageFlagGate(spec, async (props, session) => …)` (src/server/page-flag-gate.ts). The
// wrapper itself runs only consent and session (bootstrap above), then spec.flag, then the page; the page is an inline
// function inside the call, which the exported-function scan below would skip. So the scan inspects the flag predicate
// and the page in that order. Both must be inline functions written in the call, and the spec must pass literalSpec.
// In an entry file EVERY `export default <expression>` must be such a call (none exists otherwise): anything else is a
// failure with its reason, never a silent skip.
function pageFlagGated(node:ts.Node,typeChecker=checker):{flag:FnNode;page:FnNode}|string|undefined {
  if(!ts.isExportAssignment(node))return undefined;
  const call=node.expression;
  if(!ts.isCallExpression(call))return 'default export expression is not a direct withPageFlagGate(spec, Page) call';
  if(!ts.isIdentifier(call.expression)||call.expression.text!=='withPageFlagGate')return 'default export call is not a direct withPageFlagGate call';
  if(call.arguments.length!==2||call.arguments.some(ts.isSpreadElement))return 'withPageFlagGate takes exactly (spec, Page): no deps, no spread';
  let symbol=typeChecker.getSymbolAtLocation(call.expression);if(symbol&&symbol.flags&ts.SymbolFlags.Alias)symbol=typeChecker.getAliasedSymbol(symbol);
  const target=symbol?.valueDeclaration;
  if(!target||!ts.isFunctionDeclaration(target)||!target.getSourceFile().fileName.endsWith('/server/page-flag-gate.ts'))return 'withPageFlagGate does not resolve to src/server/page-flag-gate.ts';
  const [spec,pageArg]=call.arguments;
  const props=literalSpec(spec,PAGE_SPEC_KEYS);
  if(typeof props==='string')return props;
  const flagKey=props.get('flagKey'),flagProp=props.get('flag');
  if(!flagKey||!ts.isPropertyAssignment(flagKey)||!ts.isStringLiteral(flagKey.initializer))return 'spec.flagKey must be a string literal';
  if(!flagProp)return 'spec.flag is missing';
  const flag=ts.isPropertyAssignment(flagProp)?inlineFn(flagProp.initializer):undefined;
  if(!flag)return 'spec.flag must be an inline function written in the call';
  const page=inlineFn(pageArg);
  if(!page)return 'Page must be an inline function written in the call';
  return {flag,page};
}
function pageGateFailures(source:ts.SourceFile,typeChecker=checker,resolve:(call:ts.CallExpression)=>ts.Node|undefined=declaration):string[] {
  const out:string[]=[],file=path.relative(process.cwd(),source.fileName);
  for(const st of source.statements) { const gated=pageFlagGated(st,typeChecker); if(!gated)continue;
    if(typeof gated==='string'){out.push(`${file}#default: ${gated}`);continue;}
    const violations=[...inspect(gated.flag,undefined,resolve).violations,...inspect(gated.page,undefined,resolve).violations];
    if(violations.length)out.push(`${file}#default: ${violations.slice(0,3).join(', ')}`); }
  return out;
}

test('B017 mapped guards precede the first DB call, including null mappings',()=>{
  const failures:string[]=[];
  for(const [id,key] of Object.entries(permissions)) {
    const [file,name]=id.split('#'),source=program.getSourceFile(file);assert.ok(source,id);
    const fn=source.statements.find(n=>(ts.isFunctionDeclaration(n)||ts.isVariableStatement(n))&&nodes(n).some(x=>ts.isIdentifier(x)&&x.text===name));assert.ok(fn,id);
    if(separateBoundary(file,name,fn))continue;
    const gated=flagGated(fn,name);
    if(gated) {
      const flag=inspect(gated.flag,key),handler=inspect(gated.handler,key),violations=[...flag.violations,...handler.violations];
      if(violations.length || !handler.guards.has(String(key)))failures.push(`${id} [${key}]: ${violations.slice(0,3).join(', ') || 'missing matching guard'}`);
      continue;
    }
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
    // Lauren 2b: a withFlagGate export's flag predicate and handler are arrows inside a call, not exported functions.
    if(isEntry) for(const st of source.statements) if(ts.isVariableStatement(st)&&st.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword))
      for(const d of st.declarationList.declarations) { const gated=flagGated(d); if(!gated)continue;
        const violations=[...inspect(gated.flag).violations,...inspect(gated.handler).violations];
        if(violations.length)failures.push(`${file}#${d.name.getText()}: ${violations.slice(0,3).join(', ')}`); }
    // Lauren 2c: a withPageFlagGate default export's flag predicate and page body; any other default export fails.
    if(isEntry) failures.push(...pageGateFailures(source));
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
      for (const d of st.declarationList.declarations) { const gated = flagGated(d); const entry = out.find(e => e.node === st && ts.isIdentifier(d.name) && e.name === d.name.text); if (gated && entry && !entry.fn) entry.fn = gated.handler; } // Lauren 2b
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

test('Lauren 2c withPageFlagGate pages: the inline flag predicate and page body are scanned; every other shape is reported',()=>{
  const dir=path.resolve('src/app/m/__b017_page_gate_fixture');
  const head=`import { withPageFlagGate } from "@/server/page-flag-gate"; import { query } from "@/server/db";`;
  const leak=`async () => { await query("SELECT secret"); return true; }`;
  // [source, expected]: 'clean', 'violation' (an unguarded DB read is reported) or a RegExp for the rejection reason.
  const cases:Record<string,[string,'clean'|'violation'|RegExp]>={
    // Accepted shapes: the inline flag and the inline page are both scanned (an unguarded DB read is a violation).
    inlinePageReads:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, async () => { await query("SELECT secret"); return null; });`,'violation'],
    inlineFunctionPageReads:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, async function Page() { await query("SELECT secret"); return null; });`,'violation'],
    flagReads:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: ${leak} }, async () => null);`,'violation'],
    clean:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: async s => s !== null }, async (props, session) => [props, session]);`,'clean'],
    unwrapped:[`export default async function Page(){ return null; }`,'clean'],
    // r3 (Codex r2 BLOCKING, round 3 approved PR-045 a): only inline functions; no identifier, so no reassignment class.
    forOfFlag:[`${head} async function gate() { return true; }
      for ((gate as unknown) of [${leak}]) {}
      export default withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    forInFlag:[`${head} async function gate() { return true; }
      for ((gate as unknown) in { x: 1 }) {}
      export default withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    destructuredForOfFlag:[`${head} async function gate() { return true; }
      for ([gate as unknown] of [[${leak}]]) {}
      export default withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    forOfPage:[`${head} async function Page() { return null; }
      for ((Page as unknown) of [async () => { await query("SELECT secret"); return null; }]) {}
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Page);`,/^Page must be an inline function written in the call$/],
    sameFileFunctionFlag:[`${head} async function gate() { return true; }
      export default withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    sameFileFunctionPage:[`${head} async function Page() { return null; }
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Page);`,/^Page must be an inline function written in the call$/],
    constFlag:[`${head} const gate = async () => true;
      export default withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    constPage:[`${head} const Page = async () => null;
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Page);`,/^Page must be an inline function written in the call$/],
    shorthandFlag:[`${head} const flag = async () => true;
      export default withPageFlagGate({ flagKey: "brand_v3", flag }, async () => null);`,/^shorthand spec key flag$/],
    castFlag:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: (() => true) as never }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    parenthesizedPage:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, (async () => null));`,/^Page must be an inline function written in the call$/],
    // r1 (Codex r1 BLOCKING repro first): the scanned spec must be the one that runs.
    specSpread:[`${head} const overrides: { flag?: () => Promise<boolean> } = { flag: ${leak} };
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, ...overrides }, async () => null);`,/^spread in spec/],
    duplicateFlag:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, flag: ${leak} }, async () => null);`,/^duplicate spec key flag$/],
    computedFlag:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, ["flag"]: ${leak} }, async () => null);`,/^computed or quoted spec key/],
    quotedFlag:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", "flag": ${leak} }, async () => null);`,/^computed or quoted spec key/],
    methodFlag:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", async flag() { await query("SELECT secret"); return true; } }, async () => null);`,/^method or accessor in spec/],
    getterFlag:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", get flag() { return ${leak}; } }, async () => null);`,/^method or accessor in spec/],
    extraKey:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, deps: {} }, async () => null);`,/^unexpected spec key deps$/],
    specCast:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true } as never, async () => null);`,/^spec is not an inline object literal$/],
    unknownKey:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t" }, async () => null);`,/^unexpected spec key tag$/],
    shorthandHeadersOnPage:[`${head} const headers = {}; export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true, headers }, async () => null);`,/^unexpected spec key headers$/],
    specVariable:[`${head} const spec = { flagKey: "brand_v3", flag: ${leak} };
      export default withPageFlagGate(spec, async () => null);`,/^spec is not an inline object literal$/],
    specObjectAssign:[`${head} export default withPageFlagGate(Object.assign({ flagKey: "brand_v3", flag: () => true }, { flag: ${leak} }), async () => null);`,/^spec is not an inline object literal$/],
    flagKeyNotLiteral:[`${head} const key = "brand_v3"; export default withPageFlagGate({ flagKey: key, flag: () => true }, async () => null);`,/^spec\.flagKey must be a string literal$/],
    flagKeyShorthand:[`${head} const flagKey = "brand_v3"; export default withPageFlagGate({ flagKey, flag: () => true }, async () => null);`,/^shorthand spec key flagKey$/],
    missingFlag:[`${head} export default withPageFlagGate({ flagKey: "brand_v3" }, async () => null);`,/^spec\.flag is missing$/],
    shorthandDefault:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag = () => true }, async () => null);`,/^shorthand spec key flag$/],
    importedFlag:[`${head} import { brandV3EnabledForOrg } from "@/server/brand-v3";
      export default withPageFlagGate({ flagKey: "brand_v3", flag: brandV3EnabledForOrg as never }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    importedFlagIdentifier:[`${head} import { brandV3EnabledForOrg as flag } from "@/server/brand-v3";
      export default withPageFlagGate({ flagKey: "brand_v3", flag }, async () => null);`,/^shorthand spec key flag$/],
    reassignedFlag:[`${head} let gate = async () => true; gate = ${leak};
      export default withPageFlagGate({ flagKey: "brand_v3", flag: gate }, async () => null);`,/^spec\.flag must be an inline function written in the call$/],
    pageObjectAssign:[`${head} async function Page(){ return null; }
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Object.assign(Page, { x: 1 }));`,/^Page must be an inline function written in the call$/],
    pageSpread:[`${head} const rest = [async () => { await query("SELECT secret"); return null; }] as const;
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, ...rest);`,/^withPageFlagGate takes exactly \(spec, Page\)/],
    reassignedPage:[`${head} async function Page(){ return null; } (Page as unknown) = async () => { await query("SELECT secret"); };
      export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, Page);`,/^Page must be an inline function written in the call$/],
    importedPage:[`import { withPageFlagGate } from "@/server/page-flag-gate"; import { brandV3EnabledForOrg } from "@/server/brand-v3";
      export default withPageFlagGate({ flagKey: "brand_v3", flag: async () => true }, brandV3EnabledForOrg);`,/^Page must be an inline function written in the call$/],
    withDeps:[`${head} export default withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, async () => null, {} as never);`,/^withPageFlagGate takes exactly \(spec, Page\)/],
    aliased:[`import { withPageFlagGate as gate } from "@/server/page-flag-gate";
      export default gate({ flagKey: "brand_v3", flag: async () => true }, async () => null);`,/^default export call is not a direct withPageFlagGate call$/],
    impostor:[`const withPageFlagGate = (_s: unknown, p: unknown) => p;
      export default withPageFlagGate({ flagKey: "brand_v3", flag: async () => true }, async () => null);`,/^withPageFlagGate does not resolve/],
    parenthesized:[`${head} export default (withPageFlagGate({ flagKey: "brand_v3", flag: () => true }, async () => null));`,/^default export expression is not a direct/],
    defaultArrow:[`${head} export default async () => { await query("SELECT secret"); return null; };`,/^default export expression is not a direct/],
  };
  const virtual=Object.fromEntries(Object.entries(cases).map(([name,[code]])=>[path.join(dir,name,'page.tsx'),code]));
  const host=ts.createCompilerHost(options),original=host.getSourceFile.bind(host);
  host.getSourceFile=(file,language,onError,fresh)=>virtual[path.resolve(file)]!==undefined
    ?ts.createSourceFile(file,virtual[path.resolve(file)],language,true,ts.ScriptKind.TSX):original(file,language,onError,fresh);
  const fixtures=ts.createProgram([...files,...Object.keys(virtual)],options,host),fixtureChecker=fixtures.getTypeChecker();
  const resolveIn=(call:ts.CallExpression)=>{let s=fixtureChecker.getSymbolAtLocation(call.expression);if(s&&s.flags&ts.SymbolFlags.Alias)s=fixtureChecker.getAliasedSymbol(s);return s?.valueDeclaration;};
  for(const [name,[,expected]] of Object.entries(cases)) {
    const source=fixtures.getSourceFile(path.join(dir,name,'page.tsx'));assert.ok(source,name);
    const out=pageGateFailures(source,fixtureChecker,resolveIn);
    if(expected==='clean'){assert.deepEqual(out,[],name);continue;}
    assert.equal(out.length,1,`${name}: ${out.join(' | ')}`);
    const reason=out[0].replace(/^[^#]*#default: /,'');
    if(expected==='violation')assert.match(reason,/query@/,name);
    else assert.match(reason,expected,name);
  }
});

test('Lauren 2c r1/r3: a withFlagGate route spec with a spread, computed, duplicate, unknown or shorthand key, or a non-inline flag or handler, is not classified as gated',()=>{
  const dir=path.resolve('src/app/api/__b017_route_gate_fixture');
  const head=`import { withFlagGate } from "@/server/flag-gate"; import { query } from "@/server/db"; const headers = {};`;
  const leak=`async () => { await query("SELECT secret"); return true; }`;
  const cases:Record<string,[string,boolean]>={
    good:[`${head} export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t", headers, sameOrigin: true }, async () => new Response(null));`,true],
    spread:[`${head} const o = { flag: ${leak} }; export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t", ...o }, async () => new Response(null));`,false],
    duplicate:[`${head} export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t", flag: ${leak} }, async () => new Response(null));`,false],
    computed:[`${head} export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t", ["flag"]: ${leak} }, async () => new Response(null));`,false],
    unknown:[`${head} export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t", extra: 1 }, async () => new Response(null));`,false],
    // r3: the route flag and handler must be inline functions written in the call (the 4 real routes are, asserted below).
    constFlag:[`${head} const gate = async () => true; export const POST = withFlagGate({ flagKey: "brand_v3", flag: gate, tag: "t" }, async () => new Response(null));`,false],
    shorthandFlag:[`${head} const flag = async () => true; export const POST = withFlagGate({ flagKey: "brand_v3", flag, tag: "t" }, async () => new Response(null));`,false],
    functionHandler:[`${head} async function handler() { await query("SELECT secret"); return new Response(null); }
      export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t" }, handler);`,false],
    forOfHandler:[`${head} async function handler() { return new Response(null); }
      for ((handler as unknown) of [async () => { await query("SELECT secret"); return new Response(null); }]) {}
      export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t" }, handler);`,false],
    shorthandTag:[`${head} const tag = "t"; export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag }, async () => new Response(null));`,false],
    shorthandHeadersDefault:[`${head} export const POST = withFlagGate({ flagKey: "brand_v3", flag: () => true, tag: "t", headers = {} }, async () => new Response(null));`,false],
  };
  const virtual=Object.fromEntries(Object.entries(cases).map(([name,[code]])=>[path.join(dir,name,'route.ts'),code]));
  const host=ts.createCompilerHost(options),original=host.getSourceFile.bind(host);
  host.getSourceFile=(file,language,onError,fresh)=>virtual[path.resolve(file)]!==undefined
    ?ts.createSourceFile(file,virtual[path.resolve(file)],language,true):original(file,language,onError,fresh);
  const fixtures=ts.createProgram([...files,...Object.keys(virtual)],options,host),fixtureChecker=fixtures.getTypeChecker();
  for(const [name,[,gated]] of Object.entries(cases)) {
    const source=fixtures.getSourceFile(path.join(dir,name,'route.ts'));assert.ok(source,name);
    const post=source.statements.filter(ts.isVariableStatement).at(-1);
    assert.equal(!!flagGated(post,'POST',fixtureChecker),gated,name);
  }
  // The 4 real migrated routes keep classifying as gated: their spec.flag and handler are inline arrows in the call.
  for(const f of ['owner-view','team-security','notify-settings','maint-unit-assign']) {
    const source=program.getSourceFile(`src/app/api/${f}/route.ts`)!;
    const gated=source.statements.map(st=>flagGated(st,'POST')).find(Boolean);
    assert.ok(gated&&ts.isArrowFunction(gated.flag)&&ts.isArrowFunction(gated.handler)&&ts.isCallExpression(gated.handler.parent),f);
  }
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
