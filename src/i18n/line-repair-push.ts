/** B-038 LINE repair push copy. Summary + LIFF link only; never notes, photos, amounts or scope. */
export type LineRepairKind = "ticket_status" | "approval_requested" | "approval_reminder_24h" | "emergency_owner_notice";
export type LineRepairLocale = "zh-TW" | "en";

const STATUS: Record<LineRepairLocale, Record<string, string>> = {
  "zh-TW": { open: "新進", triaged: "已分類", assigned: "已指派", in_progress: "處理中", on_hold: "暫停",
    resolved: "已完成", closed: "已結案", cancelled: "已取消" },
  en: { open: "New", triaged: "Triaged", assigned: "Assigned", in_progress: "In progress", on_hold: "On hold",
    resolved: "Done", closed: "Closed", cancelled: "Cancelled" },
};

export function lineRepairLocale(value: string | null | undefined): LineRepairLocale {
  return value === "en" ? "en" : "zh-TW";
}

export function lineRepairMessage(locale: LineRepairLocale, input: {
  kind: LineRepairKind; ticketNumber: number; status?: string | null; versionNo?: number | null; link: string;
}): string {
  const n = input.ticketNumber, v = input.versionNo ?? 1, link = input.link;
  const status = (input.status && STATUS[locale][input.status]) || (locale === "en" ? "Updated" : "已更新");
  if (locale === "en") {
    switch (input.kind) {
      case "ticket_status": return `Repair update: request #${n} is now "${status}". Sign in to view details: ${link}`;
      case "approval_requested": return `A repair estimate awaits your decision: request #${n} (estimate version ${v}). Sign in to review and decide: ${link}`;
      case "approval_reminder_24h": return `Reminder: the repair estimate for request #${n} (version ${v}) still awaits your decision. Sign in to review: ${link}`;
      case "emergency_owner_notice": return `Emergency repair notice: request #${n} is being handled under the emergency exception. Sign in to view details: ${link}`;
    }
  }
  switch (input.kind) {
    case "ticket_status": return `修繕進度更新：報修單 #${n} 目前為「${status}」。請登入查看詳情：${link}`;
    case "approval_requested": return `修繕估價待您決定：報修單 #${n}（第 ${v} 版估價）。請登入查看並決定：${link}`;
    case "approval_reminder_24h": return `提醒：報修單 #${n} 的修繕估價（第 ${v} 版）仍待您決定。請登入查看：${link}`;
    case "emergency_owner_notice": return `緊急修繕通知：報修單 #${n} 已依緊急例外安排處理。請登入查看詳情：${link}`;
  }
}
