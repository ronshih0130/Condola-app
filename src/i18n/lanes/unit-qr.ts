export function unitQrCopy(locale: string) {
  return locale === "zh-TW" ? {
    title: "單元申請連結", generate: "產生申請連結", copy: "複製連結", copied: "已複製", revoke: "撤銷連結",
    hint: "連結有效 30 分鐘，供一位申請人使用。複製連結後交給申請人開啟。",
    signup: "完成電子郵件驗證後，填寫姓名與電話以提交單元申請。申請不會建立租約或開放單元資料。",
    invite: "若已有邀請連結，請開啟原邀請連結完成邀請流程。",
    abandon: "離開此申請", profile: "完成申請資料", name: "姓名", phone: "電話（含國碼，例如 +14155550123）",
    submit: "提交申請", pending: "申請已提交，等待管理方處理。尚未建立租約。",
    required: "請填寫姓名與有效電話。若連結已到期，請向管理方取得新連結。",
  } : {
    title: "Unit application link", generate: "Generate application link", copy: "Copy link", copied: "Copied", revoke: "Revoke link",
    hint: "This link lasts 30 minutes and is for one applicant. Copy it for the applicant to open.",
    signup: "Verify your email, then provide your name and phone to apply. Applying does not create a lease or grant access to unit information.",
    invite: "If you already have an invitation link, open that original link to complete the invitation.",
    abandon: "Leave this application", profile: "Complete your application", name: "Name", phone: "Phone with country code, for example +14155550123",
    submit: "Submit application", pending: "Application submitted for staff review. No lease has been created.",
    required: "Enter your name and a valid phone number. If the link has expired, ask staff for a new link.",
  };
}
