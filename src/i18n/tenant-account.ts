export function tenantAccountCopy(locale: string) {
  return locale === "zh-TW" ? {
    title: "帳號與登入裝置", sessions: "目前登入的裝置", current: "目前這個裝置", signedIn: "登入時間", lastActive: "最後使用",
    revoke: "登出此裝置", revoked: "已登出該裝置。", unavailable: "目前無法完成。請重新整理後再試。", none: "沒有其他登入中的裝置。",
  } : {
    title: "Account and signed-in devices", sessions: "Signed-in devices", current: "This device", signedIn: "Signed in", lastActive: "Last used",
    revoke: "Sign out this device", revoked: "That device was signed out.", unavailable: "This is unavailable. Refresh and try again.", none: "No other signed-in devices.",
  };
}
