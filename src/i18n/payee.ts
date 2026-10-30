const strings = {
  en: {
    title: "Payment details",
    company: "Company account",
    owner: "Owner account",
    holder: "Account holder",
    bank: "Bank name",
    bankCode: "Bank code (3 digits)",
    branch: "Branch",
    number: "Account number",
    swift: "SWIFT (optional)",
    routing: "Routing (optional)",
    defaultPayee: "Use as company default (company accounts only)",
    create: "Create account",
    save: "Save",
    lease: "Lease",
    inherit: "Use company default",
    assign: "Assign payee",
    notSet: "Payment details have not been set up yet. Please contact your management company.",
  },
  "zh-TW": {
    title: "匯款資訊",
    company: "公司帳戶",
    owner: "屋主帳戶",
    holder: "戶名",
    bank: "銀行名稱",
    bankCode: "銀行代碼（三碼）",
    branch: "分行",
    number: "帳號",
    swift: "SWIFT（選填）",
    routing: "Routing（選填）",
    defaultPayee: "設為公司預設匯款帳戶（限公司帳戶）",
    create: "新增帳戶",
    save: "儲存",
    lease: "租約",
    inherit: "使用公司預設帳戶",
    assign: "指定匯款帳戶",
    notSet: "匯款資訊尚未設定，請聯絡管理公司",
  },
} as const;

export function payeeStrings(locale: string) {
  return locale === "zh-TW" ? strings["zh-TW"] : strings.en;
}
