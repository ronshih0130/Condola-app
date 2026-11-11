import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizeUnitQrIp, unitQrClientIp } from "./unit-qr-ingress";
import { clearUnitQrCookie, invalidateUnitQrCookie } from "./unit-qr-cookie";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { unitQrCopy } from "../i18n/lanes/unit-qr";
import { randomBytes } from "node:crypto";
import { newUnitQrToken, verifyUnitQrToken } from "./unit-qr-signup";
import { landingHtml } from "./unit-line-invite";
import { GET } from "../app/signup/unit-qr/route";
import { POST } from "../app/api/signup/unit-qr/route";

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

test("TEN-29-AC3 / R-a6: retired QR GET serves one static no-store page that ignores any token and POST always 404s empty", async () => {
  const token = "zqx".repeat(15).slice(0, 43); // 43-char token the page must never echo
  assert.equal(token.length, 43);
  assert.equal((GET as (...args: unknown[]) => unknown).length, 0);
  const responses = [await GET(), await GET(), await GET()];
  const bodies: string[] = [];
  for (const res of responses) {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("location"), null);
    assert.ok((res.headers.get("content-type") || "").startsWith("text/html"));
    const html = await res.text();
    assert.ok(html.includes("這個 QR 已停用"));
    assert.ok(html.includes("請跟管理公司拿最新的邀請"));
    assert.equal(html.includes("<script"), false);
    assert.doesNotMatch(html, /\{\{|\$\{|%company%|%unit%|__COMPANY__|__UNIT__/);
    assert.equal(html.includes(token), false);
    bodies.push(html);
  }
  assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[1], bodies[2]);
  const post = await POST();
  assert.equal(post.status, 404);
  assert.equal(await post.text(), "");
  assert.equal(post.headers.get("location"), null);
  assert.equal(post.headers.get("set-cookie"), null);
  assert.match(post.headers.get("cache-control") || "", /no-store/);
  assert.equal(post.headers.get("referrer-policy"), "no-referrer");
});

test("clearing a browser handle expires the same signup-scoped HttpOnly cookie", () => {
  const writes:unknown[][]=[];
  clearUnitQrCookie({set:(...args)=>writes.push(args)});
  assert.deepEqual(writes,[["condola_unit_qr","",{path:"/signup",maxAge:0,httpOnly:true,sameSite:"lax"}]]);
});


// Execute the real signup action and page source with only framework and I/O
// boundaries replaced. The retired unit-qr cookie must leave no trace in output.
function signupProbe() {
  const jar = new Map<string,string>();
  const calls: string[] = [];
  const signupInputs: Record<string,unknown>[] = [];
  const require = createRequire(import.meta.url);
  const cookieJar = {
    get: (name:string) => jar.has(name) ? {value:jar.get(name)!} : undefined,
    set: (name:string,value:string,options:{maxAge?:number}) => {
      if(options.maxAge===0) jar.delete(name); else jar.set(name,value);
    },
  };
  const redirect = (path:string) => { throw new Error(`REDIRECT ${path}`); };
  const modules: Record<string,unknown> = {
    "next/headers": {cookies:async()=>cookieJar,headers:async()=>new Headers({host:"localhost"})},
    "next/navigation": {redirect},
    "./unit-qr-cookie": {clearUnitQrCookie,invalidateUnitQrCookie},
    "./signup": {startSignup:async(input:Record<string,unknown>)=>{
      calls.push("signup-write"); signupInputs.push(input);
      return {ok:true,status:"verify",email:"synthetic@example.invalid",devToken:null};
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
  modules["@/server/signup-actions"]=actions;
  modules["@/components/signup-form"]=load("../components/signup-form.tsx");
  const page = load("../app/signup/page.tsx") as {default:(props:{searchParams:Promise<{error?:string}>})=>Promise<ReactElement>};
  return {
    jar,calls,signupInputs,actions,
    html: async(error?:string)=>renderToStaticMarkup(await page.default({searchParams:Promise.resolve({error})})),
  };
}

test("TEN-29-AC4: signup page and action ignore the retired unit-qr cookie and never bind a unit handle", async () => {
  const withCookie=signupProbe(); withCookie.jar.set("condola_unit_qr","old-handle");
  const without=signupProbe();
  const a=await withCookie.html();
  const b=await without.html();
  assert.equal(a,b);
  assert.ok(a.includes('name="email"'));
  for(const forbidden of ["UNIT_QR_COOKIE","unit-qr-signup-hint","unitQrContinuation","actionAbandonUnitQr","createUnitQrForm"]) {
    assert.equal(a.includes(forbidden),false);
  }
  const pageSrc=readFileSync(new URL("../app/signup/page.tsx",import.meta.url),"utf8");
  for(const forbidden of ["UNIT_QR_COOKIE","readUnitQrContinuation","createUnitQrForm","actionAbandonUnitQr","unit-qr-signup-hint","unitQrCopy"]) {
    assert.equal(pageSrc.includes(forbidden),false);
  }
  const probe=signupProbe(); probe.jar.set("condola_unit_qr","old-handle");
  const form=new FormData(); form.set("unitQrContinuation","old-form");
  await assert.rejects(probe.actions.actionStartSignup(form),/REDIRECT \/signup\/verify/);
  assert.equal(probe.signupInputs.length,1);
  assert.equal(probe.signupInputs[0].unitQrHandle,undefined);
});

test("MGT-51-AC3: units index drops the QR invite link and every unit-qr surface is deleted", () => {
  const unitsSrc=readFileSync(new URL("../app/m/units/page.tsx",import.meta.url),"utf8");
  assert.equal(unitsSrc.includes("單元申請連結"),false);
  assert.equal(unitsSrc.includes("/m/units/qr"),false);
  for(const gone of [
    "../app/m/units/qr/page.tsx",
    "../components/unit-qr-control.tsx",
    "./unit-qr-actions.ts",
    "../components/unit-qr-profile.tsx",
  ]) {
    assert.equal(existsSync(new URL(gone,import.meta.url)),false);
  }
});

test("MGT-51-AC4 / FLAG-OFF: unit_qr_signup defaults off, is pinned off, and no signing key ships in tracked config", () => {
  const flags=readFileSync(new URL("../../ops/flags.yaml",import.meta.url),"utf8");
  const idx=flags.indexOf("unit_qr_signup");
  assert.notEqual(idx,-1);
  const block=flags.slice(idx);
  assert.match(block,/default:\s*false/);
  assert.ok(block.includes("must not be turned on"));
  const wrangler=readFileSync(new URL("../../wrangler.jsonc",import.meta.url),"utf8");
  assert.equal(wrangler.includes("UNIT_QR_SIGNING_KEY"),false);
});

test("TEN-29-AC2: the QR landing page exposes no Email-signup path or /signup link", () => {
  const html=landingHtml({token:"A".repeat(43),firm:"Acme",unit:"A1"});
  assert.equal(html.includes("用 Email 建立"),false);
  assert.equal(html.includes("/signup"),false);
});
