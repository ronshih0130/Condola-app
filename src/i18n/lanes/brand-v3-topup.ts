import type { Locale } from "../index";

// MO-TOPUP (MF-3 / MGT-151-AC1…AC5; 租約 › {租客} › 退租結算). zh-TW is verbatim from the approved frames
// in brand-3.0.html 「第七輪・第二批」 (Ron's standing delegation 2026-11-16, screens.md § "Round 7 batch 2").
// New words (P52, approved with the batch): 記錄已收, 應補…・已補…, 扣款比押金多，租客要補…。, 比應補多收…，確定嗎？
// Save failure and read error are the GS-02 pattern. MO-TOPUP-DUP (Round 7 batch 4, OQ-081, P52 approved by the
// standing delegation): 這筆已經記錄過了，剛剛的修改沒有存。 EN is a translation.
const copy = {
  "zh-TW": {
    title: "退租結算",
    titleWith: "退租結算・{tenant}",
    lead: "扣款比押金多，租客要補 {amount}。",
    card: "結算（三方同一版）",
    deposit: "押金實收",
    deductions: "扣款合計",
    line: "應補 {owed}・已補 {paid}",
    entries: "收到的補款",
    record: "記錄已收",
    amount: "金額（必填）",
    date: "日期（必填）",
    note: "備註（選填）",
    over: "比應補多收 {amount}，確定嗎？",
    confirm: "確定",
    cancel: "取消",
    close: "關閉",
    saveFailed: "沒有存成功，請再試一次。",
    readFailed: "這裡暫時讀不到，請再試一次。",
    retry: "再試一次",
    dup: "這筆已經記錄過了，剛剛的修改沒有存。",
  },
  en: {
    title: "Move-out settlement",
    titleWith: "Move-out settlement · {tenant}",
    lead: "Deductions exceed the deposit. The tenant owes {amount}.",
    card: "Settlement (one version for all three parties)",
    deposit: "Deposit received",
    deductions: "Total deductions",
    line: "Owed {owed} · Paid {paid}",
    entries: "Top-ups received",
    record: "Record received",
    amount: "Amount (required)",
    date: "Date (required)",
    note: "Note (optional)",
    over: "That's {amount} more than owed. Are you sure?",
    confirm: "Confirm",
    cancel: "Cancel",
    close: "Close",
    saveFailed: "Could not save. Please try again.",
    readFailed: "This is temporarily unavailable. Please try again.",
    retry: "Try again",
    dup: "This was already recorded. Your latest changes were not saved.",
  },
};
export type TopupCopy = (typeof copy)["zh-TW"];
export function brandV3TopupCopy(locale: Locale): TopupCopy { return copy[locale]; }
