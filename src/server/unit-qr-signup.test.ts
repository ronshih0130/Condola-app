import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizeUnitQrIp, unitQrClientIp } from "./unit-qr-ingress";
import { unitQrExchangeScript, unitQrEntryResponse } from "./unit-qr-entry";
import { clearUnitQrCookie, invalidateUnitQrCookie } from "./unit-qr-cookie";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { unitQrCopy } from "../i18n/lanes/unit-qr";
import { randomBytes } from "node:crypto";
import { newUnitQrToken, verifyUnitQrToken } from "./unit-qr-signup";

test("QR signatures fail closed, carry no unit data, and reject tampering/key rotation", () => {
  const saved = process.env.UNIT_QR_SIGNING_KEY;
  try {
    delete process.env.UNIT_QR_SIGNING_KEY;
    assert.equal(newUnitQrToken(), null);
    process.env.UNIT_QR_SIGNING_KEY = "short";
    assert.equal(newUnitQrToken(), null);
    process.env.UNIT_QR_SIGNING_KEY = randomBytes(32).toString("hex");
    const token = newUnitQrToken()!;
    assert.match(token, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(verifyUnitQrToken(token), true);
    assert.notEqual(newUnitQrToken(), token);
    for (const bad of ["", token + ".x", token.slice(1), token.replace(/^./, token[0] === "a" ? "b" : "a"), token + "="]) {
      assert.equal(verifyUnitQrToken(bad), false);
    }
    process.env.UNIT_QR_SIGNING_KEY = randomBytes(32).toString("hex");
    assert.equal(verifyUnitQrToken(token), false);
    delete process.env.UNIT_QR_SIGNING_KEY;
    assert.equal(verifyUnitQrToken(token), false);
  } finally {
    if (saved === undefined) delete process.env.UNIT_QR_SIGNING_KEY;
    else process.env.UNIT_QR_SIGNING_KEY = saved;
  }
});


test("only runtime-trusted ingress or socket determines the normalized limiter identity", () => {
  const headers=new Headers({"cf-connecting-ip":"2001:0DB8:0:0:0:0:0:1","x-forwarded-for":"attacker, 198.51.100.2","x-real-ip":"203.0.113.1"});
  assert.equal(unitQrClientIp(headers,{cloudflare:true}),"2001:db8::1");
  assert.equal(unitQrClientIp(headers,{cloudflare:false,socketAddress:"::ffff:127.0.0.1"}),"127.0.0.1");
  assert.equal(unitQrClientIp(headers,{cloudflare:false}),null);
  for(const value of ["invalid","127.0.0.1, 127.0.0.2","fe80::1%en0","[::1]:42",""]) assert.equal(normalizeUnitQrIp(value),null);
  assert.equal(normalizeUnitQrIp("::ffff:c000:0201"),"192.0.2.1");
  assert.equal(normalizeUnitQrIp(" ::1 "),"::1");
});

test("fragment is scrubbed before parsing, POST, analytics or errors, including rejected exchange", async () => {
  for(const ok of [true,false,"throw"] as const) {
    const events: unknown[][]=[];
    const token="synthetic-private-bearer";
    await runInNewContext(unitQrExchangeScript,{
      location:{hash:`#t=${token}`,pathname:"/signup/unit-qr",replace:(url:string)=>events.push(["replace",url])},
      history:{replaceState:(state:null,title:string,path:string)=>events.push(["scrub",state,title,path])},
      URLSearchParams,
      fetch:async(url:string,init:RequestInit)=>{
        assert.deepEqual(events,[["scrub",null,"","/signup/unit-qr"]]);
        assert.equal(init.body,JSON.stringify({token}));
        assert.equal(init.referrerPolicy,"no-referrer");
        events.push(["request",url,init.method || "GET"]);
        if(ok==="throw") throw new Error(token);
        return {ok};
      },
      console:{error:()=>assert.fail("No error logging"),log:()=>assert.fail("No logging")},
    });
    assert.equal(JSON.stringify(events).includes(token),false);
    assert.deepEqual(events.at(-1),["replace",ok===true?"/signup":"/signup?error=required"]);
  }
  const response=unitQrEntryResponse();
  assert.match(response.headers.get("content-security-policy")!,/default-src 'none'/);
  const html=await response.text();
  assert.equal((html.match(/<script/g)||[]).length,1);
  assert.doesNotMatch(html,/src=|analytics|sendBeacon|console\./);
  const route=readFileSync(new URL("../app/api/signup/unit-qr/route.ts",import.meta.url),"utf8");
  assert.doesNotMatch(route,/console\.|recordFunnel|recordAudit/);
});

test("clearing a browser handle expires the same signup-scoped HttpOnly cookie", () => {
  const writes:unknown[][]=[];
  clearUnitQrCookie({set:(...args)=>writes.push(args)});
  assert.deepEqual(writes,[["condola_unit_qr","",{path:"/signup",maxAge:0,httpOnly:true,sameSite:"lax"}]]);
});


// Execute the real action/page/form source with only framework and I/O boundaries
// replaced. This catches redirects losing intent, not just helper return values.
function signupProbe() {
  const jar = new Map<string,string>();
  const formHandles = new Map<string,string>();
  const calls: string[] = [];
  const signupInputs: Record<string,unknown>[] = [];
  let disabled = false;
  const require = createRequire(import.meta.url);
  const cookieJar = {
    get: (name:string) => jar.has(name) ? {value:jar.get(name)!} : undefined,
    set: (name:string,value:string,options:{maxAge?:number}) => {
      if(options.maxAge===0) jar.delete(name); else jar.set(name,value);
    },
  };
  const qr = {
    UNIT_QR_COOKIE: "condola_unit_qr",
    readUnitQrContinuation: async (handle?:string) => {
      calls.push("continuation");
      if (!handle) return {state:"absent"};
      if (handle==="invalid") return {state:"invalid"};
      if (disabled) return {state:"disabled"};
      return {state:"active",context:{id:handle,done:false,active:true}};
    },
    createUnitQrForm: async (handle:string) => {
      calls.push("create-form");
      const id = `opaque-form-${formHandles.size}`;
      formHandles.set(id,handle); return id;
    },
    unitQrFormMatches: async (id:string,handle:string) => {
      calls.push("match-form"); return formHandles.get(id)===handle;
    },
  };
  const redirect = (path:string) => { throw new Error(`REDIRECT ${path}`); };
  const modules: Record<string,unknown> = {
    "next/headers": {cookies:async()=>cookieJar,headers:async()=>new Headers({host:"localhost"})},
    "next/navigation": {redirect},
    "./unit-qr-signup": qr,
    "@/server/unit-qr-signup": qr,
    "./unit-qr-cookie": {clearUnitQrCookie,invalidateUnitQrCookie},
    "./signup": {startSignup:async(input:Record<string,unknown>)=>{
      calls.push("signup-write"); signupInputs.push(input);
      return {ok:true,status:"verify",email:"synthetic@example.invalid",devToken:null,unitQrBound:!!input.unitQrHandle};
    }},
    "@/server/session": {requestPrefs:async()=>({locale:"en"})},
    "@/server/brand-v2": {brandV2Enabled:()=>false},
    "@/i18n": {makeT:()=> (key:string)=>key},
    "@/i18n/lanes/unit-qr": {unitQrCopy},
    "@/components/brand": {AuthBrand:()=>null},
    "./locale": {useT:()=> (key:string)=>key},
    "./consent-check": {LegalConsentCheckbox:()=>null},
    "./pending-submit": {PendingSubmit:()=>null},
  };
  function load(path:string): Record<string,unknown> {
    const source=readFileSync(new URL(path,import.meta.url),"utf8");
    const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports: Record<string,unknown>={};
    runInNewContext(compiled,{exports,URLSearchParams,require:(name:string)=>{
      if(name in modules) return modules[name];
      if(name==="react" || name==="react/jsx-runtime") return require(name);
      return {};
    }});
    return exports;
  }
  const actions = load("./signup-actions.ts") as {actionStartSignup:(form:FormData)=>Promise<void>};
  const abandon = load("./unit-qr-actions.ts") as {actionAbandonUnitQr:()=>Promise<void>};
  modules["@/server/signup-actions"]=actions;
  modules["@/server/unit-qr-actions"]=abandon;
  modules["@/components/signup-form"]=load("../components/signup-form.tsx");
  const page = load("../app/signup/page.tsx") as {default:(props:{searchParams:Promise<{error?:string}>})=>Promise<ReactElement>};
  return {
    jar,calls,signupInputs,actions,abandon,
    disable:()=>{disabled=true;},
    html: async(error?:string)=>renderToStaticMarkup(await page.default({searchParams:Promise.resolve({error})})),
  };
}
function renderedForm(html:string) {
  const match=html.match(/name="unitQrContinuation" value="([^"]+)"/);
  assert.ok(match,"QR form must render an exact continuation id");
  const form=new FormData(); form.set("unitQrContinuation",match[1]); return form;
}

test("expired cookie rejection survives redirect and a second submission until abandon or rescan", async () => {
  const probe=signupProbe();
  probe.jar.set("condola_unit_qr","handle-a");
  const form=renderedForm(await probe.html());
  probe.jar.delete("condola_unit_qr"); // browser expiry while the form is open
  await assert.rejects(probe.actions.actionStartSignup(form),/REDIRECT \/signup\?error=required/);
  assert.equal(probe.jar.get("condola_unit_qr"),"invalid");
  const retryPage=await probe.html("required");
  assert.ok(retryPage.includes('role="alert"'));
  assert.equal(retryPage.includes('name="email"'),false);
  // Even a second submission omitting the stale hidden field cannot downgrade.
  await assert.rejects(probe.actions.actionStartSignup(new FormData()),/REDIRECT \/signup\?error=required/);
  assert.equal(probe.signupInputs.length,0);
  assert.equal((await probe.html()).includes('name="email"'),false);
  await assert.rejects(probe.abandon.actionAbandonUnitQr(),/REDIRECT \/signup$/);
  assert.ok((await probe.html()).includes('name="email"'));
  probe.jar.set("condola_unit_qr","handle-rescanned");
  const replacement=renderedForm(await probe.html());
  await assert.rejects(probe.actions.actionStartSignup(replacement),/REDIRECT \/signup\/verify/);
  assert.equal(probe.signupInputs[0].unitQrHandle,"handle-rescanned");
  assert.equal(probe.jar.has("condola_unit_qr"),false);
});

test("tab A cannot submit tab B's continuation and rejection occurs before signup writes", async () => {
  const probe=signupProbe();
  probe.jar.set("condola_unit_qr","handle-a");
  const a=renderedForm(await probe.html());
  probe.jar.set("condola_unit_qr","handle-b");
  const b=renderedForm(await probe.html());
  assert.notEqual(a.get("unitQrContinuation"),b.get("unitQrContinuation"));
  await assert.rejects(probe.actions.actionStartSignup(a),/REDIRECT \/signup\?error=required/);
  assert.equal(probe.signupInputs.length,0);
  assert.equal(probe.jar.get("condola_unit_qr"),"invalid");
  await assert.rejects(probe.actions.actionStartSignup(b),/REDIRECT \/signup\?error=required/);
  assert.equal(probe.signupInputs.length,0);
});

test("OFF signup output and action sequence equal ordinary signup with no form persistence or matching", async () => {
  const ordinary=signupProbe();
  const off=signupProbe(); off.disable(); off.jar.set("condola_unit_qr","old-handle");
  assert.equal(await off.html(),await ordinary.html());
  assert.deepEqual(off.calls,ordinary.calls);
  const staleForm=new FormData(); staleForm.set("unitQrContinuation","old-form");
  await assert.rejects(off.actions.actionStartSignup(staleForm),/REDIRECT \/signup\/verify/);
  await assert.rejects(ordinary.actions.actionStartSignup(new FormData()),/REDIRECT \/signup\/verify/);
  assert.deepEqual(off.calls,ordinary.calls);
  assert.equal(JSON.stringify(off.signupInputs),JSON.stringify(ordinary.signupInputs));
});
