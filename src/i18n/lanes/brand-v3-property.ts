import type { Locale } from "../index";
// R2-PROP, MGT-82, MGT-127-AC4 and Round 2 chosen strings.
const copy = {
  "zh-TW": {
    title:"物件",lead:"{name}：{n} 間房，還有 {k} 件待補。",leadPartial:"{name}：{n} 間房。",
    occupancy:"出租 {occupied}／{rooms} 間",room:"房號",type:"房型",status:"狀態",pending:"待補",
    invite:"邀請",settings:"物件設定",money:"金流設定",fees:"固定月費",advanced:"進階設定",address:"地址與樓層",
    override:"覆寫部分設定",inherit:"全部恢復沿用屋主",bulkInvite:"一次邀請全部房間",
    permission:"請管理者完成設定。",failed:"資料載入失敗",retry:"再試一次",loading:"載入中",
    whole:"整戶",unspecified:"未設定",vacant:"招租中",draft:"租約草稿",pending_signature:"待簽約",active:"出租中",
    suite:"套房",shared_bath:"雅房",studio:"獨立套房",other:"其他",whole_home:"整戶",
    done:"都處理好了",details:"檢視各項完成狀態",unknown:"待確認",complete:"已完成",
    incomplete:"部分待補狀態尚待確認，待補總數暫不顯示。",
    tasks:{roomType:"補房型",tenant:"找租客",address:"補地址／樓層",owner:"補屋主",money:"金流設定",lease:"補租約"},
  },
  en: {
    title:"Property",lead:"{name}: {n} rooms, {k} items left to complete.",leadPartial:"{name}: {n} rooms.",
    occupancy:"Occupied {occupied}/{rooms} rooms",room:"Room",type:"Room type",status:"Status",pending:"To complete",
    invite:"Invite",settings:"Property settings",money:"Money settings",fees:"Monthly fees",advanced:"Advanced settings",address:"Address and floor",
    override:"Override selected settings",inherit:"Restore all owner settings",bulkInvite:"Invite all rooms",
    permission:"Ask an administrator to complete setup.",failed:"Could not load data",retry:"Try again",loading:"Loading",
    whole:"Whole home",unspecified:"Not set",vacant:"Available",draft:"Draft lease",pending_signature:"Awaiting signature",active:"Occupied",
    suite:"En suite",shared_bath:"Shared bathroom",studio:"Studio",other:"Other",whole_home:"Whole home",
    done:"All done",details:"View completion status",unknown:"To confirm",complete:"Complete",
    incomplete:"Some completion statuses still need confirmation; the total is not shown yet.",
    tasks:{roomType:"Set room type",tenant:"Find a tenant",address:"Add address / floor",owner:"Add owner",money:"Money settings",lease:"Add lease"},
  },
};
export const propertyCopy=(locale:Locale)=>copy[locale];
