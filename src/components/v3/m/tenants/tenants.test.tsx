import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TenantsView, TenantsLoading, tenantsHref } from "./tenants";
import type { TenantsResult } from "../../../../server/b3-tenants";
const data:Extract<TenantsResult,{state:"ready"}>={state:"ready",q:"",filter:"all",canViewPhone:true,mobileRequired:true,total:73,missing:4,filteredCount:73,nextCursor:null,
  rows:[{id:"test-id",name:"Synthetic",place:"Unit",phone:"+19995550123",verified:false,staffUpdated:true,lineLinked:true}]};
const render=(d:Parameters<typeof TenantsView>[0]["data"], params={})=>renderToStaticMarkup(<TenantsView data={d} locale="zh-TW" params={params} canInvite />);
test("approved lead, columns, source chips, accessible tooltip and existing detail link",()=>{
  const html=render(data);
  for(const text of ["有 73 位租客，4 位還沒留手機。","搜尋姓名、單位、電話","未驗證","管理方更新","還沒用簡訊確認過，號碼可能有誤。","/m/tenants/test-id","已加入"])
    assert.ok(html.includes(text),text);
  assert.match(html,/role="tooltip"/);assert.match(html,/aria-describedby="phone-tip-test-id"/);assert.doesNotMatch(html,/btn pri/);
});
test("accountant renders no phone column, value, missing filter, verification metadata or phone-search invitation",()=>{
  const html=render({...data,canViewPhone:false,missing:null});
  for(const text of ["+19995550123","未驗證","管理方更新","缺手機","手機","電話","•••"])assert.ok(!html.includes(text),text);
  assert.ok(html.includes("搜尋姓名、單位"));
});
test("search none beats empty filter; clear keeps other filter and resets cursor",()=>{
  const html=render({...data,rows:[],q:"missing",filter:"missing"});
  for(const text of ["找不到符合的結果","換個關鍵字，或清除搜尋看全部。","清除搜尋"])assert.ok(html.includes(text));
  assert.ok(html.includes('href="/m/tenants?filter=missing"'));assert.ok(!html.includes("沒有缺手機號碼的租客"));
  const filtered=render({...data,rows:[],filter:"missing"});assert.ok(filtered.includes("沒有缺手機號碼的租客"));assert.ok(filtered.includes("清除篩選"));
});
test("TEN empty uses reusable empty state, outline invitation; missing phone has no chips",()=>{
  const html=render({...data,rows:[],total:0,missing:0});assert.ok(html.includes("還沒有租客加入"));assert.ok(html.includes("邀請租客"));assert.doesNotMatch(html,/btn pri/);
  const missing=render({...data,rows:[{...data.rows[0],phone:null,staffUpdated:false}]});assert.ok(missing.includes("尚未填寫"));assert.ok(!missing.includes('role="tooltip"'));
});
test("permission, retry, loading and cursor navigation",()=>{
  assert.ok(render({state:"forbidden"}).includes("請管理者完成設定。"));
  assert.ok(render({state:"unavailable"},{q:"x",filter:"missing",cursor:"bad"}).includes("再試一次"));
  assert.ok(render({...data,nextCursor:"next"},{cursor:"prev"}).includes("下一頁"));
  assert.ok(render({...data,nextCursor:"next"},{cursor:"prev"}).includes("返回第一頁"));
  assert.match(renderToStaticMarkup(<TenantsLoading locale="en" />),/aria-busy="true"/);
  assert.equal(tenantsHref({q:"a&b",filter:"missing",cursor:"next"}),"/m/tenants?q=a%26b&filter=missing&cursor=next");
});

test("item OFF omits badges, missing lead/chip and crafted filter links but retains permitted phone",()=>{
  const html=render({...data,mobileRequired:false,filter:"missing",rows:[{...data.rows[0],duplicateName:"Other tenant"}]},{filter:"missing"});
  assert.ok(html.includes("有 73 位租客。"));assert.ok(html.includes("+19995550123"));
  for(const text of ["未驗證","管理方更新","缺手機","還沒留手機","filter=missing",'name="filter"',"Other tenant"])assert.ok(!html.includes(text),text);
});
test("same-number hint renders exact AC3 copy on each row and never for accountant",()=>{
  const rows=[{...data.rows[0],name:"Alex",duplicateName:"Blair"},{...data.rows[0],id:"second",name:"Blair",duplicateName:"Alex"}];
  const html=render({...data,rows});
  assert.ok(html.includes("和 Blair 的號碼相同"));assert.ok(html.includes("和 Alex 的號碼相同"));
  assert.ok(!render({...data,rows,canViewPhone:false}).includes("的號碼相同"));
});
