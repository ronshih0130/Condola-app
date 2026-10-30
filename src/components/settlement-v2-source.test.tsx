import React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettlementV2Source } from "./settlement-v2-source";
const projection={coverage:"unverified" as const,amountBasis:"raw_minor_units" as const,statementCurrency:"TWD",cycles:[{currency:"USD",periodStart:"2028-01-01",periodEnd:"2028-01-31",monthlyMinor:"100"}],cash:[{kind:"payment",currency:"TWD",amountMinor:"200",revision:1,validity:"unknown" as const}],lines:[{description:"Synthetic utility",chargeType:"utility",amountMinor:"-30",period:null,invoiceNumber:"INV-SYN",currency:"USD",status:"paid",balanceMinor:"0",classification:null}]};
test("unverified sources retain each currency and explicit raw-unit labels",()=>{const en=renderToStaticMarkup(<SettlementV2Source projection={projection} locale="en"/>);assert.match(en,/100 minor units \(USD\)/);assert.match(en,/200 minor units \(TWD\)/);assert.match(en,/-30 minor units \(USD\)/);assert.match(en,/not been fully reconciled/);assert.match(en,/Source status not yet verified/);assert.match(en,/Charge type: Utility/);assert.match(en,/Line amount:/);assert.match(en,/Invoice status:/);assert.match(en,/Invoice balance:/);const zh=renderToStaticMarkup(<SettlementV2Source projection={projection} locale="zh-TW"/>);assert.match(zh,/最小貨幣單位/);assert.match(zh,/結算金額目前未知/);});
