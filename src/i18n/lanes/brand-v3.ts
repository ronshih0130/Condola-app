import type { Locale } from "../index";

const copy = {
  "zh-TW": {
    m: "管理方", t: "租客", o: "屋主", v: "廠商", account: "{role}：{name}",
    todayTurns: "{name}早，今天輪到你的有 {count} 件。", todayTurnsNoName: "今天輪到你的有 {count} 件。",
    yourTurnGroup: "輪到你・{count} 件", othersTurnGroup: "等別人・{count} 件",
    yourTurnStep: "輪到你・{step}", reReport: "重新回報",
    waitingTenant: "等租客{name}重新回報", turnHolder: "輪到誰",
    awaitingReview: "{count} 筆等你核對",
    confirmedBills: "{month} 月帳單，已確認繳款", source: "查來源",
    billProgress: "應繳 {amount}・已確認 {percent}%・{paid}／{total} 筆",
    billProgressWithoutPercent: "應繳 {amount}・{paid}／{total} 筆",
  },
  en: {
    m: "Manager", t: "Tenant", o: "Owner", v: "Vendor", account: "{role}: {name}",
    todayTurns: "Good morning, {name}. Today, {count} items are your turn.", todayTurnsNoName: "Today, {count} items are your turn.",
    yourTurnGroup: "Your turn・{count} items", othersTurnGroup: "Waiting for others・{count} items",
    yourTurnStep: "Your turn・{step}", reReport: "Report again",
    waitingTenant: "Waiting for tenant{name} to report again", turnHolder: "Whose turn",
    awaitingReview: "{count} reports waiting for your review",
    confirmedBills: "Month {month} bills, payment confirmed", source: "View source",
    billProgress: "Due {amount}・Confirmed {percent}%・{paid}/{total} entries",
    billProgressWithoutPercent: "Due {amount}・{paid}/{total} entries",
  },
};

export function brandV3Copy(locale: Locale) {
  return copy[locale];
}
