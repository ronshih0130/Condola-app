import type { Locale } from "../index";

// B-059 / DO-3 單位分派（僅維修人員） (MGT-118-AC1…AC8; GS-24, GS-46). zh-TW is verbatim from the approved frames in
// brand-3.0.html Round 7 (standing pre-approval, DECISIONS 2026-11-16 ~02:0x PT): 「設定・單位分派（經理從設定進來）」
// (title, help line, 「{名字}・維修人員」, 「已分派 {n} 個單位」, outline 「編輯」; its note fixes the empty-state words
// 「還沒有維修人員」＋「先到團隊頁加入維修人員。」＋「新增同事」 and the manager's 「還沒有維修人員，請管理員先加入。」, and
// the no-permission sentence), 「設定・團隊・維修人員那一列多「負責的單位」」 (the 團隊 row link) and
// 「設定・團隊・林志豪負責的單位（公司還沒有單位）」 (h1 「負責的單位・{名字}」 and 「建好單位後，才能分派給{名字}。」; its
// 「還沒有單位」 / 「建立單位」 reuse the approved UNIT strings es_UNIT_title / es_UNIT_action). The edit page's
// 「勾選要分派給{名字}的單位。」 and 「儲存」, and the no-permission pair 「你沒有權限看這頁」＋「單位分派只有管理員和經理能改。」,
// are verbatim from the approved daily-ops mockup (hub 69248d3, `assign-edit`, `assign-perm`). The read and save
// failures and 「再試一次」 reuse the GS-02 lines (AC8). EN is a draft translation. No new zh-TW words.
const copy = {
  "zh-TW": {
    title: "單位分派",
    help: "管理員和經理一樣看得到全部；維修人員只看得到分派給自己的單位工單。單張工單還是可以再指定處理人。",
    person: "{name}・維修人員",
    assigned: "已分派 {n} 個單位",
    edit: "編輯",
    emptyTitle: "還沒有維修人員",
    emptyBody: "先到團隊頁加入維修人員。",
    emptyAdd: "新增同事",
    emptyManager: "還沒有維修人員，請管理員先加入。",
    noPermTitle: "你沒有權限看這頁",
    noPermBody: "單位分派只有管理員和經理能改。",
    editTitle: "負責的單位・{name}",
    editHelp: "勾選要分派給{name}的單位。",
    save: "儲存",
    noUnitsBody: "建好單位後，才能分派給{name}。",
    teamLink: "負責的單位",
    readFailed: "這裡暫時讀不到，請再試一次。",
    saveFailed: "沒有存成功，請再試一次。",
    retry: "再試一次",
  },
  en: {
    title: "Unit assignment",
    help: "Admins and managers still see everything; maintenance staff only see tickets for the units assigned to them. You can still assign a single ticket to someone.",
    person: "{name} · Maintenance",
    assigned: "{n} units assigned",
    edit: "Edit",
    emptyTitle: "No maintenance staff yet",
    emptyBody: "Add maintenance staff on the Team page first.",
    emptyAdd: "Add a colleague",
    emptyManager: "No maintenance staff yet. Ask an admin to add them first.",
    noPermTitle: "You don't have access to this page",
    noPermBody: "Only admins and managers can change unit assignment.",
    editTitle: "Units · {name}",
    editHelp: "Tick the units to assign to {name}.",
    save: "Save",
    noUnitsBody: "Create units first, then you can assign them to {name}.",
    teamLink: "Units",
    readFailed: "We couldn't load this. Please try again.",
    saveFailed: "That didn't save. Please try again.",
    retry: "Try again",
  },
} as const;
export type AssignCopy = { [K in keyof (typeof copy)["zh-TW"]]: string };
export function brandV3AssignCopy(locale: Locale): AssignCopy { return copy[locale]; }
export function fillAssign(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match);
}
