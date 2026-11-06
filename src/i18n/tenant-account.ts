export function tenantAccountCopy(locale: string) {
  return locale === "zh-TW" ? {
    profile: "個人資料", displayName: "顯示名稱", phone: "電話（國際格式，例如 +886912345678）", save: "儲存", saved: "個人資料已更新。",
    password: "變更密碼", currentPassword: "目前密碼", newPassword: "新密碼", confirmPassword: "再次輸入新密碼", passwordChanged: "密碼已更新，其他裝置已登出。",
    passwordHint: "請重新輸入目前密碼。新密碼至少 8 個字元，包含英文字母及數字，避免常見密碼。",
    stale: "資料已變更，請重新整理後再試。", locked: "嘗試次數過多，請於 15 分鐘後再試。", invalid: "請檢查輸入的資料或目前密碼。", reauth: "請重新輸入目前密碼。", weak: "新密碼不符合要求。", mismatch: "兩次輸入的新密碼不一致。",
    title: "帳號與登入裝置", sessions: "目前登入的裝置", current: "目前這個裝置", signedIn: "登入時間", lastActive: "最後使用",
    revoke: "登出此裝置", revoked: "已登出該裝置。", unavailable: "目前無法完成。請重新整理後再試。", none: "沒有其他登入中的裝置。",
  } : {
    profile: "Profile", displayName: "Display name", phone: "Phone (international format, e.g. +14155550123)", save: "Save", saved: "Profile updated.",
    password: "Change password", currentPassword: "Current password", newPassword: "New password", confirmPassword: "Confirm new password", passwordChanged: "Password changed. Other devices were signed out.",
    passwordHint: "Re-enter your current password. Use at least 8 characters with letters and numbers, and avoid common passwords.",
    stale: "Your profile changed. Refresh and try again.", locked: "Too many attempts. Try again in 15 minutes.", invalid: "Check your details or current password.", reauth: "Re-enter your current password.", weak: "The new password does not meet the requirements.", mismatch: "The new passwords do not match.",
    title: "Account and signed-in devices", sessions: "Signed-in devices", current: "This device", signedIn: "Signed in", lastActive: "Last used",
    revoke: "Sign out this device", revoked: "That device was signed out.", unavailable: "This is unavailable. Refresh and try again.", none: "No other signed-in devices.",
  };
}
