import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { v2SavedId } from "./settlement-v2-save-result";
test("only exact v2 save response is recorded",()=>{const id=randomUUID(),ok={ok:true,id,recovered:false,freshness:"current"};assert.equal(v2SavedId(ok),id);for(const invalid of [null,[],{...ok,ok:"true"},{...ok,id:[id]},{...ok,recovered:0},{...ok,freshness:"stale"},{...ok,extra:true},Object.assign(new Date(),ok)])assert.equal(v2SavedId(invalid),null);});
