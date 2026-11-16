import type { Locale } from "../index";

// mgr-history-direct (Round 7 batch 4, B-076a; MGT-76-AC3/AC12), 物件與租客 › {租客} › 改號紀錄.
// zh-TW: 「已直接更換」 and 「{角色} {姓名} 直接修改」 are P52 new words approved with batch 4 (standing delegation);
// 改號紀錄, the four column names, 查看改號紀錄 and 返回租客詳情 are login-phone-1110 copy.md (mgr.history.*,
// mgr.entry.history, mgr.*.back); 尚未填寫 is FE-CHIPS; the header 「改號紀錄・{姓名}」 and 「{姓名} · {單位}。號碼已遮罩。」
// are the batch 4 frame; 「還沒有改號紀錄。」 is the row's empty text. EN is a translation.
const copy = {
  "zh-TW": {
    title: "改號紀錄", titleWith: "改號紀錄・{name}", sub: "{name} · {place}。號碼已遮罩。", subNoPlace: "號碼已遮罩。",
    time: "時間", status: "狀態", actor: "操作者", numbers: "號碼",
    direct: "已直接更換", by: "{role} {name} 直接修改", none: "尚未填寫",
    empty: "還沒有改號紀錄。", back: "返回租客詳情", entry: "查看改號紀錄",
  },
  en: {
    title: "Number change history", titleWith: "Number change history · {name}", sub: "{name} · {place}. Numbers are masked.", subNoPlace: "Numbers are masked.",
    time: "Time", status: "Status", actor: "Changed by", numbers: "Number",
    direct: "Changed directly", by: "{role} {name} changed it directly", none: "Not provided",
    empty: "No number changes yet.", back: "Back to tenant details", entry: "View number change history",
  },
};
export const phoneHistoryCopy = (locale: Locale) => copy[locale];
