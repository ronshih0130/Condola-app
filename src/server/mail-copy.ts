/** Email bodies copied from the product copy. Placeholders stay in Chinese. */

import { SERVICE_EMAIL } from "./mail";

export const FOOTER_ADDRESS = "403 台中市西區府後街38號";

const LEASE_ADMIN_SUBJECT = "【租約到期提醒】{物件名稱} {戶別房間} 將於 {到期日} 到期";
const LEASE_ADMIN_BODY = `{管理員姓名} 您好：

以下租約將於 {剩餘天數} 天後到期：

- 物件：{物件名稱} {戶別房間}
- 租客：{租客姓名}
- 屋主：{屋主姓名}
- 租期：{起始日} 至 {到期日}
- 月租：NT\${月租}

建議儘早和租客、屋主確認是否續約，並安排押金退還或點交時間。

[查看租約]({租約連結})

此信由租多啦依租約到期日自動寄出。如不想收到這類提醒，可在「帳號設定」關閉。

租多啦 Condola｜幫你輕鬆管理租屋大小事
403 台中市西區府後街38號｜service@condola.app`;

const LEASE_TENANT_SUBJECT = "您的租約將於 {到期日} 到期";
const LEASE_TENANT_BODY = `{租客姓名} 您好：

您承租的 {物件地址} {戶別房間}，租約將於 {到期日} 到期。

是否續約、退租或點交時間，請直接聯絡 {管理公司名稱}：{管理公司聯絡方式}。

[查看我的租約]({租客租約連結})

此信由租多啦代 {管理公司名稱} 寄出。租多啦是管理公司使用的租賃管理軟體，不經手租金與押金；相關問題請洽 {管理公司名稱}。

403 台中市西區府後街38號`;

const OVERDUE_ADMIN_SUBJECT = "【繳款提醒】{物件名稱} {戶別房間} 本期租金尚未繳清";
const OVERDUE_ADMIN_BODY = `{管理員姓名} 您好：

以下帳單已過繳費日，系統尚未有繳款紀錄：

- 物件：{物件名稱} {戶別房間}
- 租客：{租客姓名}
- 帳單期間：{帳單月份}
- 應繳金額：NT\${應繳金額}
- 繳費日：{繳費日}（已逾期 {逾期天數} 天）

如果租客已經付款，請到「租金總覽」新增繳款紀錄，就不會再提醒。

[查看帳單]({帳單連結})

此信由租多啦依帳單繳費日自動寄出。可在「帳號設定」關閉此類提醒。

租多啦 Condola｜幫你輕鬆管理租屋大小事
403 台中市西區府後街38號｜service@condola.app`;

const OVERDUE_TENANT_SUBJECT = "{帳單月份} 租金繳費提醒";
const OVERDUE_TENANT_BODY = `{租客姓名} 您好：

您 {物件地址} {戶別房間} 的 {帳單月份} 帳單，繳費日為 {繳費日}，目前尚未有繳款紀錄：

- 應繳金額：NT\${應繳金額}

如果您已經付款，請忽略此信，或在租客頁「回報已付款」，方便管理公司核對。
請與管理公司確認繳款：{管理公司名稱}，{管理公司聯絡方式}。

[查看帳單]({租客帳單連結})

此信由租多啦代 {管理公司名稱} 寄出。租多啦是管理公司使用的租賃管理軟體，不經手租金與押金。

403 台中市西區府後街38號`;

const RESET_SUBJECT = "重設您的租多啦密碼";
const RESET_BODY = `您好：

我們收到重設租多啦帳號密碼的申請。請在 60 分鐘內點下方連結設定新密碼：

[設定新密碼]({重設連結})

如果不是您本人申請，請忽略此信，您的密碼不會改變。

租多啦 Condola
403 台中市西區府後街38號｜service@condola.app`;

export type RenderedMail = { subject: string; text: string; html: string };

function apply(template: string, vars: Record<string, string>) {
  const text = template.replace(/\{([^{}]+)\}/g, (match, key: string) => (key in vars ? vars[key] : match));
  if (/\{[^{}]+\}/.test(text)) {
    const missing = text.match(/\{[^{}]+\}/g)?.join(", ");
    throw new Error(`unfilled mail placeholder: ${missing}`);
  }
  return text;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function inline(text: string) {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let html = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    html += escapeHtml(text.slice(last, index));
    html += `<a href="${escapeHtml(match[2])}">${escapeHtml(match[1])}</a>`;
    last = index + match[0].length;
  }
  html += escapeHtml(text.slice(last));
  return html.replaceAll("\n", "<br>");
}

function blockToHtml(block: string) {
  const lines = block.split("\n");
  if (lines.length > 0 && lines.every((line) => line.startsWith("- "))) {
    return `<ul>${lines.map((line) => `<li>${inline(line.slice(2))}</li>`).join("")}</ul>`;
  }
  return `<p>${inline(block)}</p>`;
}

export function renderTemplate(subject: string, body: string, vars: Record<string, string>): RenderedMail {
  const text = apply(body, vars);
  return {
    subject: apply(subject, vars),
    text,
    html: text.split(/\n\n+/).map(blockToHtml).join(""),
  };
}

export function formatMailAmount(minor: number | string) {
  const major = Math.round(Number(minor) / 100);
  return new Intl.NumberFormat("zh-Hant-TW", { maximumFractionDigits: 0 }).format(Math.max(0, major));
}

export function formatMailDate(iso: string) {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${year}年${month}月${day}日`;
}

export function formatMailMonth(iso: string) {
  const [year, month] = iso.slice(0, 10).split("-").map(Number);
  if (!year || !month) return iso;
  return `${year}年${month}月`;
}

export function spaceLabel(unit: string | null | undefined, room: string | null | undefined) {
  return [unit, room].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
}

export function contactMethod(email: string | null | undefined, phone: string | null | undefined) {
  const parts = [(phone ?? "").trim(), (email ?? "").trim()].filter(Boolean);
  return parts.join("，") || SERVICE_EMAIL;
}

export function leaseAdminMail(vars: {
  name: string;
  days: number;
  property: string;
  space: string;
  tenant: string;
  owner: string;
  start: string;
  end: string;
  rent: string;
  url: string;
}) {
  return renderTemplate(LEASE_ADMIN_SUBJECT, LEASE_ADMIN_BODY, {
    管理員姓名: vars.name,
    剩餘天數: String(vars.days),
    物件名稱: vars.property,
    戶別房間: vars.space,
    租客姓名: vars.tenant,
    屋主姓名: vars.owner,
    起始日: vars.start,
    到期日: vars.end,
    月租: vars.rent,
    租約連結: vars.url,
  });
}

export function leaseTenantMail(vars: {
  name: string;
  address: string;
  space: string;
  end: string;
  company: string;
  contact: string;
  url: string;
}) {
  return renderTemplate(LEASE_TENANT_SUBJECT, LEASE_TENANT_BODY, {
    租客姓名: vars.name,
    物件地址: vars.address,
    戶別房間: vars.space,
    到期日: vars.end,
    管理公司名稱: vars.company,
    管理公司聯絡方式: vars.contact,
    租客租約連結: vars.url,
  });
}

export function overdueAdminMail(vars: {
  name: string;
  property: string;
  space: string;
  tenant: string;
  month: string;
  amount: string;
  due: string;
  days: number;
  url: string;
}) {
  return renderTemplate(OVERDUE_ADMIN_SUBJECT, OVERDUE_ADMIN_BODY, {
    管理員姓名: vars.name,
    物件名稱: vars.property,
    戶別房間: vars.space,
    租客姓名: vars.tenant,
    帳單月份: vars.month,
    應繳金額: vars.amount,
    繳費日: vars.due,
    逾期天數: String(vars.days),
    帳單連結: vars.url,
  });
}

export function overdueTenantMail(vars: {
  name: string;
  address: string;
  space: string;
  month: string;
  due: string;
  amount: string;
  company: string;
  contact: string;
  url: string;
}) {
  return renderTemplate(OVERDUE_TENANT_SUBJECT, OVERDUE_TENANT_BODY, {
    租客姓名: vars.name,
    物件地址: vars.address,
    戶別房間: vars.space,
    帳單月份: vars.month,
    繳費日: vars.due,
    應繳金額: vars.amount,
    管理公司名稱: vars.company,
    管理公司聯絡方式: vars.contact,
    租客帳單連結: vars.url,
  });
}

export function passwordResetMail(url: string) {
  return renderTemplate(RESET_SUBJECT, RESET_BODY, { 重設連結: url });
}
