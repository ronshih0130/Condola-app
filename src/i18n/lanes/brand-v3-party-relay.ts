import type { Locale } from "../index";

// GS-59…GS-63 owner/vendor relay amendments (PLT-52-AC6…AC10; screens.md § "Round 7 batch 4, part 4",
// APPROVED, Ron 2026-11-17 ~09:00 PT, verbatim 「A」). New P52 words approved by the standing delegation, verbatim
// from the frames: 「你的決定」, 「費用已送出，等安居物業核對。」, 「這一案等安居物業派工。」 (the company name is the
// slot). 「下一步：開立費用文件。」 is approved too but not used until its primary has a destination (OQ-097).
// 「決定已記錄。」, 「原因」, 「待派工」 and 「處理中」 are already-approved words. EN is a draft translation.
const copy = {
  "zh-TW": {
    yourDecision: "你的決定",
    costSent: "費用已送出，等{company}核對。",
    awaitDispatch: "這一案等{company}派工。",
  },
  en: {
    yourDecision: "Your decision",
    costSent: "Cost sent. Waiting for {company} to check it.",
    awaitDispatch: "Waiting for {company} to dispatch this job.",
  },
} satisfies Record<Locale, unknown>;

export function partyRelayCopy(locale: Locale) {
  return copy[locale] ?? copy["zh-TW"];
}
