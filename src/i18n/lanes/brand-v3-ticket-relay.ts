import type { Locale } from "../index";

// TK-RELAY / TK-RELAY-MNT (MGT-150, screens.md § "Round 7 batch 2", APPROVED by Ron's standing delegation
// 2026-11-16 ~02:25 PT) and TK-RELAY-END / TK-RELAY-BLOCKED / TK-WHY-RULE / TK-RELAY-MOREINFO /
// TK-RELAY-MNT-STATES (§ "Round 7 batch 4", APPROVED by the same delegation 2026-11-16 ~11:20 PT).
// zh-TW is verbatim from the approved frames and each batch's new-word list:
// - step labels are the B6 words (MGT-150-AC1, incl. 處理中) plus 「租客回報」 from the approved relay frames;
// - batch 2: the four why-lines and the 退回 lead; batch 4: blocked lines and lead, the resolved slots
//   (廠商到場維修／管理方核對費用／管理方重新派工) and 「還要…」, 「補資料」 and its lead, end pills
//   「已結案」/「已取消」 (「已解決」 already approved), maintenance status 「暫停」;
// - 「你」, 「退回」, 「管理方」, 「狀態：」, 「報修進度」, 待派工, 已派工 and 處理中 are already-approved words.
// The vendor-declined line with a reason (「廠商沒有接這一件：「{原因}」。」) is not here: no readable
// projection carries the reason, so the approved no-reason form is used. EN is a draft translation.
const copy = {
  "zh-TW": {
    steps: {
      report: "租客回報",
      dispatch: "派工",
      in_progress: "處理中",
      approve_estimate: "核准估價",
      re_estimate: "重新估價",
      do_repair: "到場維修",
      report_cost: "回報費用",
      confirm_cost: "核對費用",
    },
    you: "你",
    sentBack: "退回",
    moreInfo: "補資料",
    progress: "報修進度",
    progressNow: "報修進度，現在輪到{who}{step}",
    title: "{place}・{item}",
    crumbSep: "›",
    statusLine: "狀態：{status}",
    lead: {
      re_estimate: "屋主{name}退回了估價，輪到你重新估價。",
      more_info: "屋主{name}要求補充資料，輪到你重新估價。",
      declined: "廠商{name}沒有接，輪到你重新派工。",
    },
    end: { resolved: "已解決", closed: "已結案", cancelled: "已取消" },
    mntStatus: {
      awaiting_dispatch: "待派工", dispatched: "已派工", in_progress: "處理中", on_hold: "暫停",
      resolved: "已解決", closed: "已結案", cancelled: "已取消",
    },
    why: {
      blocked_declined: "廠商沒有接這一件。",
      blocked_link: "廠商的連結已失效，要重新分享或重新派工。",
      emergency_open: "已緊急處理，屋主還可以核准估價。",
      emergency_back: "已緊急處理；屋主退回了估價，之後要重新估價。",
      resolved_owner: "已標成已解決，但還在等屋主核准估價。",
      resolved_vendor: "已標成已解決，但還在等廠商回報費用。",
      resolved_vendor_repair: "已標成已解決，但還在等廠商到場維修。",
      resolved_manager_cost: "已標成已解決，但還在等管理方核對費用。",
      resolved_manager_redispatch: "已標成已解決，但還在等管理方重新派工。",
      resolved_need_cost: "已標成已解決，但還要核對費用。",
      resolved_need_redispatch: "已標成已解決，但還要重新派工。",
      cost_pending: "廠商已回報費用，等估價定案後才能核對。",
    },
  },
  en: {
    steps: {
      report: "Reported",
      dispatch: "Dispatch",
      in_progress: "In progress",
      approve_estimate: "Approve",
      re_estimate: "Re-estimate",
      do_repair: "Repair",
      report_cost: "Report cost",
      confirm_cost: "Check cost",
    },
    you: "You",
    sentBack: "Sent back",
    moreInfo: "More info",
    progress: "Repair progress",
    progressNow: "Repair progress, now {who}: {step}",
    title: "{place} · {item}",
    crumbSep: "›",
    statusLine: "Status: {status}",
    lead: {
      re_estimate: "Owner {name} sent the estimate back. It's your turn to re-estimate.",
      more_info: "Owner {name} asked for more information. It's your turn to re-estimate.",
      declined: "Vendor {name} declined. It's your turn to dispatch again.",
    },
    end: { resolved: "Resolved", closed: "Closed", cancelled: "Cancelled" },
    mntStatus: {
      awaiting_dispatch: "Awaiting dispatch", dispatched: "Dispatched", in_progress: "In progress", on_hold: "On hold",
      resolved: "Resolved", closed: "Closed", cancelled: "Cancelled",
    },
    why: {
      blocked_declined: "The vendor declined this job.",
      blocked_link: "The vendor's link no longer works. Share it again or dispatch again.",
      emergency_open: "Handled as an emergency. The owner can still approve the estimate.",
      emergency_back: "Handled as an emergency; the owner sent the estimate back, so it needs a new estimate.",
      resolved_owner: "Marked resolved, but still waiting for the owner to approve the estimate.",
      resolved_vendor: "Marked resolved, but still waiting for the vendor to report the cost.",
      resolved_vendor_repair: "Marked resolved, but still waiting for the vendor to do the repair.",
      resolved_manager_cost: "Marked resolved, but still waiting for the manager to check the cost.",
      resolved_manager_redispatch: "Marked resolved, but still waiting for the manager to dispatch again.",
      resolved_need_cost: "Marked resolved, but the cost still needs checking.",
      resolved_need_redispatch: "Marked resolved, but it still needs dispatching again.",
      cost_pending: "The vendor reported a cost. It can be checked once the estimate is settled.",
    },
  },
};
export type TicketRelayCopy = (typeof copy)["zh-TW"];
export function ticketRelayCopy(locale: Locale): TicketRelayCopy { return copy[locale]; }
