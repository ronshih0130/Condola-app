import { makeT, translate, type Locale } from "./index";

// P52: activation-ux-1110/mockups/{index.html,unified-invite/index.html}.
// Only substitutions of approved names, dates and counts; generic pending/error copy is reused.
const zh = {
  units: "物件與租客", soon: "邀請 {n} 天後失效", invite: "邀請租客", title: "邀請租客・{place}",
  status: "已加入 {n}／4", validity: "有效到 {date}",
  intro: "一個單位只有一個邀請。租客不管是掃 QR、點連結還是拿邀請卡，都會到同一頁，用 LINE 一鍵加入。",
  nearby: "租客就在旁邊？", qr: "出示 QR", away: "租客不在旁邊？",
  share: "用 LINE 傳給租客", copy: "複製連結", copied: "已複製", printCard: "列印邀請卡",
  rules: "可重複使用，最多 4 人加入，{date} 失效。系統不會代你發送。",
  masked: "邀請連結（已遮罩，QR 與邀請卡是同一個）",
  preview: "預覽租客看到的畫面", tenants: "查看已加入的租客", rotate: "作廢並重新產生",
  rotateTitle: "要作廢現在的邀請嗎", rotateBody: "舊的連結和 QR 會失效，已加入的租客不受影響。系統會產生新的一組。",
  rotateConfirm: "作廢並重發", cancel: "先不要", rotated: "已產生新的邀請，舊連結已失效",
  back: "返回邀請面板", backUnit: "返回單位詳情", scan: "請租客用手機相機掃",
  liveHelp: "螢幕調亮一點比較好掃。有人加入時，這裡會馬上顯示。",
  joined: "{name} 剛剛加入（{n}／4）", full: "這個邀請已經滿了（4／4）",
  fullHelp: "要再加人，先在單位詳情移除一位。", done: "完成",
  cardTitle: "{firm} 租客邀請卡", step1: "打開手機相機，掃描上面的 QR",
  step2: "用 LINE 繼續，加入{firm}的服務", step3: "確認基本資料，就能看租約、回報繳租和報修",
  finePrint: "沒有 LINE？用現有帳號登入。有效至 {date}。", print: "列印",
  bound: "已加入的租客（{n}／4）", empty: "還沒有租客加入。",
  line: "LINE 名稱：{name}・{date} 加入", email: "Email 登入・現有帳號・{date}",
  inviteRow: "邀請（QR／連結／邀請卡同一個）", leaseLink: "補上租約並勾選租客（約 3 分鐘）",
  remove: "移除", removeTitle: "要移除這位租客嗎",
  removeBody: "移除後 {name} 就收不到這個單位的通知，也看不到租約；他的登入會立刻失效，並釋放一個名額。要再加入得重新邀請。",
  removed: "已移除這位租客", leaseTitle: "這份租約包含哪些已加入的租客？",
  leaseHelp: "請逐一勾選。沒有勾選的人仍留在單位裡，但看不到租約、繳費、證件、維修和訊息。",
  names: "姓名和 LINE 名稱只是顯示用，不會自動對上租約當事人。",
  save: "確認並存檔", skip: "先略過，稍後再選", noBound: "這個單位還沒有人加入",
  noBoundHelp: "要先有租客用邀請加入，才能把他們勾進租約。",
  message: "你好，我是{firm}。這是{place}的租客邀請，用 LINE 點開就能看租約、回報繳租和報修：{url}（{date}前有效）",
};
const en: Record<keyof typeof zh, string> = {
  units: "Properties and tenants", soon: "Invitation expires in {n} days", invite: "Invite tenants", title: "Invite tenants · {place}", status: "Joined {n}/4", validity: "Valid until {date}",
  intro: "Each unit has one invitation. Whether tenants scan the QR, open the link or use an invitation card, they reach the same page and can join with LINE.",
  nearby: "Is the tenant nearby?", qr: "Show QR", away: "Is the tenant elsewhere?",
  share: "Share with tenant via LINE", copy: "Copy link", copied: "Copied", printCard: "Print invitation card",
  rules: "Reusable for up to 4 people. Expires {date}. The system will not send it for you.",
  masked: "Invitation link (masked; the QR and card use the same invitation)", preview: "Preview what tenants see", tenants: "View joined tenants",
  rotate: "Invalidate and regenerate", rotateTitle: "Invalidate the current invitation?",
  rotateBody: "The old link and QR will stop working. Tenants who have joined are unaffected. The system will generate a new invitation.",
  rotateConfirm: "Invalidate and reissue", cancel: "Not now", rotated: "New invitation generated; the old link is invalid",
  back: "Back to invitation panel", backUnit: "Back to unit details", scan: "Ask the tenant to scan with their phone camera",
  liveHelp: "Brighten the screen for easier scanning. New joins will appear here immediately.", joined: "{name} just joined ({n}/4)",
  full: "This invitation is full (4/4)", fullHelp: "To add someone else, first remove a tenant in unit details.", done: "Done",
  cardTitle: "{firm} tenant invitation card", step1: "Open your phone camera and scan the QR above",
  step2: "Continue with LINE to join {firm}'s service", step3: "Confirm your details to view your lease, report rent payments and request repairs",
  finePrint: "No LINE? Sign in with an existing account. Valid until {date}.", print: "Print",
  bound: "Joined tenants ({n}/4)", empty: "No tenants have joined yet.", line: "LINE name: {name} · Joined {date}", email: "Email login · Existing account · {date}",
  inviteRow: "Invitation (same QR, link and card)", leaseLink: "Add a lease and select tenants (about 3 minutes)",
  remove: "Remove", removeTitle: "Remove this tenant?",
  removeBody: "After removal, {name} will no longer receive this unit's notifications or see its lease. Their login will be invalidated immediately and one seat freed. They will need a new invitation to rejoin.",
  removed: "Tenant removed", leaseTitle: "Which joined tenants belong on this lease?",
  leaseHelp: "Select each person individually. Unselected people remain in the unit but cannot see the lease, payments, identity documents, repairs or messages.",
  names: "Names and LINE names are for display only. They are never automatically matched to lease parties.", save: "Confirm and save", skip: "Skip and select later",
  noBound: "No one has joined this unit yet", noBoundHelp: "Tenants must join through an invitation before you can select them for a lease.",
  message: "Hello, this is {firm}. Here is your tenant invitation for {place}. Open it with LINE to view your lease, report rent payments and request repairs: {url} (valid until {date})",
};
export function staffInviteCopy(locale: Locale) {
  const t = makeT(locale);
  return {
    text: (key: keyof typeof zh, vars?: Record<string, string | number>) => translate(locale === "en" ? en : zh, key, vars),
    error: t("errors.generic"), loading: t("i_portal_working"), saved: t("i_saved"),
    units: locale === "en" ? en.units : zh.units, reload: t("i_repair_reload"),
  };
}
