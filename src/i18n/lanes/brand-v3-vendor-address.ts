import type { Locale } from "../index";

// B-112 ven-addr-confirm (Round 7 batch 4, P52 new words approved by the standing delegation 2026-11-16 ~11:20 PT);
// the 地址 field and its help are the approved vendor-frontend-1112 ven-account words; errors are R2-ADDR's.
const copy = {
  "zh-TW": {
    card: "固定資料", field: "地址", help: "一行輸入，系統解析後再請你確認。", save: "儲存",
    title: "確認地址", lead: "系統這樣拆你的地址，對嗎？不對可以直接改。",
    city: "縣市", district: "鄉鎮市區", street: "街道", number: "門牌", cancel: "取消",
    unreadable: "系統讀不出這個地址，請分開填。",
    fix: "還有欄位要修正。", needCity: "請選擇縣市。", needStreet: "街道與門牌請至少填一項。",
    saveError: "沒有存成功，請再試一次。", retry: "再試一次",
  },
  en: {
    card: "Fixed details", field: "Address", help: "Type it on one line; the system splits it and asks you to confirm.", save: "Save",
    title: "Confirm address", lead: "Is this how your address should be split? You can edit it directly.",
    city: "City / county", district: "District / township", street: "Street", number: "Number", cancel: "Cancel",
    unreadable: "The system couldn't read this address. Please fill in each part.",
    fix: "Some fields still need fixing.", needCity: "Please choose a city or county.", needStreet: "Fill in at least the street or the number.",
    saveError: "This wasn't saved. Please try again.", retry: "Try again",
  },
} as const;
export type VendorAddressCopy = (typeof copy)["zh-TW"] | (typeof copy)["en"];
export function vendorAddressCopy(locale: Locale): VendorAddressCopy { return copy[locale]; }
