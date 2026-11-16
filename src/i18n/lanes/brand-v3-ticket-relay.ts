import type { Locale } from "../index";

// TK-RELAY / TK-RELAY-MNT (MGT-150, screens.md § "Round 7 batch 2", APPROVED by Ron's standing delegation
// 2026-11-16 ~02:25 PT). zh-TW is verbatim from the approved frames:
// - step labels are the B6 words (MGT-150-AC1) plus 「租客回報」 from the approved relay frames;
// - why-lines and the R5 lead are the batch's "new words" (ticket why-lines, ticket lead);
// - 「你」, 「退回」, 「管理方」, 「狀態：」 and 「報修進度」 are already-approved frame words.
// EN is a draft translation.
const copy = {
  "zh-TW": {
    steps: {
      report: "租客回報",
      dispatch: "派工",
      approve_estimate: "核准估價",
      re_estimate: "重新估價",
      do_repair: "到場維修",
      report_cost: "回報費用",
      confirm_cost: "核對費用",
    },
    you: "你",
    sentBack: "退回",
    progress: "報修進度",
    progressNow: "報修進度，現在輪到{who}{step}",
    title: "{place}・{item}",
    crumbSep: "›",
    statusLine: "狀態：{status}",
    reEstimateLead: "屋主{name}退回了估價，輪到你重新估價。",
    why: {
      cost_pending: "廠商已回報費用，等估價定案後才能核對。",
      resolved_owner: "已標成已解決，但還在等屋主核准估價。",
      resolved_vendor: "已標成已解決，但還在等廠商回報費用。",
      emergency_open: "已緊急處理，屋主還可以核准估價。",
      emergency_back: "已緊急處理；屋主退回了估價，之後要重新估價。",
    },
  },
  en: {
    steps: {
      report: "Reported",
      dispatch: "Dispatch",
      approve_estimate: "Approve",
      re_estimate: "Re-estimate",
      do_repair: "Repair",
      report_cost: "Report cost",
      confirm_cost: "Check cost",
    },
    you: "You",
    sentBack: "Sent back",
    progress: "Repair progress",
    progressNow: "Repair progress, now {who}: {step}",
    title: "{place} · {item}",
    crumbSep: "›",
    statusLine: "Status: {status}",
    reEstimateLead: "Owner {name} sent the estimate back. It's your turn to re-estimate.",
    why: {
      cost_pending: "The vendor reported a cost. It can be checked once the estimate is settled.",
      resolved_owner: "Marked resolved, but still waiting for the owner to approve the estimate.",
      resolved_vendor: "Marked resolved, but still waiting for the vendor to report the cost.",
      emergency_open: "Handled as an emergency. The owner can still approve the estimate.",
      emergency_back: "Handled as an emergency; the owner sent the estimate back, so it needs a new estimate.",
    },
  },
};
export type TicketRelayCopy = (typeof copy)["zh-TW"];
export function ticketRelayCopy(locale: Locale): TicketRelayCopy { return copy[locale]; }
