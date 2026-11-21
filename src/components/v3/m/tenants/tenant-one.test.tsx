import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TenantOneView, TenantOneLoading, tenantOneLead } from "./tenant-one";
import { TenantsView } from "./tenants";
import type { TenantOneReady } from "../../../../server/b3-tenant-one";
import { tenantsCopy } from "../../../../i18n/lanes/brand-v3-tenants";
// The LINE column label comes from the lane (demo.test.ts flags hardcoded product names in components).
const lineLabel = tenantsCopy("zh-TW").line;
const data:TenantOneReady={state:"ready",id:"synthetic",name:"Alex",lineLinked:true,canViewContact:true,mobileRequired:true,
  phone:"+19995550123",email:"tenant@example.test",legacyPhoneNotice:true,
  leases:[{id:"lease",place:"Unit A",status:"active",endDate:"2031-01-01"}]};
const render=(d:Parameters<typeof TenantOneView>[0]["data"]=data,canAddLease=false)=>renderToStaticMarkup(<TenantOneView data={d} locale="zh-TW" id="synthetic" canAddLease={canAddLease} />);
test("approved lead, contact and note copy; OQ-066 notice has no fabricated verified time",()=>{
  const html=render();
  for(const text of ["Alex住Unit A，租約到 2031-01-01。","聯絡資料","+19995550123","未驗證","管理方更新","已加入","Email","tenant@example.test",
    "修改號碼時，系統會把驗證碼傳到新號碼。租客在自己的租多啦完成驗證前，目前的號碼不會變更。"])
    assert.ok(html.includes(text),text);
  assert.match(html,/aria-describedby="tenant-phone-tip"/);assert.match(html,/role="tooltip"/);
  assert.doesNotMatch(html,/已驗證|已關聯|租客自己填寫|<button|<form|查看待驗證進度|查看改號紀錄/);
});
test("accountant and contact-denied custom DTO render no contact values, placeholders, metadata or note",()=>{
  const html=render({...data,canViewContact:false});
  for(const text of ["手機","+19995550123","未驗證","管理方更新","Email","tenant@example.test","•••","驗證碼"])assert.ok(!html.includes(text),text);
  assert.ok(html.includes(lineLabel));assert.ok(html.includes("已加入"));
});
test("item OFF hides notices and note; absent phone has no verification/source notice",()=>{
  const html=render({...data,mobileRequired:false});assert.ok(html.includes(data.phone!));
  assert.doesNotMatch(html,/未驗證|管理方更新|驗證碼/);
  const absent=render({...data,phone:null,email:null,lineLinked:false});
  assert.ok(absent.includes("尚未填寫"));assert.ok(absent.includes("未加入"));assert.doesNotMatch(absent,/未驗證|管理方更新/);
  assert.doesNotMatch(render({...data,legacyPhoneNotice:undefined}),/未驗證|管理方更新/);
});
test("lead variants retain shipped name/status for no active dated lease, never assert occupancy",()=>{
  for(const leases of [[],[{...data.leases[0],endDate:null}],[{...data.leases[0],status:"pending_signature"}],
    [{...data.leases[0],status:"ended"}],[data.leases[0],{...data.leases[0],id:"second"}]]){
    assert.equal(tenantOneLead({...data,leases},"zh-TW"),"Alex");
    assert.ok(!render({...data,leases}).includes("Alex住"));
  }
  const empty=render({...data,leases:[]},true);assert.ok(empty.includes("這位租客還沒有租約"));assert.ok(empty.includes("補上租約"));assert.ok(empty.includes('href="/m/leases/new"'));
  assert.ok(!render({...data,leases:[]}).includes('href="/m/leases/new"'));
  assert.equal(tenantOneLead(data,"en"),"Alex lives at Unit A; the lease ends on 2031-01-01.");
  assert.equal(tenantOneLead({...data,name:"Alex {unit}"},"zh-TW"),"Alex {unit}住Unit A，租約到 2031-01-01。");
});
test("permission/error/loading states and no empty, dead or invented phone destinations",()=>{
  assert.ok(render({state:"forbidden"}).includes("請管理者完成設定。"));
  const failure=render({state:"unavailable"});assert.ok(failure.includes("資料載入失敗"));assert.ok(failure.includes("再試一次"));assert.ok(failure.includes('href="/m/tenants/synthetic"'));
  assert.match(renderToStaticMarkup(<TenantOneLoading locale="zh-TW" />),/aria-busy="true"/);
  assert.doesNotMatch(render(),/href="#"|修改手機號碼|查看待驗證進度|查看改號紀錄/);
});
test("LPQ-13 both tenant pages defer breadcrumbs to the v3 shell",()=>{
  const list=renderToStaticMarkup(<TenantsView locale="zh-TW" params={{}} data={{state:"ready",q:"",filter:"all",mobileRequired:false,canViewPhone:false,total:1,missing:null,filteredCount:1,nextCursor:null,rows:[{id:"synthetic",name:"Alex",place:"Unit A",lineLinked:true}]}} />);
  for(const html of [list,render(),render({state:"forbidden"}),render({state:"unavailable"})])assert.doesNotMatch(html,/v3-tenants-crumb|物件與租客|›/);
});
