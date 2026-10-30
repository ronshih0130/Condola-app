import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { settlementV2Rollout } from "./settlement-v2-page-context";
test("staff rollout distinguishes enabled, disabled and malformed policy",()=>{const id=randomUUID(),on={enabled:true,allowed_org_ids:[id]},flags={deposit_settlements:true};assert.equal(settlementV2Rollout(on,flags,id),"on");for(const [policy,org] of [[{enabled:false,allowed_org_ids:[]},flags],[on,{}],[on,{deposit_settlements:false}],[{enabled:true,allowed_org_ids:[]},flags]] as const)assert.equal(settlementV2Rollout(policy,org,id),"off");for(const [policy,org] of [[null,flags],[{enabled:"true",allowed_org_ids:[id]},flags],[{enabled:true,allowed_org_ids:["bad"]},flags],[on,{deposit_settlements:"true"}],[on,null]] as const)assert.equal(settlementV2Rollout(policy,org,id),"unavailable");});
