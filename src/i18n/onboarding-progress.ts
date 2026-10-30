const strings = {
  en: {
    title: "Live onboarding checklist", property: "Property", lease: "Lease", bill: "First bill",
    done: "Complete", incomplete: "In progress", skipped: "Not needed", decision: "Choose which invitation groups are necessary for your company.",
    tenant: "Tenants", owner: "Owners", team: "Team members", required: "Necessary",
    help: "Every current eligible person in each necessary group must accept and bind an account. An empty necessary group is incomplete. Unchecked groups are recorded as not needed.",
    save: "Save invitation choices", counts: "Accounts ready / current targets", drafts: "Draft leases", expired: "Expired invitations", pending: "Pending invitations",
  },
  "zh-TW": {
    title: "正式營運檢查清單", property: "物件", lease: "租約", bill: "首張帳單",
    done: "已完成", incomplete: "進行中", skipped: "不需要", decision: "請選擇公司需要的邀請對象。",
    tenant: "租客", owner: "屋主", team: "團隊成員", required: "需要",
    help: "每個必要群組中所有目前符合條件的對象，都須接受邀請並綁定帳戶。必要群組沒有對象時尚未完成。未勾選的群組會記錄為不需要。",
    save: "儲存邀請選擇", counts: "已可使用的帳戶 / 目前對象", drafts: "草稿租約", expired: "已過期邀請", pending: "待接受邀請",
  },
} as const;
export function onboardingStrings(locale: string) { return locale === "zh-TW" ? strings["zh-TW"] : strings.en; }
