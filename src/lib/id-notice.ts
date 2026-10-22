import { createHash } from "node:crypto";
import { displayedNoticeText } from "./id-notice-display";
import { ID_NOTICE_MARKDOWN } from "./id-notice-markdown";

export { ID_NOTICE_MARKDOWN };

/** Path substituted for 〔完整版連結〕. */
export const ID_NOTICE_PATH = "/t/id/notice";

/** sha256 of id-upload-privacy-notice.md. This is the consent version id. */
export const ID_NOTICE_SHA256 = "7497e7197a549702b3fe8093ec5c6bd949fe35fa23230f0741056366a878af79";

/**
 * Used only when the firm has no stored phone or email and the billing owner
 * profile has none either. This address is already printed in the notice.
 */
export const FIRM_CONTACT_FALLBACK = "service@condola.app";

const FIRM_NAME = "{管理公司名稱}";
const FIRM_CONTACT = "{管理公司聯絡方式}";
const FULL_LINK = "〔完整版連結〕";
const FULL_MARKER = "### 個人資料保護法第8條告知事項暨同意書";
const SHORT_PREFIX = "> 管理公司（";
const CHECKBOX_PREFIX = "> ☐ ";

export type NoticeVars = {
  firmName: string;
  firmContact: string;
  fullNoticeUrl: string;
};

/** Replace the three allowed placeholders and leave every other character alone. */
export function applyNoticePlaceholders(source: string, vars: NoticeVars) {
  return source.split(FIRM_NAME).join(vars.firmName).split(FIRM_CONTACT).join(vars.firmContact).split(FULL_LINK).join(vars.fullNoticeUrl);
}

function rendered(vars: NoticeVars) {
  return applyNoticePlaceholders(ID_NOTICE_MARKDOWN, vars);
}

/** Section A short paragraph, with the leading blockquote marker removed. The URL is still in this string. */
export function shortNotice(vars: NoticeVars) {
  const line = rendered(vars)
    .split("\n")
    .find((item) => item.startsWith(SHORT_PREFIX));
  if (!line?.startsWith("> ")) throw new Error("short notice missing");
  return line.slice(2);
}

/** Upload-page summary. 〔完整版連結〕 is shown as the link label, not the path. */
export function displayedShortNotice(vars: NoticeVars) {
  return displayedNoticeText(shortNotice(vars), vars.fullNoticeUrl);
}

/** Section A checkbox sentence, without the ballot box. */
export function checkboxLabel() {
  const line = ID_NOTICE_MARKDOWN.split("\n").find((item) => item.startsWith("> ☐ 我已閱讀並瞭解上述告知事項"));
  if (!line?.startsWith(CHECKBOX_PREFIX)) throw new Error("checkbox missing");
  return line.slice(CHECKBOX_PREFIX.length);
}

/** Section B from the statutory heading through the end of the file. Markdown included. */
export function fullNotice(vars: NoticeVars) {
  const text = rendered(vars);
  const at = text.indexOf(FULL_MARKER);
  if (at < 0) throw new Error("full notice missing");
  return text.slice(at);
}

export type NoticeInline = { kind: "text" | "strong"; text: string };

export type NoticeListItem = { inlines: NoticeInline[]; children: NoticeListItem[] };

export type NoticeBlock =
  | { kind: "h"; level: 3 | 4; inlines: NoticeInline[] }
  | { kind: "p"; inlines: NoticeInline[] }
  | { kind: "hr" }
  | { kind: "ol" | "ul"; items: NoticeListItem[] };

const HIDDEN_LABELS = ["審閱提示", "A. 上傳畫面簡短版", "B. 完整版"];

/** Bold is `**words**`. A run of asterisks, as in A******789, stays literal text. */
function parseInlines(text: string): NoticeInline[] {
  const items: NoticeInline[] = [];
  let plain = "";
  let index = 0;
  const flush = () => {
    if (!plain) return;
    items.push({ kind: "text", text: plain });
    plain = "";
  };
  while (index < text.length) {
    const marker = text.startsWith("**", index) && text[index + 2] !== "*";
    const close = marker ? text.indexOf("**", index + 2) : -1;
    const inner = close > index ? text.slice(index + 2, close) : "";
    if (marker && close > index && inner.length > 0 && !inner.includes("*") && text[close + 2] !== "*") {
      flush();
      items.push({ kind: "strong", text: inner });
      index = close + 2;
      continue;
    }
    plain += text[index];
    index += 1;
  }
  flush();
  return items;
}

function inlineText(items: NoticeInline[]) {
  return items.map((item) => item.text).join("");
}

/** Headings, paragraphs, lists, and rules from the statutory heading. Section labels stay out. */
export function fullNoticeBlocks(vars: NoticeVars): NoticeBlock[] {
  const lines = fullNotice(vars).replace(/\n$/, "").split("\n");
  const blocks: NoticeBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (HIDDEN_LABELS.some((label) => line.includes(label))) throw new Error("internal notice label");
    if (line === "---") {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }
    if (/^#{1,2} /.test(line)) throw new Error("section label");
    const heading = /^(#{3,4}) (.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length === 3 ? 3 : 4, inlines: parseInlines(heading[2] ?? "") });
      index += 1;
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: NoticeListItem[] = [];
      while (index < lines.length && /^\d+\. /.test(lines[index] ?? "")) {
        const text = (lines[index] ?? "").replace(/^\d+\. /, "");
        index += 1;
        const children: NoticeListItem[] = [];
        while (index < lines.length && /^   - /.test(lines[index] ?? "")) {
          children.push({ inlines: parseInlines((lines[index] ?? "").replace(/^   - /, "")), children: [] });
          index += 1;
        }
        items.push({ inlines: parseInlines(text), children });
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    if (/^- /.test(line)) {
      const items: NoticeListItem[] = [];
      while (index < lines.length && /^- /.test(lines[index] ?? "")) {
        items.push({ inlines: parseInlines((lines[index] ?? "").replace(/^- /, "")), children: [] });
        index += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    blocks.push({ kind: "p", inlines: parseInlines(line) });
    index += 1;
  }
  return blocks;
}

function blockLines(block: NoticeBlock) {
  if (block.kind === "hr") return [];
  if (block.kind === "h" || block.kind === "p") return [inlineText(block.inlines)];
  const lines: string[] = [];
  for (const item of block.items) {
    lines.push(inlineText(item.inlines));
    for (const child of item.children) lines.push(inlineText(child.inlines));
  }
  return lines;
}

/** Visible words from the statutory heading through the end of the file. */
export function fullNoticeText(vars: NoticeVars) {
  return fullNoticeBlocks(vars).flatMap(blockLines).join("\n");
}

function sha256Text(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of the full-text page textContent for this firm. */
export function fullNoticeSha256(vars: NoticeVars) {
  return sha256Text(fullNoticeText(vars));
}

/** sha256 of the upload summary and the checkbox, separated by a newline. */
export function uploadPageSha256(vars: NoticeVars) {
  return sha256Text(`${displayedShortNotice(vars)}\n${checkboxLabel()}`);
}

async function sha256TextSubtle(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

/** Same digest as fullNoticeSha256, via WebCrypto. */
export async function fullNoticeSha256Subtle(vars: NoticeVars) {
  return sha256TextSubtle(fullNoticeText(vars));
}

/** Same digest as uploadPageSha256, via WebCrypto. */
export async function uploadPageSha256Subtle(vars: NoticeVars) {
  return sha256TextSubtle(`${displayedShortNotice(vars)}\n${checkboxLabel()}`);
}

/** Phone and email as they sit after 「聯絡方式：」. Empty when both are blank. */
export function firmContactLine(phone: string | null | undefined, email: string | null | undefined) {
  const parts: string[] = [];
  const phoneText = phone?.trim() ?? "";
  const emailText = email?.trim() ?? "";
  if (phoneText) parts.push(`電話 ${phoneText}`);
  if (emailText) parts.push(`電子郵件 ${emailText}`);
  return parts.join("、");
}

/**
 * Prefer the firm's own phone and email. Otherwise the billing owner's profile.
 * Otherwise service@condola.app.
 */
export function resolveFirmContact(input: {
  orgPhone?: string | null;
  orgEmail?: string | null;
  billingPhone?: string | null;
  billingEmail?: string | null;
}) {
  const org = firmContactLine(input.orgPhone, input.orgEmail);
  if (org) return org;
  const billing = firmContactLine(input.billingPhone, input.billingEmail);
  if (billing) return billing;
  return FIRM_CONTACT_FALLBACK;
}
