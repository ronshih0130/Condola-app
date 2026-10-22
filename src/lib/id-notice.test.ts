import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { idFileAllowed, sniffIdImage } from "./jpeg-size";
import { displayedNoticeText, NOTICE_LINK_LABEL } from "./id-notice-display";
import {
  applyNoticePlaceholders,
  checkboxLabel,
  displayedShortNotice,
  FIRM_CONTACT_FALLBACK,
  fullNotice,
  fullNoticeSha256,
  fullNoticeSha256Subtle,
  fullNoticeText,
  ID_NOTICE_MARKDOWN,
  ID_NOTICE_PATH,
  ID_NOTICE_SHA256,
  resolveFirmContact,
  shortNotice,
  uploadPageSha256,
  uploadPageSha256Subtle,
  type NoticeVars,
} from "./id-notice";
import { FullNotice } from "./id-notice-view";

const FILE = readFileSync(new URL("./id-upload-privacy-notice.md", import.meta.url), "utf8");

const VARS: NoticeVars = {
  firmName: "《測試管理公司甲》",
  firmContact: "《測試聯絡乙》",
  fullNoticeUrl: ID_NOTICE_PATH,
};

function substituted(source: string, vars: NoticeVars) {
  return source
    .replaceAll("{管理公司名稱}", vars.firmName)
    .replaceAll("{管理公司聯絡方式}", vars.firmContact)
    .replaceAll("〔完整版連結〕", vars.fullNoticeUrl);
}

test("the embedded notice matches the file, and only the three placeholders change", () => {
  assert.equal(ID_NOTICE_MARKDOWN, FILE);
  assert.equal(createHash("sha256").update(FILE).digest("hex"), ID_NOTICE_SHA256);
  assert.equal(FILE.includes("403 台中市西區府後街38號"), true);
  assert.equal(FILE.includes("台中市西區府後街38號403"), false);
  assert.equal(FILE.includes("台中市西區府後街38號 403"), false);
  assert.equal(FILE.includes("滿90日"), true);
  assert.equal(FILE.includes("依告知事項所定期限"), false);
  assert.equal(FILE.includes("☐ 本人同意上述事項，並同意上傳身分證件照片"), false);
  assert.equal(FILE.split("\n")[12].startsWith("> ☐ 我已閱讀並瞭解上述告知事項"), true);
  const rendered = applyNoticePlaceholders(FILE, VARS);
  assert.equal(rendered, substituted(FILE, VARS));
  const restored = rendered
    .split(VARS.firmName)
    .join("{管理公司名稱}")
    .split(VARS.firmContact)
    .join("{管理公司聯絡方式}")
    .split(VARS.fullNoticeUrl)
    .join("〔完整版連結〕");
  assert.equal(restored, FILE);
  assert.equal(rendered.includes("{管理公司名稱}"), false);
  assert.equal(rendered.includes("{管理公司聯絡方式}"), false);
  assert.equal(rendered.includes("〔完整版連結〕"), false);
  assert.equal(FILE.split("{管理公司名稱}").length - 1, rendered.split(VARS.firmName).length - 1);
  assert.equal(FILE.split("{管理公司聯絡方式}").length - 1, rendered.split(VARS.firmContact).length - 1);
  assert.equal(FILE.split("〔完整版連結〕").length - 1, rendered.split(VARS.fullNoticeUrl).length - 1);
});

test("the short text, checkbox, and full text are exact slices of the substituted file", () => {
  const rendered = substituted(FILE, VARS);
  const shortLine = rendered.split("\n").find((line) => line.startsWith("> 管理公司（"));
  const boxLine = rendered.split("\n").find((line) => line.startsWith("> ☐ 我已閱讀並瞭解上述告知事項"));
  const marker = "### 個人資料保護法第8條告知事項暨同意書";
  assert.ok(shortLine);
  assert.ok(boxLine);
  const fileLines = FILE.split("\n");
  assert.equal(fileLines[8].startsWith("> 管理公司（"), true);
  assert.equal(fileLines[12].startsWith("> ☐ 我已閱讀並瞭解上述告知事項"), true);
  assert.equal(shortNotice(VARS), substituted(fileLines[8], VARS).slice(2));
  assert.equal(checkboxLabel(), fileLines[12].slice("> ☐ ".length));
  assert.equal(shortNotice(VARS), shortLine.slice(2));
  assert.equal(checkboxLabel(), boxLine.slice("> ☐ ".length));
  const shown = displayedShortNotice(VARS);
  assert.equal(shown, displayedNoticeText(shortNotice(VARS), VARS.fullNoticeUrl));
  assert.equal(shown.includes(VARS.fullNoticeUrl), false);
  assert.equal(NOTICE_LINK_LABEL, "完整版");
  assert.equal(shown.endsWith("完整告知事項請見完整版。"), true);
  assert.equal(fullNotice(VARS), rendered.slice(rendered.indexOf(marker)));
  assert.equal(shortNotice(VARS).includes(VARS.firmName), true);
  assert.equal(shortNotice(VARS).includes(VARS.fullNoticeUrl), true);
  assert.equal(shortNotice(VARS).includes("照片加密保存，於租約結束後 90 天自動刪除"), false);
  assert.equal(fullNotice(VARS).includes(VARS.firmName), true);
  assert.equal(fullNotice(VARS).includes(VARS.firmContact), true);
  assert.equal(rendered.includes(shortNotice(VARS)), true);
  assert.equal(rendered.includes(checkboxLabel()), true);
  assert.equal(uploadPageSha256(VARS).length, 64);
  assert.notEqual(fullNoticeSha256({ ...VARS, firmName: "別家" }), fullNoticeSha256(VARS));
  for (const hidden of ["審閱提示", "⚠️", "A. 上傳畫面簡短版", "B. 完整版", "同意勾選框文字"]) {
    assert.equal(shortNotice(VARS).includes(hidden), false, hidden);
    assert.equal(checkboxLabel().includes(hidden), false, hidden);
  }
});

/** Words from file line 19 through the end, with markdown markers removed and placeholders already substituted. */
function visibleNoticeText(source: string) {
  const lines = source.split("\n");
  assert.equal(lines[18], "### 個人資料保護法第8條告知事項暨同意書");
  const body: string[] = [];
  for (const line of lines.slice(18)) {
    if (line.trim() === "" || line.trim() === "---") continue;
    const text = line
      .replace(/^#{1,6} /, "")
      .replace(/^\d+\. /, "")
      .replace(/^   - /, "")
      .replace(/^- /, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1");
    body.push(text);
  }
  return body.join("\n");
}

test("the full-text page equals the file from line 19 through the end", async () => {
  const expected = visibleNoticeText(substituted(FILE, VARS));
  assert.equal(expected.startsWith("個人資料保護法第8條告知事項暨同意書"), true);
  assert.equal(fullNoticeText(VARS), expected);
  assert.equal(fullNoticeSha256(VARS).length, 64);
  assert.equal(await fullNoticeSha256Subtle(VARS), fullNoticeSha256(VARS));
  assert.equal(await uploadPageSha256Subtle(VARS), uploadPageSha256(VARS));
  for (const hidden of ["審閱提示", "⚠️", "A. 上傳畫面簡短版", "B. 完整版", "###", "####", "☐", "---", "本人同意上述事項，並同意上傳身分證件照片"]) {
    assert.equal(expected.includes(hidden), false, hidden);
  }
  assert.equal(expected.includes("**核對您的身分**"), false);
  assert.equal(expected.includes("核對您的身分"), true);
  assert.equal(expected.includes("A******789"), true);
  assert.equal(expected.includes("403 台中市西區府後街38號"), true);
  assert.equal(expected.includes("滿90日"), true);
  assert.equal(expected.includes("依告知事項所定期限"), false);
  assert.equal(expected.includes(VARS.firmName), true);
  assert.equal(expected.includes(VARS.firmContact), true);
  for (const line of substituted(FILE, VARS).split("\n").slice(0, 15)) {
    const words = line.replace(/^>\s*/, "").replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
    if (words.length < 8 || words === "---") continue;
    assert.equal(expected.includes(words), false, words.slice(0, 24));
  }
  const html = renderToStaticMarkup(createElement(FullNotice, { vars: VARS }));
  assert.equal(html.includes("<pre"), false);
  assert.equal(html.includes("<h3>個人資料保護法第8條告知事項暨同意書</h3>"), true);
  assert.equal(html.includes("<h4>"), true);
  assert.equal(html.includes("<strong>"), true);
  assert.equal(html.includes("<hr"), true);
  assert.equal(html.includes("<ol>"), true);
  assert.equal(html.includes("<ul>"), true);
  assert.equal(html.replace(/<[^>]+>/g, ""), expected);
});

test("firm contact uses the stored phone and email, then the billing owner, then the published address", () => {
  assert.equal(resolveFirmContact({ orgPhone: "+886912345678", orgEmail: "a@b.c" }), "電話 +886912345678、電子郵件 a@b.c");
  assert.equal(resolveFirmContact({ orgEmail: "a@b.c" }), "電子郵件 a@b.c");
  assert.equal(resolveFirmContact({ orgPhone: "+886912345678" }), "電話 +886912345678");
  assert.equal(
    resolveFirmContact({ billingPhone: "+886900000000", billingEmail: "owner@firm.test" }),
    "電話 +886900000000、電子郵件 owner@firm.test",
  );
  assert.equal(resolveFirmContact({}), FIRM_CONTACT_FALLBACK);
  assert.equal(FIRM_CONTACT_FALLBACK, "service@condola.app");
});

test("a GIF is rejected from its magic bytes even when the label says JPEG", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  assert.equal(sniffIdImage(gif), null);
  assert.equal(sniffIdImage(png), "png");
  assert.equal(idFileAllowed("image/gif", gif), false);
  assert.equal(idFileAllowed("image/jpeg", gif), false);
  assert.equal(idFileAllowed("image/png", png), true);
  assert.equal(idFileAllowed("image/jpeg", png), false);
  assert.equal(idFileAllowed("image/heic", Buffer.from("not-a-photo")), false);
});
