import type { Locale } from "../index";

// RO-RULES (owner round, 更多 › 授權規則; OWN-34). zh-TW: the entry name, the two section titles, the three
// renewal options, the note and the save-failure sentence are P52 APPROVED as drafted (Ron 2026-11-15 20:44 PT,
// PENDING-RON PR-023; frame 「更多・授權規則」 approved 2026-11-15 ~13:01 PT). The repair line follows the frame
// (「{物件}・NT${limit} 以下直接修」 + 「修改」). Read errors reuse O-STATES; B1-NOPERM reuses GS-03. EN is a translation.
// OWN-34-AC6 (Round 8, B-113): the no-limit lines and 「設定」 are verbatim from stories.md § Round 8 and the frame
// 「屋主・授權規則：沒設上限時寫清楚用的是多少」 (Ron 「照這樣核准」 2026-11-18): the regional default, NT$0, no regional default.
const copy = {
  "zh-TW": {
    title: "授權規則",
    repairs: "修繕",
    renewal: "續租",
    limit: (property: string, amount: string) => `${property}・${amount} 以下直接修`,
    regional: (property: string, amount: string) => `${property}・你還沒設定，目前用預設：${amount} 以下直接修`,
    zero: (property: string) => `${property}・每一筆都會先問你`,
    unset: (property: string) => `${property}・還沒設定上限，請先設定，廠商才能送估價`,
    edit: "修改",
    set: "設定",
    rules: {
      delegate_notify: "交給管理方，只要通知我",
      delegate_unless_lower: "租金不降就交給管理方，要降價才問我",
      ask_every_time: "每次都問我",
    },
    note: (company: string) => `改了會通知${company}，也會留下紀錄。`,
    saveFailed: "沒有存成功，請再試一次。",
  },
  en: {
    title: "Delegation rules",
    repairs: "Repairs",
    renewal: "Renewals",
    limit: (property: string, amount: string) => `${property} · repair directly up to ${amount}`,
    regional: (property: string, amount: string) => `${property} · Not set yet; using the default: repair directly up to ${amount}`,
    zero: (property: string) => `${property} · You'll be asked about every one`,
    unset: (property: string) => `${property} · No limit yet. Set one so vendors can send estimates`,
    edit: "Edit",
    set: "Set",
    rules: {
      delegate_notify: "Leave it to the manager, just let me know",
      delegate_unless_lower: "Leave it to the manager unless the rent goes down; ask me then",
      ask_every_time: "Ask me every time",
    },
    note: (company: string) => `${company} will be told about any change, and it is kept on record.`,
    saveFailed: "That didn't save. Please try again.",
  },
};
export function brandV3OwnerRulesCopy(locale: Locale) { return copy[locale]; }
