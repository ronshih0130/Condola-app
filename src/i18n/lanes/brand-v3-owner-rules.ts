import type { Locale } from "../index";

// RO-RULES (owner round, 更多 › 授權規則; OWN-34). zh-TW: the entry name, the two section titles, the three
// renewal options, the note and the save-failure sentence are P52 APPROVED as drafted (Ron 2026-11-15 20:44 PT,
// PENDING-RON PR-023; frame 「更多・授權規則」 approved 2026-11-15 ~13:01 PT). The repair line follows the frame
// (「{物件}・NT${limit} 以下直接修」 + 「修改」). Read errors reuse O-STATES; B1-NOPERM reuses GS-03. EN is a translation.
const copy = {
  "zh-TW": {
    title: "授權規則",
    repairs: "修繕",
    renewal: "續租",
    limit: (property: string, amount: string) => `${property}・${amount} 以下直接修`,
    edit: "修改",
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
    edit: "Edit",
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
