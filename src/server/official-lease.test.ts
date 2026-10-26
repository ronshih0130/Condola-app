import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { officialLeaseTemplateText } from "../assets/leases/moi-residential-1130708";
import { makeT } from "@/i18n";
import { buildLeasePdf, type LeasePdfSource } from "@/server/pdf-docs";
import { officialLeaseTemplate, renderOfficialLease, type LeaseFieldPatch, type OfficialLeaseInput } from "@/server/official-lease";

const stored = readFileSync(new URL("../assets/leases/moi-residential-1130708.txt", import.meta.url), "utf8");
const sublessor = "二" + "房東";

function restore(text: string, patches: LeaseFieldPatch[]) {
  const ordered = patches
    .map((patch, order) => ({ patch, order }))
    .sort((a, b) => b.patch.index - a.patch.index || b.order - a.order);
  let out = text;
  for (const { patch } of ordered) {
    assert.equal(out.slice(patch.index, patch.index + patch.value.length), patch.value, `patch ${patch.index}`);
    assert.notEqual(patch.value, patch.blank);
    if (patch.blank === "") assert.equal(patch.value, " ");
    else assert.match(patch.blank, /^(?:□|[_ \u3000]+|號|之)$/);
    out = out.slice(0, patch.index) + patch.blank + out.slice(patch.index + patch.value.length);
  }
  return out;
}

function assertOfficial(text: string) {
  for (const article of [
    "第一條",
    "第二條",
    "第三條",
    "第四條",
    "第五條",
    "第六條",
    "第七條",
    "第八條",
    "第九條",
    "第十條",
    "第十一條",
    "第十二條",
    "第十三條",
    "第十四條",
    "第十五條",
    "第十六條",
    "第十七條",
    "第十八條",
    "第十九條",
    "第二十條",
    "第二十一條",
    "第二十二條",
    "第二十三條",
  ]) {
    assert.equal(text.includes(`${article}  `) || text.includes(article), true, article);
  }
  assert.equal(text.includes("最高不得超過二個月租金之總額"), true);
  assert.equal(text.includes("承租人不得申請租金補貼"), true);
  assert.equal(text.includes("(四)承租人因疾病、意外產生有長期療養之需要。"), true);
  assert.equal(text.includes("(五)因第三人就租賃住宅主張其權利，致承租人不能為約定之居住使用。"), true);
  assert.equal(text.includes("難以繼續居住"), false);
  assert.equal(text.includes(sublessor), true);
  assert.equal(text.split(sublessor).join("").includes("房東"), false);
}

const filled: OfficialLeaseInput = {
  tenantName: "張雅文",
  ownerName: "陳建宏",
  address: { city: "台北市", district: "信義區", street: "松仁路88號" },
  addressDisplay: "台北市信義區松仁路88號",
  floor: "3",
  roomLabel: "A",
  scope: "partial",
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  rentMinor: 1_000_000,
  rentFrequency: "monthly",
  dueDay: 5,
  depositMinor: 3_000_000,
  depositMonths: "3.00",
  electricityMethod: "submeter",
  ratePerKwh: "4.0000",
  bankName: "玉山銀行",
};

test("the bundled template hash matches the stored official text", () => {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  assert.equal(hash(officialLeaseTemplateText), hash(stored));
  assert.equal(officialLeaseTemplate(), stored);
});

test("an empty lease leaves the official text unchanged", () => {
  const rendered = renderOfficialLease({});
  assert.equal(rendered.text, stored);
  assert.equal(rendered.text, officialLeaseTemplate());
  assert.deepEqual(rendered.patches, []);
  assertOfficial(rendered.text);
  assert.equal(rendered.text.includes("民國__年__月__日經承租人攜回審閱__日"), true);
});

test("filled blanks are the only difference from the stored official text", () => {
  const rendered = renderOfficialLease(filled);
  assert.equal(restore(rendered.text, rendered.patches), stored);
  assert.ok(rendered.patches.length > 0);
  assertOfficial(rendered.text);
  assert.equal(rendered.text.includes("立契約書人承租人張雅文，出租人陳建宏【為■所有權人□轉租人"), true);
  assert.equal(
    rendered.text.includes("1、門牌台北縣(市)信義鄉（鎮、市、區）松仁街(路)__段__巷__弄__88號3樓    (基地坐落"),
    true,
  );
  assert.equal(rendered.text.includes("1、租賃住宅□全部■部分：第3層□房間     間■第A室"), true);
  assert.equal(rendered.text.includes("租賃期間自民國115年1月1日起至民國115年12月31日止。"), true);
  assert.equal(
    rendered.text.includes("承租人每月租金為新臺幣(下同)10,000元整，每期應繳納1個月租金，並於■每月5日□每期"),
    true,
  );
  assert.equal(rendered.text.includes("□現金繳付■轉帳繳付：金融機構：玉山銀行，戶名：     ，帳號：     。"), true);
  assert.equal(rendered.text.includes("戶名：陳建宏"), false);
  assert.equal(rendered.text.includes("88921"), false);
  assert.equal(rendered.text.includes("押金由租賃雙方約定為3個月租金，金額為30000元整(最高不得超過二個月租金之總額)"), true);
  assert.equal(rendered.text.includes("3.00"), false);
  assert.equal(rendered.text.includes("■由承租人負擔"), true);
  assert.equal(rendered.text.includes("■以用電度數計費"), true);
  assert.equal(rendered.text.includes("□每期依電費單之「當期每度平均電價」計收。"), true);
  assert.equal(rendered.text.includes("■每期每度4元。"), true);
  assert.equal(rendered.text.includes("□非以用電度數計費"), true);
  assert.equal(stored.split("□由承租人負擔").length, rendered.text.split("□由承租人負擔").length + 1);
  assert.equal(rendered.text.includes("姓名(名稱)：陳建宏簽章"), true);
  assert.equal(rendered.text.includes("姓名(名稱)：張雅文簽章"), true);
  assert.equal(rendered.text.includes("民國__年__月__日經承租人攜回審閱__日"), true);
  const guarantorAt = stored.indexOf("保證人：\n");
  const guarantor = stored.slice(guarantorAt, stored.indexOf("不動產經紀業："));
  assert.equal(rendered.text.includes(guarantor), true);
});

test("missing data and the other fee choices stay blank", () => {
  const direct = renderOfficialLease({
    electricityMethod: "tenant_direct",
    scope: "whole",
    floor: "2",
    roomLabel: "A",
    startDate: "2026-03-01",
    rentFrequency: "quarterly",
    rentMinor: 2800000,
    addressDisplay: "台北市大安區和平東路二段10號",
  });
  assert.equal(restore(direct.text, direct.patches), stored);
  assert.equal(direct.text.includes("和平東街(路)二段__巷__弄__10號2樓    (基地坐落"), true);
  assert.equal(direct.text.includes("弄10"), false);
  assert.equal(direct.text.includes("2樓之"), false);
  assert.equal(direct.text.includes("■全部□部分：第2層□房間     間□第     室"), true);
  assert.equal(direct.text.includes("至民國     年     月     日止。"), true);
  assert.equal(direct.text.includes("每期應繳納3個月租金"), true);
  assert.equal(direct.text.includes("■非以用電度數計費"), true);
  assert.equal(direct.text.includes("約定計費方式「承租人自行向台灣電力股份有限公司繳納」。"), true);
  assert.equal(direct.text.includes("□以用電度數計費"), true);
  assert.equal(direct.text.includes("□每期每度______元"), true);
  assert.equal(direct.text.includes("□現金繳付□轉帳繳付"), true);
  assert.equal(direct.text.includes("□所有權人□轉租人"), true);

  const average = renderOfficialLease({ electricityMethod: "submeter" });
  assert.equal(restore(average.text, average.patches), stored);
  assert.equal(average.text.includes("■以用電度數計費"), true);
  assert.equal(average.text.includes("■每期依電費單之「當期每度平均電價」計收。"), true);
  assert.equal(average.text.includes("□每期每度______元"), true);

  const unparsed = renderOfficialLease({
    address: { city: "Oakland", district: "", street: "1200 12th St" },
    addressDisplay: "1200 12th St, Oakland, CA 94607",
  });
  assert.equal(restore(unparsed.text, unparsed.patches), stored);
  assert.equal(unparsed.text.includes("1、門牌__縣(市)__鄉（鎮、市、區）__街(路)__段__巷__弄__號__樓之"), true);
});

test("door numbers print as typed and the floor stays in its own cell", () => {
  const at2 = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號之1" },
    floor: "2F",
  });
  assert.equal(restore(at2.text, at2.patches), stored);
  assert.equal(at2.text.includes("弄__88號之1 2樓    (基地坐落"), true);
  assert.equal(at2.text.includes("弄88"), false);
  assert.equal(at2.text.includes("88號之1，"), false);
  assert.equal(at2.text.includes("88號之1號"), false);
  assert.equal(at2.text.includes("弄88之1號"), false);
  assert.equal(at2.text.includes("2樓之"), false);
  assert.equal(at2.text.includes("第2層"), true);

  const at1 = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號之1" },
    floor: "1F",
  });
  assert.equal(restore(at1.text, at1.patches), stored);
  assert.equal(at1.text.includes("弄__88號之1 1樓    (基地坐落"), true);
  assert.equal(at1.text.includes("弄88"), false);
  assert.equal(at1.text.includes("88號之1，"), false);
  assert.equal(at1.text.includes("88號之1號"), false);
  assert.equal(at1.text.includes("弄88之1號"), false);
  assert.equal(at1.text.includes("1樓之"), false);

  const zhiHao = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88之1號" },
    floor: "3F",
  });
  assert.equal(restore(zhiHao.text, zhiHao.patches), stored);
  assert.equal(zhiHao.text.includes("弄__88之1號3樓    (基地坐落"), true);
  assert.equal(zhiHao.text.includes("弄88"), false);
  assert.equal(zhiHao.text.includes("88號之1"), false);
  assert.equal(zhiHao.text.includes("3樓之"), false);
  assert.equal(zhiHao.text.includes("第3層"), true);

  const suffix = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號" },
    floor: "5F之2",
  });
  assert.equal(restore(suffix.text, suffix.patches), stored);
  assert.equal(suffix.text.includes("弄__88號5樓之2(基地坐落"), true);
  assert.equal(suffix.text.includes("弄88"), false);
  assert.equal(suffix.text.includes("88號之2"), false);
  assert.equal(suffix.text.includes("88號號"), false);
  assert.equal(suffix.text.includes("第5層"), true);

  const bare = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88" },
    floor: "5F",
  });
  assert.equal(restore(bare.text, bare.patches), stored);
  assert.equal(bare.text.includes("弄88號5樓    (基地坐落"), true);
  assert.equal(bare.text.includes("弄__88"), false);
  assert.equal(bare.text.includes("88號號"), false);
  assert.equal(bare.text.includes("5樓之"), false);
  assert.equal(bare.text.includes("第5層"), true);

  const alley = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路12弄88號之1" },
    floor: "3F",
  });
  assert.equal(restore(alley.text, alley.patches), stored);
  assert.equal(alley.text.includes("巷12弄__88號之1 3樓    (基地坐落"), true);
  assert.equal(alley.text.includes("弄88"), false);
  assert.equal(alley.text.includes("88號之1號"), false);

  const explicit = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號3樓之2" },
    floor: "3樓",
  });
  assert.equal(restore(explicit.text, explicit.patches), stored);
  assert.equal(explicit.text.includes("弄__88號3樓之2(基地坐落"), true);
  assert.equal(explicit.text.includes("弄88"), false);

  const conflict = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號3樓之2" },
    floor: "4",
  });
  assert.equal(restore(conflict.text, conflict.patches), stored);
  assert.equal(conflict.text.includes("弄__88號4樓    (基地坐落"), true);
  assert.equal(conflict.text.includes("弄88"), false);
  assert.equal(conflict.text.includes("4樓之"), false);
  assert.equal(conflict.text.includes("樓之2"), false);
  assert.equal(conflict.text.includes("第4層"), true);

  const withFloor = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號之1三樓" },
    floor: "3",
  });
  assert.equal(restore(withFloor.text, withFloor.patches), stored);
  assert.equal(withFloor.text.includes("弄__88號之1 3樓    (基地坐落"), true);
  assert.equal(withFloor.text.includes("弄88"), false);
  assert.equal(withFloor.text.includes("88號之1，"), false);
  assert.equal(withFloor.text.includes("88號之1號"), false);
  assert.equal(withFloor.text.includes("弄88之1號"), false);

  const literal = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號之甲" },
    floor: "3",
  });
  assert.equal(restore(literal.text, literal.patches), stored);
  assert.equal(literal.text.includes("弄__88號之甲 3樓    (基地坐落"), true);
  assert.equal(literal.text.includes("弄88"), false);
  assert.equal(literal.text.includes("88號之甲，"), false);
  assert.equal(literal.text.includes("88號之甲號"), false);
  assert.equal(literal.text.includes("弄88之甲號"), false);

  const verbatim = renderOfficialLease({
    address: { city: "台北市", district: "信義區", street: "松仁路88號3樓B1" },
    floor: "3",
  });
  assert.equal(restore(verbatim.text, verbatim.patches), stored);
  assert.equal(verbatim.text.includes("松仁路88號3樓B1街(路)__段__巷__弄__號3樓    (基地坐落"), true);
  assert.equal(verbatim.text.includes("號3樓之"), false);

  const holder = renderOfficialLease({ ...filled, accountHolder: "林秀英" });
  assert.equal(restore(holder.text, holder.patches), stored);
  assert.equal(holder.text.includes("戶名：林秀英，帳號：     。"), true);
  assert.equal(holder.text.includes("戶名：陳建宏"), false);
  assert.equal(holder.text.includes("出租人陳建宏"), true);
});

function blankBetween(text: string, before: string, after: string) {
  const start = text.indexOf(before);
  assert.ok(start >= 0, before);
  const from = start + before.length;
  const end = text.indexOf(after, from);
  assert.ok(end >= 0, after);
  return text.slice(from, end);
}

test("rent and deposit print only a whole number of dollars", () => {
  const whole = renderOfficialLease({ rentMinor: 1_000_000, depositMinor: 3_000_000 });
  assert.equal(restore(whole.text, whole.patches), stored);
  assert.equal(blankBetween(whole.text, "(下同)", "元整"), "10,000");
  assert.equal(blankBetween(whole.text, "金額為", "元整(最高不得超過二個月租金之總額)"), "30000");
  const twelve = renderOfficialLease({ rentMinor: 1_200_000 });
  assert.equal(blankBetween(twelve.text, "(下同)", "元整"), "12,000");

  const cents = renderOfficialLease({ rentMinor: 1_000_050, depositMinor: 250 });
  assert.equal(restore(cents.text, cents.patches), stored);
  assert.equal(blankBetween(cents.text, "(下同)", "元整"), blankBetween(stored, "(下同)", "元整"));
  assert.equal(blankBetween(cents.text, "金額為", "元整(最高不得超過二個月租金之總額)"), blankBetween(stored, "金額為", "元整(最高不得超過二個月租金之總額)"));
  assert.equal(cents.text.includes("10000.5"), false);
  assert.equal(cents.text.includes("2.5"), false);

  const fractional = renderOfficialLease({ rentMinor: 1000.5, depositMinor: 200.25 });
  assert.equal(restore(fractional.text, fractional.patches), stored);
  assert.equal(blankBetween(fractional.text, "(下同)", "元整"), blankBetween(stored, "(下同)", "元整"));
  assert.equal(blankBetween(fractional.text, "金額為", "元整(最高不得超過二個月租金之總額)"), blankBetween(stored, "金額為", "元整(最高不得超過二個月租金之總額)"));
});

test("the lease PDF prints the official form and keeps the deposit reason outside it", () => {
  const source: LeasePdfSource = {
    id: "10000000-0000-4000-8000-000000000099",
    orgId: "10000000-0000-4000-8000-000000000001",
    documentSha256: "ab".repeat(32),
    currency: "TWD",
    rentMinor: filled.rentMinor ?? 0,
    depositMinor: filled.depositMinor ?? 0,
    depositMonths: filled.depositMonths ?? null,
    depositOverrideReason: "屋主同意兩個月以上押金",
    dueDay: 5,
    rentFrequency: "monthly",
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    place: "信義松仁 3F A",
    tenant: "張雅文",
    ownerName: "陳建宏",
    address: filled.address,
    addressDisplay: filled.addressDisplay ?? "",
    floor: "3",
    roomLabel: "A",
    scope: "partial",
    electricityMethod: "submeter",
    ratePerKwh: "4.0000",
    bankName: "玉山銀行",
  };
  const doc = buildLeasePdf(source, makeT("zh-TW"));
  const official = doc.blocks[1];
  assert.ok(official && official.kind === "text");
  const rendered = renderOfficialLease(filled);
  assert.equal(official.lines.join("\n"), rendered.text);
  assert.equal(doc.blocks[0]?.kind === "text" && doc.blocks[0].lines[0], "本文件依內政部住宅租賃契約書範本列印，供紙本簽署，不是電子簽章。");
  assert.equal(official.lines.join("\n").includes("屋主同意兩個月以上押金"), false);
  assert.equal(JSON.stringify(doc.blocks[0]).includes("屋主同意兩個月以上押金"), true);
});
