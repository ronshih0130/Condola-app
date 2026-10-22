import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ID_COMPRESS_AFTER_SECONDS, ID_COMPRESS_JPEG_QUALITY, ID_COMPRESS_LONG_EDGE, idClientCompresses, idCompressLongEdge } from "./id-compress";
import { idUploadShowsWaitNote } from "./id-upload-estimate";
import { ID_PHOTO_LONG_EDGE, MAX_LONG_EDGE } from "./jpeg-size";
import test from "node:test";
import {
  DEFAULT_RETENTION_DAYS,
  GLARE_SHARE,
  SIGNED_URL_TTL_SECONDS,
  isValidIdNumber,
  keepPhrase,
  maskIdNumber,
  nearWhiteShare,
  requiredSlots,
  showsGlare,
  withoutIdentityFields,
} from "./idv";

test("masks an ID as the first character, at least three stars, and the last three", () => {
  assert.equal(maskIdNumber("a123456789"), "A******789");
  assert.equal(maskIdNumber("A000000001"), "A******001");
  assert.equal(maskIdNumber("A000000901"), "A******901");
  assert.equal(maskIdNumber("AB12CD"), "A***CD");
  assert.equal(maskIdNumber("AB12CD7"), "A****D7");
  assert.equal(maskIdNumber("AB12CD78"), "A****D78");
  assert.equal(maskIdNumber("AB12CD789"), "A*****789");
  assert.equal(maskIdNumber("AB12CD7890"), "A******890");
  assert.equal(maskIdNumber("AB12CD78901"), "A*******901");
  assert.equal(maskIdNumber("AB12CD789012"), "A********012");
  assert.equal(maskIdNumber("A123456789").includes("3456"), false);
  for (const value of ["AB12CD", "AB12CD7", "AB12CD78", "AB12CD789", "A123456789", "AB12CD78901", "AB12CD789012"]) {
    const masked = maskIdNumber(value);
    const stars = masked.match(/\*+/)?.[0].length ?? 0;
    assert.ok(stars >= 3, masked);
    assert.equal(masked.includes(value.toUpperCase()), false);
  }
});

test("accepts a Taiwan ID, a new or old ARC, and a passport number", () => {
  assert.equal(isValidIdNumber("tw_national_id", "A123456789"), true);
  assert.equal(isValidIdNumber("tw_national_id", "A123456788"), false);
  assert.equal(isValidIdNumber("tw_national_id", "A000000001"), false);
  assert.equal(isValidIdNumber("arc_resident_cert", "A800000005"), true);
  assert.equal(isValidIdNumber("arc_resident_cert", "AB12345678"), true);
  assert.equal(isValidIdNumber("arc_resident_cert", "A800000006"), false);
  assert.equal(isValidIdNumber("passport", "AB12CD"), true);
  assert.equal(isValidIdNumber("passport", "abc123"), true);
  assert.equal(isValidIdNumber("passport", "ABC12"), false);
});

test("a passport needs the photo page and a selfie; a card needs the back too", () => {
  assert.deepEqual(requiredSlots("passport"), ["front", "selfie"]);
  assert.deepEqual(requiredSlots("tw_national_id"), ["front", "back", "selfie"]);
  assert.deepEqual(requiredSlots("arc_resident_cert"), ["front", "back", "selfie"]);
});

test("retention is stated in days, including the 90-day default", () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 90);
  assert.equal(keepPhrase(DEFAULT_RETENTION_DAYS, "1 年", "90 天"), "90 天");
  assert.equal(keepPhrase(30, "1 年", "30 天"), "30 天");
});

test("glare is a warning threshold, not a hard block", () => {
  assert.equal(nearWhiteShare(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255])), 0.5);
  assert.equal(showsGlare(GLARE_SHARE), true);
  assert.equal(showsGlare(GLARE_SHARE - 0.001), false);
  assert.equal(nearWhiteShare(new Uint8ClampedArray(0)), 0);
});

test("export rows drop identity numbers and photo fields", () => {
  const [row] = withoutIdentityFields([
    {
      name: "信義",
      number_masked: "A******789",
      number_hash: "abc",
      storage_path: "secret",
      ciphertext: "bytes",
      identity_documents: "no",
      id_document_objects: "no",
    },
  ]);
  assert.deepEqual(row, { name: "信義" });
});

test("id check copy never says verified and the consent notice is verbatim", () => {
  for (const locale of ["zh-TW", "en"] as const) {
    const catalog = JSON.parse(readFileSync(new URL(`../i18n/${locale}.json`, import.meta.url), "utf8")) as Record<string, string>;
    const keys = Object.keys(catalog).filter((key) => key.startsWith("idv_"));
    assert.equal(keys.length, 80, locale);
    const copyKeys = Object.keys(catalog).filter((key) => key.startsWith("idv_") || key.startsWith("i_id_"));
    for (const key of copyKeys) {
      assert.equal(catalog[key].includes("已驗證"), false, key);
      assert.equal(catalog[key].includes("房東"), false, key);
      assert.equal(catalog[key].includes("房客"), false, key);
      assert.equal(catalog[key].includes("收款"), false, key);
      assert.equal(catalog[key].includes("示範"), false, key);
      assert.equal(catalog[key].includes("測試模式"), false, key);
      assert.equal(catalog[key].includes("保存 1 年"), false, key);
      assert.equal(/verified/i.test(catalog[key]), false, key);
      assert.equal(catalog[key].includes("LINE"), false, key);
    }
    for (const removed of ["idv_notice", "idv_keep_1y", "idv_ret_hint", "idv_use_sample", "idv_agree", "idv_keep_mgr", "idv_ret_a", "idv_ret_b"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(catalog, removed), false, removed);
    }
    if (locale === "zh-TW") {
      assert.equal(catalog.idv_sent_toast, "核對完成後，請留意管理公司通知");
      assert.equal(catalog.i_id_keep_notice, "照片依告知事項所定期限自動刪除");
      assert.equal(catalog.idv_viewonly, "送出後僅供查看。");
      assert.equal(catalog.i_id_sample, "使用範例照片");
      assert.equal(catalog.i_id_submit_retry, "照片未送出，請再按一次送出");
      assert.equal(catalog.i_pay_settled, "已繳清");
      assert.equal(catalog.i_pay_partial, "部分已繳");
      assert.equal(catalog.i_pay_hint_tenant.includes("入帳"), false);
      assert.equal(catalog.i_pay_hint_tenant.includes("收款"), false);
      assert.equal(
        catalog.i_id_retain,
        "身分證件照片：已生效之租約，於租約結束（期滿或提前終止）後滿90日自動刪除（系統每日執行，最遲次日完成）；租約為草稿、未簽署、取消或作廢者，自上傳日起滿90日自動刪除（系統每日執行，最遲次日完成），不另行通知。",
      );
      assert.equal(catalog.idv_ten_pending.includes("LINE"), false);
      assert.equal(catalog.idv_doc_hint_2, "需要正面與背面各一張。");
      assert.equal(catalog.idv_st_ok, "已核對");
      assert.equal(catalog.idv_btn_ok, "已核對");
      assert.match(catalog.idv_file_hint, /JPG/);
      assert.match(catalog.idv_file_hint, /PNG/);
      assert.match(catalog.idv_file_hint, /800 KB/);
      assert.equal(catalog.idv_processing, "處理中，請稍候");
      assert.equal(catalog.idv_upload_wait, "照片上傳中，約需 {seconds} 秒，請勿關閉頁面");
      assert.equal(catalog.i_nav_inbox, "待確認繳款");
      assert.equal(catalog.i_pay_settled, "已繳清");
      assert.equal(catalog.i_pay_partial, "部分已繳");
    }
  }
});

test("a failed photo view is translated, and a bounced send keeps the selected photos", () => {
  const card = readFileSync(new URL("../components/idv-card.tsx", import.meta.url), "utf8");
  assert.match(card, /errorText\(t, result\.error\)/);
  assert.doesNotMatch(card, /setError\(result\.error\)/);
  const flow = readFileSync(new URL("../components/idv-flow.tsx", import.meta.url), "utf8");
  assert.match(flow, /idv_file_hint/);
  assert.match(flow, /idv_processing/);
  assert.match(flow, /idv_upload_wait/);
  assert.match(flow, /idUploadShowsWaitNote/);
  assert.match(flow, /idClientCompresses/);
  assert.match(flow, /compress: compressPhotos/);
  assert.match(flow, /event\.preventDefault\(\)/);
  assert.match(flow, /disabled=\{busy\}/);
  assert.match(flow, /\/api\/id-documents\/photo/);
  assert.match(flow, /\/api\/id-documents\/finalize/);
  assert.match(flow, /i_id_submit_retry/);
  assert.match(flow, /window\.location\.assign\("\/t\/id\?sent=1"\)/);
  assert.doesNotMatch(flow, /actionFinalizeId/);
  assert.doesNotMatch(flow, /actionSubmitId/);
  assert.match(flow, /name="back"/);
  assert.match(flow, /accept="image\/jpeg,image\/png"/);
  assert.match(flow, /idFileAllowed/);
  assert.match(flow, /i_id_photo_type/);
  assert.match(flow, /i_id_sample/);
  assert.doesNotMatch(flow, /idv_use_sample/);
  assert.doesNotMatch(flow, /idv_keep_1y/);
  assert.doesNotMatch(flow, /retentionDays/);
  assert.match(flow, /idv-missing/);
  assert.doesNotMatch(flow, /setShots\(\(current\) => \(\{ front:/);
  assert.doesNotMatch(flow, /accept="image\/\*"/);
  const actions = readFileSync(new URL("../server/actions.ts", import.meta.url), "utf8");
  const body = actions.slice(actions.indexOf("export async function actionFinalizeId"));
  const fn = body.slice(0, body.indexOf("export async function actionViewIdPhotos"));
  assert.match(fn, /return \{ error:/);
  assert.match(fn, /finalizeTenantId/);
  assert.doesNotMatch(fn, /bounce\(/);
  assert.match(actions, /revalidatePath\(`\/m\/leases\/\$\{leaseId\}`\)/);
});

test("the upload wait note appears only when the estimate is over 10 seconds", () => {
  assert.equal(idUploadShowsWaitNote(10), false);
  assert.equal(idUploadShowsWaitNote(11), true);
  assert.equal(idUploadShowsWaitNote(0), false);
});

test("phone compression stays off until the measured submit time exceeds 20 seconds", () => {
  assert.equal(ID_COMPRESS_AFTER_SECONDS, 20);
  assert.equal(ID_COMPRESS_LONG_EDGE, 2000);
  assert.equal(ID_COMPRESS_JPEG_QUALITY, 0.8);
  assert.equal(ID_PHOTO_LONG_EDGE, 1600);
  assert.equal(MAX_LONG_EDGE, 2000);
  assert.equal(idClientCompresses(0), false);
  assert.equal(idClientCompresses(20), false);
  assert.equal(idClientCompresses(21), true);
  assert.equal(idClientCompresses(), false);
  assert.equal(idCompressLongEdge(), 2000);
  assert.equal(idCompressLongEdge(4000), MAX_LONG_EDGE);
  assert.equal(idCompressLongEdge(1280), 1280);
  const photo = readFileSync(new URL("./id-photo.ts", import.meta.url), "utf8");
  assert.match(photo, /idCompressLongEdge\(\)/);
  assert.match(photo, /ID_PHOTO_LONG_EDGE/);
  assert.match(photo, /ID_COMPRESS_JPEG_QUALITY/);
  const page = readFileSync(new URL("../app/t/id/page.tsx", import.meta.url), "utf8");
  assert.match(page, /demoModeEnabled\(\) && query\.compress === "1"/);
});

test("tenant bill status is settled or partial and does not say collected", () => {
  const page = readFileSync(new URL("../app/t/pay/page.tsx", import.meta.url), "utf8");
  assert.match(page, /i_pay_settled/);
  assert.match(page, /i_pay_partial/);
  assert.match(page, /paidMinor/);
  assert.doesNotMatch(page, /i_pay_confirmed/);
  const dialogs = readFileSync(new URL("../components/dialogs.tsx", import.meta.url), "utf8");
  assert.match(dialogs, /returnTo === "tenant" \? "i_pay_hint_tenant" : "i_pay_hint"/);
  const root = fileURLToPath(new URL("../app/t", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) files.push(path);
    }
  };
  walk(root);
  const banned = ["收款", "收租", "登記收款", "入帳"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const word of banned) assert.equal(source.includes(word), false, `${file} ${word}`);
  }
});

test("the photo modal keeps a fixed frame per slot and reloads with a new link", () => {
  assert.equal(SIGNED_URL_TTL_SECONDS, 60);
  const zh = JSON.parse(readFileSync(new URL("../i18n/zh-TW.json", import.meta.url), "utf8")) as Record<string, string>;
  const en = JSON.parse(readFileSync(new URL("../i18n/en.json", import.meta.url), "utf8")) as Record<string, string>;
  assert.equal(zh.idv_photo_loading, "照片載入中…");
  assert.equal(zh.idv_photo_error, "照片沒有載入成功，請按「重新載入」再試一次");
  assert.equal(zh.idv_photo_retry, "重新載入");
  assert.equal(en.idv_photo_loading, "Loading photo…");
  assert.equal(en.idv_photo_error, "The photo did not load. Press Reload and try again.");
  assert.equal(en.idv_photo_retry, "Reload");
  assert.equal(zh.idv_photo_error.includes("過期"), false);
  const card = readFileSync(new URL("../components/idv-card.tsx", import.meta.url), "utf8");
  assert.match(card, /idv_photo_loading/);
  assert.match(card, /idv_photo_error/);
  assert.match(card, /idv_photo_retry/);
  assert.match(card, /actionViewIdPhotos\(check\.documentId\)/);
  assert.match(card, /url: ""/);
  assert.match(card, /fresh\.url === previous/);
  assert.match(card, /data-testid=\{`idv-photo-\$\{shot\.slot\}`\}/);
  assert.match(card, /data-testid="idv-watermark"/);
  assert.doesNotMatch(card, /連結已過期/);
  assert.doesNotMatch(card, /照片載入中/);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.idv-photo-frame\{[^}]*aspect-ratio:1000\/630/);
  assert.match(css, /\.idv-photo-frame\{[^}]*min-height:240px/);
  const route = readFileSync(new URL("../app/api/id-documents/photo/route.ts", import.meta.url), "utf8");
  const get = route.slice(route.indexOf("export async function GET"));
  assert.match(get, /readSessionOn\(client, \{ touch: false \}\)/);
  assert.match(get, /openSignedPhotoOn\(client, session, token\)/);
  assert.match(get, /private, no-store/);
  assert.doesNotMatch(get, /readSession\(\)/);
  const bytes = readFileSync(new URL("../server/id-bytes.ts", import.meta.url), "utf8");
  assert.match(bytes, /generate_series\(1, octet_length\(ciphertext\), \$3::int\)/);
});
